/**
 * Replay the plugin's two checks over Claude Code transcripts, offline.
 *
 *   node eval/replay-claude-code.ts [~/.claude/projects]
 *
 * For every turn that called a tool it reports what the plugin would have done,
 * using the plugin's own check code, and then measures misses: it changes one
 * sourced number in the answer (last digit + 1, or the value × 1.2) and counts
 * how often the number check flags the changed number.
 *
 * Claude Code differs from dsh in two ways that matter here, and the replay
 * follows dsh: a call Claude Code rejected before running it (bad arguments,
 * unknown tool, interrupted, needs approval) is skipped, as dsh's error codes
 * let the plugin do; a shell command exiting non-zero is a normal result.
 * Nothing is written; transcripts stay on this machine.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acknowledgesFailure, readOutcome, unresolvedFailures, type ToolOutcome } from '../src/failures.ts'
import { claimableText, extractClaims, NumberIndex, unsourcedClaims } from '../src/numbers.ts'

const ROOT = process.argv[2] ?? join(homedir(), '.claude', 'projects')
const REJECTED_BEFORE_RUNNING = /<tool_use_error>|InputValidationError|No such tool|Unknown skill|Tool call interrupted|requires user approval/
// Desktop-app bookkeeping tools have no dsh equivalent; their arguments are not sources.
const NOT_A_SOURCE = /^mcp__ccd_/

type Block = Record<string, unknown>

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b: Block) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'tool_result' ? textOf(b.content) : '')).join('\n')
}

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files(p, out)
    else if (name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

function significantDigits(raw: string): number {
  return raw.replace(/[^\d]/g, '').replace(/^0+/, '').length
}

interface Turn { calls: number; names: Map<string, string>; outcomes: ToolOutcome[]; answer: string[] }

const seen = new Set<string>()
const totals = { turns: 0, sentBack: 0, failureFlags: 0, numberFlagTurns: 0, numbersFlagged: 0 }
const injected: { kind: string; digits: number; caught: boolean }[] = []

function finish(turn: Turn | undefined, sources: NumberIndex): void {
  if (turn === undefined || turn.calls === 0) return
  const answer = turn.answer.join('\n\n').trim()
  if (!answer || seen.has(answer)) return // forked sessions repeat whole turns
  seen.add(answer)
  totals.turns++
  const failures = unresolvedFailures(turn.outcomes).length > 0 && !acknowledgesFailure(answer)
  const numbers = unsourcedClaims(answer, sources)
  if (failures) totals.failureFlags++
  if (numbers.length > 0) totals.numberFlagTurns++
  totals.numbersFlagged += numbers.length
  if (failures || numbers.length > 0) totals.sentBack++

  const flagged = new Set(numbers.map(c => c.raw))
  const text = claimableText(answer)
  for (const claim of extractClaims(answer).filter(c => !flagged.has(c.raw)).slice(0, 3)) {
    const at = text.indexOf(claim.raw)
    if (at < 0) continue
    const m = /^([-−+]?)([\d,]+)(?:\.(\d+))?(.*)$/.exec(claim.raw)
    if (m === null) continue
    const decimals = m[3]?.length ?? 0
    const last = Number(claim.raw.replace(/[^\d]/g, '').at(-1))
    const typo = claim.raw.replace(/(\d)(?!.*\d)/, String(last === 9 ? 8 : last + 1))
    let scaled = (claim.value * 1.2).toFixed(decimals)
    if (m[2]!.includes(',')) scaled = scaled.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    for (const [kind, wrong] of [['last digit + 1', typo], ['value × 1.2', `${m[1]}${scaled}${m[4]}`]] as const) {
      if (wrong === claim.raw) continue
      const changed = answer.slice(0, at) + wrong + answer.slice(at + claim.raw.length)
      const caught = unsourcedClaims(changed, sources).some(c => c.raw === wrong)
      injected.push({ kind, digits: significantDigits(claim.raw), caught })
    }
  }
}

for (const file of files(ROOT)) {
  const sources = new NumberIndex()
  let turn: Turn | undefined
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let o: Record<string, any>
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'attachment') {
      if (Array.isArray(o.rendered)) for (const r of o.rendered) sources.add(textOf(r?.content))
      continue
    }
    const content = o.message?.content
    if (o.type === 'user') {
      const results = Array.isArray(content) ? content.filter((b: Block) => b?.type === 'tool_result') : []
      if (results.length === 0) {
        if (!o.isMeta) {
          finish(turn, sources)
          turn = { calls: 0, names: new Map(), outcomes: [], answer: [] }
        }
        sources.add(textOf(content))
        continue
      }
      for (const b of results) {
        const text = textOf(b.content)
        sources.add(text)
        if (turn === undefined) continue
        turn.answer = []
        const name = turn.names.get(b.tool_use_id) ?? 'unknown'
        if (b.is_error === true && REJECTED_BEFORE_RUNNING.test(text)) continue
        const shellExit = b.is_error === true && name === 'Bash' && /^Exit code \d+/.test(text)
        const outcome = shellExit ? { failed: false } : readOutcome(b.is_error === true, text, undefined)
        turn.outcomes.push({ callId: b.tool_use_id, name, ...outcome })
      }
      continue
    }
    if (o.type === 'assistant' && turn !== undefined && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text') turn.answer.push(String(b.text))
        else if (b?.type === 'tool_use') {
          turn.names.set(b.id, b.name)
          turn.calls++
          if (!NOT_A_SOURCE.test(b.name)) sources.add(JSON.stringify(b.input))
          turn.answer = []
        }
      }
    }
  }
  finish(turn, sources)
}

const pct = (a: number, b: number): string => `${b === 0 ? 0 : ((100 * a) / b).toFixed(1)}%`
console.log(`Turns that called a tool: ${totals.turns}`)
console.log(`  sent back:            ${totals.sentBack} (${pct(totals.sentBack, totals.turns)})`)
console.log(`  for a tool failure:   ${totals.failureFlags}`)
console.log(`  for numbers:          ${totals.numberFlagTurns} turns, ${totals.numbersFlagged} numbers`)
console.log('Changed numbers flagged:')
for (const kind of ['last digit + 1', 'value × 1.2']) {
  const rows = injected.filter(r => r.kind === kind)
  const share = (f: (r: typeof rows[number]) => boolean): string => {
    const sub = rows.filter(f)
    return `${pct(sub.filter(r => r.caught).length, sub.length)} of ${sub.length}`
  }
  console.log(`  ${kind}: ${share(() => true)} (1–2 significant digits ${share(r => r.digits <= 2)}, 3 digits ${share(r => r.digits === 3)}, 4+ digits ${share(r => r.digits >= 4)})`)
}
