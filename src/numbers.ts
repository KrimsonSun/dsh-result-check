/**
 * Numbers in a final answer that no tool output, tool argument or user message
 * of the session contains.
 *
 * Ported from AiScientist's step-number check. The rule there: a number is a
 * claim only when the text clearly states it as a measured value, and a claim
 * is flagged only when nothing the session saw could have produced it.
 * Anything it cannot read with confidence it ignores — a missed claim costs
 * what it cost before this check existed; a false flag costs the user an extra
 * step. So the reader below skips code, paths, versions, dates, section
 * numbers, approximations, small integers and round figures.
 */

/** One number the answer states as a value. */
export interface NumberClaim {
  /** The text as written, e.g. `1,708`, `0.873`, `12.5%`. */
  readonly raw: string
  /** Absolute value as written (percent kept as the percent figure, e.g. 12.5). */
  readonly value: number
  /** Half the width of the interval the written precision covers (0.5 for `1708`, 0.0005 for `0.873`). */
  readonly halfWidth: number
  readonly percent: boolean
}

export interface ClaimOptions {
  /** Plain integers with fewer digits than this are not claims (default 3: 100 and up). */
  readonly minIntegerDigits: number
}

export const DEFAULT_CLAIM_OPTIONS: ClaimOptions = { minIntegerDigits: 3 }

// --- remove text whose numbers are not stated values -------------------------------------------

