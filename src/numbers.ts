/**
 * Numbers in a final answer that no tool output, tool argument or user message
 * of the session contains.
 *
 * Ported from AiScientist's step-number check. The rule there: a number is a
 * claim only when the text clearly states it as a measured value, and a claim
 * is flagged only when nothing the session saw could have produced it.
 * Anything it cannot read with confidence it ignores — a missed claim costs
 * what it cost before this check existed; a false flag costs the user an extra
 * step. So the reader below skips code, paths, line references, versions,
 * dates, identifiers, section numbers, approximations, small integers and
 * round figures, and it accepts a number the session's numbers give after a
 * change of unit, or that the answer's own numbers give: one arithmetic step,
 * a table column's total or share, or working the answer writes out.
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
  /** The unit written right after the number, when it is one the check converts (`GB`, `ms`, `万`, …). */
  readonly unit?: string
  /** Where the number starts in the answer. */
  readonly at?: number
}

export interface ClaimOptions {
  /** Plain integers with fewer digits than this are not claims (default 3: 100 and up). */
  readonly minIntegerDigits: number
  /** Accept a claim the answer's other numbers give: one step, a table total or share, written-out working (default true). */
  readonly allowDerived: boolean
  /** Where those two numbers may come from: the claim's paragraph (default) or anywhere in the answer. */
  readonly derivedScope: DerivedScope
}

/**
 * `paragraph`: the lines up to the nearest blank line on each side (a table
 * is one paragraph). `answer`: the whole answer — quieter, but with many
 * numbers in play a wrong one matches some combination by chance more often.
 */
export type DerivedScope = 'paragraph' | 'answer'

export const DEFAULT_CLAIM_OPTIONS: ClaimOptions = { minIntegerDigits: 3, allowDerived: true, derivedScope: 'paragraph' }

function withDefaults(options: Partial<ClaimOptions> | undefined): ClaimOptions {
  return { ...DEFAULT_CLAIM_OPTIONS, ...options }
}

// --- remove text whose numbers are not stated values -------------------------------------------

const FENCED = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm
// A line reference right after a code span: "`push_staged` (2867)", "`f` (4949, 4995-5003)".
const CODE_LINE_REF = /`[^`\n]*`\s*\(\s*\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*\s*\)/g
const INLINE_CODE = /`[^`\n]*`/g
const URL = /\b(?:https?|ftp|file):\/\/\S+/gi
const LINK_TARGET = /\]\([^)\s]*\)/g
const DATE_TIME = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g
const TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g
const VERSION = /\bv?\d+(?:\.\d+){2,}(?:[-+][\w.]+)?\b/gi
// More line numbers or ranges after a first one: "file.ext:12-40, 52, 60-64".
const MORE_LINES = String.raw`(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*`
// path/with/segments, ./rel, ../rel, ~/x, file.ext:12:3, file.ext:12-40
const PATH = new RegExp(
  String.raw`(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+(?::\d+(?:[-–]\d+)?(?::\d+)?${MORE_LINES})?`
  + String.raw`|[\w.-]+\.[A-Za-z]\w{0,9}:\d+(?:[-–]\d+)?(?::\d+)?${MORE_LINES}`,
  'g',
)
// A line range after a short label: "app:2655-2661", "js:3656-3663, 4971-4975".
const LABEL_LINE_RANGE = new RegExp(String.raw`\b[A-Za-z_][\w-]*:\d+\s*[-–]\s*\d+\b${MORE_LINES}`, 'g')
// Line ranges in parentheses: "(891-894)", "(12532-12569, 12605-12631)".
const PAREN_LINE_RANGES = /\(\s*\d+\s*[-–]\s*\d+(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*(?=\s*[),;])/g
// Digit groups joined by hyphens: phone numbers, ISBNs, ticket ids ("650-555-0142").
const DIGIT_CHAIN = /(?<!\w|\d\.)\d+(?:-\d+){2,}(?!\w|\.\d)/g
const ISSUE_REF = /#\d+\b/g

function blank(match: string): string {
  // Keep length and newlines so line starts stay line starts.
  return match.replace(/[^\n]/g, ' ')
}

/** The answer with every region whose numbers are not stated values blanked out. */
export function claimableText(answer: string): string {
  return answer
    .replace(FENCED, blank)
    .replace(CODE_LINE_REF, blank)
    .replace(INLINE_CODE, blank)
    .replace(URL, blank)
    .replace(LINK_TARGET, blank)
    .replace(DATE_TIME, blank)
    .replace(TIME, blank)
    .replace(VERSION, blank)
    .replace(PATH, blank)
    .replace(LABEL_LINE_RANGE, blank)
    .replace(PAREN_LINE_RANGES, blank)
    .replace(DIGIT_CHAIN, blank)
    .replace(ISSUE_REF, blank)
}

// --- read the claims ----------------------------------------------------------------------------

// An ASCII letter, digit or underscore before the number makes it part of an
// identifier (H100, x86, run_42). CJK text before it does not ("共1708个").
// A unit of up to three letters after it is allowed ("1530ms", "3GB", "2x").
const NUMBER = /(?<![A-Za-z0-9_.,\\])[-−+]?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?(\s?[%％‰])?(?![.,]?\d)(?![A-Za-z]{4,})(?![A-Za-z]{1,3}[0-9_])/g

// A word right before the number that says it is not an exact measured value,
// or that it is an example ("e.g. 150 ms").
const HEDGE_BEFORE = /(?:~|≈|∼|<|>|≤|≥|\b(?:about|around|roughly|approximately|approx\.?|nearly|almost|over|under|more than|less than|fewer than|at least|at most|up to|above|below|e\.g\.,?|eg\.|for example,?|for instance,?|such as)|约|大约|大概|将近|接近|近|超过|不到|不足|至少|最多|多达|上千|上万|例如|比如|譬如|假设|假如)\s*$/i
// ...or right after it: "300+ users", "300左右", and "95% CI" (a confidence level).
// A spaced "+" is addition ("469 + 181"), not a bound.
const HEDGE_AFTER = /^(?:\s*(?:多|余|左右|上下|以上|以下|开外|or so\b|or more\b|or less\b|-ish\b|CI\b|confidence\b|置信)|\+(?!\s*\d))/i
// A label that makes the number a reference, not a value: "Section 3.2", "step 12", "PR 150",
// "lines 9319–9338", "HTTP 404", "ISO 15189". The second half of a range after the label counts too.
const REFERENCE_BEFORE = /(?:\b(?:section|sec\.|step|figure|fig\.|table|chapter|appendix|line|lines|page|pp?\.|issue|pr|pull request|commit|version|ver\.|release|python|node|java|go|rust|ubuntu|macos|ios|android|cuda|port|pid|id|no\.|number|http|status|code|codes|errno|iso|isbn|rfc|rtx|gtx|(?:called|used|defined|declared|raised|set) at)|gb\/t|§|#|第)\s*(?:\d+\s*[-–]\s*)?$/i
// A letter and a hyphen right before the number make it part of a name: "ISO-8601", "COVID-19".
const NAME_HYPHEN_BEFORE = /[A-Za-z][-–]$/
// Numbering at the start of a line: "1. ", "2.1 Results", "## 3.4 Methods".
const LINE_NUMBERING = /^\s*(?:#{1,6}\s*|[-*+]\s+)?$/
// A unit the check can convert, right after the number.
const UNIT_AFTER = /^\s?(KiB|MiB|GiB|TiB|PiB|KB|kB|MB|GB|TB|PB|bytes?|ms|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|[KkMBsh]|万|亿|千|小时|分钟|秒|天)(?![A-Za-z])/
// Percentage points read like a percentage: "+26.4 pp" may be 0.264 in the tool output.
// The first number of a range takes the range's unit: "+9.0 to +26.4 pp", "9.0–26.4%".
const RANGE_REST = String.raw`(?:\s*(?:to|–|-|~|至|到)\s*[-−+]?\d+(?:\.\d+)?)?`
const POINTS_AFTER = new RegExp(String.raw`^${RANGE_REST}\s?(?:pp\b|p\.p\.|percentage points?\b|个?百分点)`, 'i')
const PERCENT_RANGE_AFTER = /^\s*(?:to|–|-|~|至|到)\s*[-−+]?\d+(?:\.\d+)?\s?[%％]/

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
export function extractClaims(answer: string, options?: Partial<ClaimOptions>): NumberClaim[] {
  const { minIntegerDigits } = withDefaults(options)
  const text = claimableText(answer)
  const claims: NumberClaim[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(NUMBER)) {
    const start = match.index
    const raw = match[0].trim()
    const intText = match[1]!
    const fraction = match[2] ?? ''
    const exponent = match[3] === undefined ? 0 : Number(match[3])
    const decimals = fraction.length
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const before = text.slice(Math.max(lineStart, start - 24), start)
    const after = text.slice(start + match[0].length, start + match[0].length + 24)
    const percent = match[4] !== undefined || POINTS_AFTER.test(after) || PERCENT_RANGE_AFTER.test(after)
    if (LINE_NUMBERING.test(text.slice(lineStart, start)) && /^\d+\.(?:\s|\d)|^\d+\)\s/.test(text.slice(start))) continue
    if (HEDGE_BEFORE.test(before) || HEDGE_AFTER.test(after)) continue
    if (REFERENCE_BEFORE.test(before) || NAME_HYPHEN_BEFORE.test(before)) continue

    const digits = intText.replaceAll(',', '')
    const value = Math.abs(Number(`${digits}${fraction ? `.${fraction}` : ''}`) * 10 ** exponent)
    if (!Number.isFinite(value)) continue
    if (decimals === 0 && exponent === 0 && !percent && digits.replace(/^0+(?=\d)/, '').length < minIntegerDigits) continue
    if (percent && decimals === 0 && value < 10) continue
    if (isYear(intText, decimals, percent) || isRound(value, percent, decimals)) continue

    const unit = percent ? undefined : UNIT_AFTER.exec(after)?.[1]
    const key = `${value}|${decimals}|${exponent}|${percent}|${unit ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const at = start + match[0].length - match[0].trimStart().length
    const claim: NumberClaim = { raw, value, halfWidth: 0.5 * 10 ** (exponent - decimals), percent, at }
    claims.push(unit === undefined ? claim : { ...claim, unit })
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

/** A sorted set of numbers, searchable by interval. */
export class NumberIndex {
  private pending: number[] = []
  private sorted = new Float64Array(0)

  /** Add every number in `text`. */
  add(text: string): void {
    for (const n of extractSourceNumbers(text)) this.pending.push(Math.abs(n))
  }

  /** Add numbers directly. */
  addValues(values: Iterable<number>): void {
    for (const n of values) if (Number.isFinite(n)) this.pending.push(Math.abs(n))
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

// --- unit changes -------------------------------------------------------------------------------

const BYTE_POWER: Record<string, number> = {
  KB: 1, kB: 1, KiB: 1, MB: 2, MiB: 2, GB: 3, GiB: 3, TB: 4, TiB: 4, PB: 5, PiB: 5,
}
const SECONDS: Record<string, number> = {
  ms: 0.001, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, 秒: 1,
  min: 60, mins: 60, minute: 60, minutes: 60, 分钟: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, 小时: 3600,
  day: 86_400, days: 86_400, 天: 86_400,
}
const TIME_STEPS = [0.001, 1, 60, 3600, 86_400]

/**
 * Factors that turn a claim in `unit` into the same quantity in a unit a tool
 * might have printed: 15.6 GB is 15.6e9 or 15.6 × 2^30 bytes, 15600 MB, …;
 * 2.7 h is 162 min or 9720 s; 1.63M is 1,630,000.
 */
export function unitFactors(unit: string | undefined): number[] {
  if (unit === undefined) return []
  const out: number[] = []
  const power = BYTE_POWER[unit] ?? (unit === 'B' || unit === 'byte' || unit === 'bytes' ? 0 : undefined)
  if (power !== undefined) {
    for (const base of [1000, 1024]) {
      for (let k = -2; k <= power; k++) if (k !== 0) out.push(base ** k)
    }
  }
  const seconds = SECONDS[unit]
  if (seconds !== undefined) for (const step of TIME_STEPS) if (step !== seconds) out.push(seconds / step)
  if (unit === 'K' || unit === 'k' || unit === '千') out.push(1e3, 1024)
  // A scale word may also restate a table kept in thousands (or millions):
  // $18.32M from 18,324.1 (USD thousands).
  if (unit === 'M') out.push(1e6, 1024 ** 2, 1e3)
  if (unit === 'B') out.push(1e9, 1e6, 1e3) // 284B parameters
  if (unit === '万') out.push(1e4)
  if (unit === '亿') out.push(1e8, 1e4)
  return out
}

/**
 * Is `claim` what some number in `index` reads as at the claim's precision?
 * 12.5% may be 0.125 in `index`; with `reverse`, 0.125 may also be 12.5% there
 * (for tool output, not for values the check computed itself).
 */
function coversClaim(claim: NumberClaim, index: NumberIndex, factor = 1, reverse = true): boolean {
  const value = claim.value * factor
  const halfWidth = claim.halfWidth * factor
  if (index.covers(value, halfWidth)) return true
  if (claim.percent && index.covers(value / 100, halfWidth / 100)) return true
  if (reverse && !claim.percent && factor === 1 && value <= 1 && index.covers(value * 100, halfWidth * 100)) return true
  return false
}

/** Is `claim` what some source number reads as at the precision it is written to, in its unit or a convertible one? */
export function isSourced(claim: NumberClaim, index: NumberIndex): boolean {
  if (coversClaim(claim, index)) return true
  return unitFactors(claim.unit).some(f => coversClaim(claim, index, f))
}

// --- what the answer's own numbers give ------------------------------------------------------------

// Every number in the claimable text, small ones included ("4 × 96 = 384").
const ANSWER_NUMBER = /(?<![A-Za-z0-9_.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![A-Za-z0-9_.,])\d+(?:\.\d+)?/g
const MAX_OPERANDS = 60

function isPowerOfTen(n: number): boolean {
  if (n <= 0) return false
  const log = Math.log10(n)
  return Math.abs(log - Math.round(log)) < 1e-12
}

const MAX_ROUNDS = 3

/** Every distinct number in `text`, in order. */
function numbersIn(text: string): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const m of text.matchAll(ANSWER_NUMBER)) {
    const n = Number(m[0].replaceAll(',', ''))
    if (!Number.isFinite(n) || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/** The part of `text` around position `at` that may supply operands. */
function regionAround(text: string, at: number, scope: DerivedScope): string {
  if (scope === 'answer') return text
  let start = 0
  for (const m of text.slice(0, at).matchAll(/\n[ \t]*\n/g)) start = m.index + m[0].length
  const after = /\n[ \t]*\n/.exec(text.slice(at))
  return text.slice(start, after === null ? text.length : at + after.index)
}

/**
 * Values the check computed from the answer's own numbers. `relative` holds
 * relative changes, which only a percentage claim is compared with ("9.5%
 * worse"): read as plain numbers they match far too much by chance.
 */
export interface Derived {
  readonly plain: NumberIndex
  readonly relative: NumberIndex
}

function derived(plain: number[], relative: number[]): Derived {
  const p = new NumberIndex()
  p.addValues(plain)
  const r = new NumberIndex()
  r.addValues(relative)
  return { plain: p, relative: r }
}

/**
 * Results of one step on two of `operands`: a + b, a − b, a × b, a ÷ b, and,
 * for two numbers less than a factor 2 apart, the relative change (a − b) ÷ b
 * ("9.5% worse": 97.1 vs 88.7). Also the complement of one operand, 100 − p or
 * 1 − f ("the other five take 23.7%" next to 76.3%).
 * Steps that only restate a number are left out: × or ÷ by 0, 1 or a power of
 * ten, and ± a number under 1% of the other (469 = 470 − 1 proves nothing).
 */
export function derivedValues(operands: readonly number[]): Derived {
  const plain: number[] = []
  const relative: number[] = []
  stepValues(operands.slice(0, MAX_OPERANDS), plain, relative)
  return derived(plain, relative)
}

function stepValues(ops: readonly number[], plain: number[], relative: number[]): void {
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!
    if (p > 0 && p < 100 && !Number.isInteger(p)) plain.push(100 - p)
    if (p > 0 && p < 1) plain.push(1 - p)
    for (let j = i + 1; j < ops.length; j++) {
      const a = Math.max(p, ops[j]!)
      const b = Math.min(p, ops[j]!)
      if (b >= 0.01 * a) plain.push(a + b, a - b)
      if (b === 0 || isPowerOfTen(a) || isPowerOfTen(b)) continue
      plain.push(a * b, a / b, b / a)
      if (a <= 2 * b) relative.push((a - b) / b, (a - b) / a)
    }
  }
}

// --- tables: column totals, means, shares and differences -----------------------------------------

// A row whose label says it aggregates the others is checked, not used as an operand.
const AGGREGATE_ROW = /\b(?:total|totals|sum|overall|all|mean|average|avg)\b|合计|总计|总数|总和|小计|共计|平均|均值/i
const TABLE_SEPARATOR = /^\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?$/
const MAX_COLUMN = 30

/** The numeric cells of each column of each markdown table in `text` (header and aggregate rows left out). */
function tableColumns(text: string): number[][] {
  const columns: number[][] = []
  let rows: string[][] = []
  let header = false
  const flush = (): void => {
    const body = header ? rows.slice(1) : rows
    const width = Math.max(0, ...body.map(r => r.length))
    for (let c = 0; c < width; c++) {
      const column: number[] = []
      for (const row of body) {
        if (AGGREGATE_ROW.test(row[0] ?? '')) continue
        const first = /(?<![A-Za-z0-9_.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![A-Za-z0-9_.,])\d+(?:\.\d+)?/.exec(row[c] ?? '')
        if (first !== null) column.push(Number(first[0].replaceAll(',', '')))
      }
      if (column.length >= 2) columns.push(column.slice(0, MAX_COLUMN))
    }
    rows = []
    header = false
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|')) {
      if (rows.length > 0) flush()
      continue
    }
    if (TABLE_SEPARATOR.test(t)) {
      if (rows.length === 1) header = true
      continue
    }
    rows.push(t.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()))
  }
  if (rows.length > 0) flush()
  return columns
}

/**
 * What a reader may compute from one table column anywhere in the answer:
 * its total and mean, each cell's share of the total, and one step on two of
 * its cells ("three services together: 30,456,293"; "地铁或公交合计 1013 人").
 */
function tableValues(text: string, blocked: ReadonlySet<number>): Derived {
  const plain: number[] = []
  const relative: number[] = []
  for (const raw of tableColumns(text)) {
    const column = raw.filter(n => !blocked.has(n))
    if (column.length < 2) continue
    const total = column.reduce((s, n) => s + n, 0)
    plain.push(total, total / column.length)
    if (total !== 0) for (const n of column) plain.push(n / total)
    stepValues(column, plain, relative)
  }
  return derived(plain, relative)
}

// --- working the answer shows: "3,987 + 1,764 + 258 + 2,655 = 8,664", "1.3% (1/80)" ---------------

const WORKING_CHARS = String.raw`[\d.,%$\s+\-−×*/÷()]`
const WORKING_BEFORE = new RegExp(String.raw`(${WORKING_CHARS}+)[=≈]\s*$`)
const WORKING_AFTER = new RegExp(String.raw`^\s*\(\s*=?\s*(${WORKING_CHARS}+?)\)(?!\s*[\d+\-−×*/÷])`)
const WORKING_TOKEN = /\s*(?:(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)%?|([+\-−×*/÷()])|\$)/y

/** Value of an arithmetic expression with at least one operator, or undefined. Blocked operands spoil it. */
function evaluate(expr: string, blocked: ReadonlySet<number>): number | undefined {
  const tokens: (number | string)[] = []
  WORKING_TOKEN.lastIndex = 0
  const source = expr.trim()
  while (WORKING_TOKEN.lastIndex < source.length) {
    const m = WORKING_TOKEN.exec(source)
    if (m === null) return undefined
    if (m[1] !== undefined) {
      const n = Number(m[1].replaceAll(',', ''))
      if (blocked.has(n)) return undefined
      tokens.push(n)
    } else if (m[2] !== undefined) tokens.push(m[2].replace('−', '-').replace('×', '*').replace('÷', '/'))
  }
  let i = 0
  let operators = 0
  const factor = (): number | undefined => {
    const t = tokens[i++]
    if (typeof t === 'number') return t
    if (t === '-') { const v = factor(); return v === undefined ? undefined : -v }
    if (t === '(') {
      const v = sum()
      return tokens[i++] === ')' ? v : undefined
    }
    return undefined
  }
  const product = (): number | undefined => {
    let v = factor()
    while (v !== undefined && (tokens[i] === '*' || tokens[i] === '/')) {
      const op = tokens[i++]
      const w = factor()
      if (w === undefined) return undefined
      operators++
      v = op === '*' ? v * w : v / w
    }
    return v
  }
  const sum = (): number | undefined => {
    let v = product()
    while (v !== undefined && (tokens[i] === '+' || tokens[i] === '-')) {
      const op = tokens[i++]
      const w = product()
      if (w === undefined) return undefined
      operators++
      v = op === '+' ? v + w : v - w
    }
    return v
  }
  const value = sum()
  return value !== undefined && i === tokens.length && operators > 0 && Number.isFinite(value) ? Math.abs(value) : undefined
}

/** Values of the working written right before (`… = claim`) or right after (`claim (a/b)`) the claim on its line. */
function shownWorking(text: string, claim: NumberClaim, blocked: ReadonlySet<number>): number[] {
  if (claim.at === undefined) return []
  const lineStart = text.lastIndexOf('\n', claim.at - 1) + 1
  const lineEnd = text.indexOf('\n', claim.at)
  const strip = (s: string): string => s.replace(/\*\*|__|`/g, '')
  const before = strip(text.slice(lineStart, claim.at))
  const after = strip(text.slice(claim.at + claim.raw.length, lineEnd === -1 ? text.length : lineEnd))
  const out: number[] = []
  for (const m of [WORKING_BEFORE.exec(before), WORKING_AFTER.exec(after)]) {
    const v = m === null ? undefined : evaluate(m[1]!, blocked)
    if (v !== undefined) out.push(v)
  }
  return out
}

/**
 * Drop the claims the answer's other numbers account for: one arithmetic step
 * on two numbers near the claim (see {@link DerivedScope}), a total, mean,
 * share or one step within a table column anywhere in the answer, or working
 * the answer writes out next to the claim (`a + b + c = claim`).
 * Only numbers that are not themselves unsourced claims may be operands, so
 * made-up numbers cannot vouch for each other (469, 181 and their sum 650).
 * A claim cleared this way becomes an operand for the next round.
 */
function dropDerived(answer: string, unsourced: NumberClaim[], scope: DerivedScope): NumberClaim[] {
  // Operands may sit in inline code (`590.11 TiB / 600 TiB`), not in code blocks.
  const text = answer.replace(FENCED, blank)
  let remaining = unsourced
  for (let round = 0; round < MAX_ROUNDS && remaining.length > 0; round++) {
    const blocked = new Set(remaining.map(c => c.value))
    const byRegion = new Map<string, Derived>()
    const tables = tableValues(text, blocked)
    // 8 × 605 s = 80.7 min: the step's result may be in another unit.
    const covered = (claim: NumberClaim, d: Derived): boolean =>
      coversClaim(claim, d.plain, 1, false)
      || unitFactors(claim.unit).some(f => coversClaim(claim, d.plain, f, false))
      || (claim.percent && coversClaim(claim, d.relative, 1, false))
    const next = remaining.filter((claim) => {
      if (claim.at === undefined) return true
      // Working written next to the claim decides: right working clears it, wrong
      // working keeps it even when some other combination happens to match.
      const working = shownWorking(text, claim, blocked)
      if (working.length > 0) return !covered(claim, derived(working, []))
      const region = regionAround(text, claim.at, scope)
      let near = byRegion.get(region)
      if (near === undefined) {
        near = derivedValues(numbersIn(region).filter(n => !blocked.has(n)))
        byRegion.set(region, near)
      }
      return !(covered(claim, near) || covered(claim, tables))
    })
    if (next.length === remaining.length) break
    remaining = next
  }
  return remaining
}

/** The claims in `answer` that no source number accounts for. */
export function unsourcedClaims(answer: string, index: NumberIndex, options?: Partial<ClaimOptions>): NumberClaim[] {
  const opts = withDefaults(options)
  const unsourced = extractClaims(answer, opts).filter(claim => !isSourced(claim, index))
  if (!opts.allowDerived || unsourced.length === 0) return unsourced
  return dropDerived(answer, unsourced, opts.derivedScope)
}