const FENCED = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm
const INLINE_CODE = /`[^`\n]*`/g
const URL = /\b(?:https?|ftp|file):\/\/\S+/gi
const LINK_TARGET = /\]\([^)\s]*\)/g
const DATE_TIME = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g
const TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g
const VERSION = /\bv?\d+(?:\.\d+){2,}(?:[-+][\w.]+)?\b/gi
// path/with/segments, ./rel, ../rel, ~/x, file.ext:12:3
const PATH = /(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+(?::\d+(?::\d+)?)?|[\w.-]+\.[A-Za-z]\w{0,9}:\d+(?::\d+)?/g
const ISSUE_REF = /#\d+\b/g

function blank(match: string): string {
  // Keep length and newlines so line starts stay line starts.
  return match.replace(/[^\n]/g, ' ')
}

/** The answer with every region whose numbers are not stated values blanked out. */
export function claimableText(answer: string): string {
  return answer
    .replace(FENCED, blank)
    .replace(INLINE_CODE, blank)
    .replace(URL, blank)
    .replace(LINK_TARGET, blank)
    .replace(DATE_TIME, blank)
    .replace(TIME, blank)
    .replace(VERSION, blank)
    .replace(PATH, blank)
    .replace(ISSUE_REF, blank)
}

// --- read the claims ----------------------------------------------------------------------------

// An ASCII letter, digit or underscore before the number makes it part of an
// identifier (H100, x86, run_42). CJK text before it does not ("共1708个").
// A unit of up to three letters after it is allowed ("1530ms", "3GB", "2x").
const NUMBER = /(?<![A-Za-z0-9_.,\\])[-−+]?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?(\s?[%％‰])?(?![.,]?\d)(?![A-Za-z]{4,})(?![A-Za-z]{1,3}[0-9_])/g

// A word right before the number that says it is not an exact measured value.
const HEDGE_BEFORE = /(?:~|≈|∼|<|>|≤|≥|\b(?:about|around|roughly|approximately|approx\.?|nearly|almost|over|under|more than|less than|fewer than|at least|at most|up to|above|below)|约|大约|大概|将近|接近|近|超过|不到|不足|至少|最多|多达|上千|上万)\s*$/i
// ...or right after it.
const HEDGE_AFTER = /^\s*(?:多|余|左右|上下|以上|以下|开外|\+|or so\b|or more\b|or less\b|-ish\b)/i
// A label that makes the number a reference, not a value: "Section 3.2", "step 12", "PR 150".
const REFERENCE_BEFORE = /(?:\b(?:section|sec\.|step|figure|fig\.|table|chapter|appendix|line|lines|page|pp?\.|issue|pr|pull request|commit|version|ver\.|release|python|node|java|go|rust|ubuntu|macos|ios|android|cuda|port|pid|id|no\.|number)|§|#|第)\s*$/i
// Numbering at the start of a line: "1. ", "2.1 Results", "## 3.4 Methods".
const LINE_NUMBERING = /^\s*(?:#{1,6}\s*|[-*+]\s+)?$/

function isRound(value: number, percent: boolean, decimals: number): boolean {
  if (decimals > 0) return false
  if (percent) return value % 10 === 0
  return value % 100 === 0
}

function isYear(intText: string, decimals: number, percent: boolean): boolean {
  if (decimals > 0 || percent || intText.includes(',')) return false
  const n = Number(intText)
  return intText.length === 4 && n >= 1900 && n <= 2100
}

/** The numbers `answer` states as values, in order, de-duplicated by how they are written. */
export function extractClaims(answer: string, options: ClaimOptions = DEFAULT_CLAIM_OPTIONS): NumberClaim[] {
  const text = claimableText(answer)
  const claims: NumberClaim[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(NUMBER)) {
    const start = match.index
    const raw = match[0].trim()
    const intText = match[1]!
    const fraction = match[2] ?? ''
    const exponent = match[3] === undefined ? 0 : Number(match[3])
    const percent = match[4] !== undefined
    const decimals = fraction.length

    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const before = text.slice(Math.max(lineStart, start - 24), start)
    const after = text.slice(start + match[0].length, start + match[0].length + 12)
    if (LINE_NUMBERING.test(text.slice(lineStart, start)) && /^\d+\.(?:\s|\d)|^\d+\)\s/.test(text.slice(start))) continue
    if (HEDGE_BEFORE.test(before) || HEDGE_AFTER.test(after)) continue
    if (REFERENCE_BEFORE.test(before)) continue

    const digits = intText.replaceAll(',', '')
    const value = Math.abs(Number(`${digits}${fraction ? `.${fraction}` : ''}`) * 10 ** exponent)
    if (!Number.isFinite(value)) continue
    if (decimals === 0 && exponent === 0 && !percent && digits.replace(/^0+(?=\d)/, '').length < options.minIntegerDigits) continue
    if (percent && decimals === 0 && value < 10) continue
    if (isYear(intText, decimals, percent) || isRound(value, percent, decimals)) continue

    const key = `${value}|${decimals}|${exponent}|${percent}`
    if (seen.has(key)) continue
    seen.add(key)
    claims.push({ raw, value, halfWidth: 0.5 * 10 ** (exponent - decimals), percent })
  }
  return claims
}

// --- what the session has seen ------------------------------------------------------------------

// Permissive on purpose: an extra source number can only stop a flag, never raise one.
const SOURCE_NUMBER = /\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g
const SOURCE_GROUPED = /\d{1,3}(?:,\d{3})+(?:\.\d+)?/g

/** Every number in `text`, read loosely (inside identifiers, JSON, tables, either comma reading). */
export function extractSourceNumbers(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(SOURCE_NUMBER)) {
    const n = Number(m[0])
    if (Number.isFinite(n)) out.push(n)
  }
  for (const m of text.matchAll(SOURCE_GROUPED)) {
    const n = Number(m[0].replaceAll(',', ''))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/** The numbers a session's tool outputs, tool arguments and user messages contain, searchable by interval. */
export class NumberIndex {
  private pending: number[] = []
  private sorted = new Float64Array(0)

  /** Add every number in `text`. */
  add(text: string): void {
    for (const n of extractSourceNumbers(text)) this.pending.push(Math.abs(n))
  }

  get size(): number {
    this.flush()
    return this.sorted.length
  }

  /** Is there a number in [value - halfWidth, value + halfWidth]? */
  covers(value: number, halfWidth: number): boolean {
    this.flush()
    const slack = 1e-9 * Math.max(1, value)
    const lo = value - halfWidth - slack
    const hi = value + halfWidth + slack
    let left = 0
    let right = this.sorted.length
    while (left < right) {
      const mid = (left + right) >>> 1
      if (this.sorted[mid]! < lo) left = mid + 1
      else right = mid
    }
    return left < this.sorted.length && this.sorted[left]! <= hi
  }

  private flush(): void {
    if (this.pending.length === 0) return
    const merged = new Float64Array(this.sorted.length + this.pending.length)
    merged.set(this.sorted)
    merged.set(this.pending, this.sorted.length)
    merged.sort()
    this.sorted = merged
    this.pending = []
  }
}

/** Is `claim` what some source number reads as at the precision the claim is written to? */
export function isSourced(claim: NumberClaim, index: NumberIndex): boolean {
  const { value, halfWidth, percent } = claim
  if (index.covers(value, halfWidth)) return true
  // 12.5% may be 0.125 in the tool output; 0.125 may be 12.5% there.
  if (percent && index.covers(value / 100, halfWidth / 100)) return true
  if (!percent && value <= 1 && index.covers(value * 100, halfWidth * 100)) return true
  return false
}

/** The claims in `answer` that no source number accounts for. */
export function unsourcedClaims(answer: string, index: NumberIndex, options: ClaimOptions = DEFAULT_CLAIM_OPTIONS): NumberClaim[] {
  return extractClaims(answer, options).filter(claim => !isSourced(claim, index))
}
