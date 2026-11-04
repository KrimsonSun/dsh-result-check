// Summarise the eval runs: answers before and after the plugin's note, the note,
// tool failures, token use, an offline same-tool replay, and a pre-check of every
// number against the task's own data (hints for grading, not the verdict).
//   node extract.mjs            -> summary.jsonl and review/<task>.md
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acknowledgesFailure, readOutcome, unresolvedFailures } from '../../src/failures.ts'
import { NumberIndex, unsourcedClaims } from '../../src/numbers.ts'

const E = dirname(fileURLToPath(import.meta.url))
const IGNORED = ['*ABORTED*', '*CANCELLED', '*CANCELED', 'UNKNOWN_TOOL', 'INVALID_ARGS', 'TOOL_ACTIVATION_FAILED', 'AUTO_REVIEW_DENIED', 'DECLINED']
  .map(p => new RegExp(`^${p.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`).replaceAll('*', '.*')}$`))

const jsonl = f => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

function filesUnder(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) filesUnder(p, out)
    else out.push(p)
  }
  return out
}

// Everything a correct answer may quote: the task's files, all MCP data, and the truth values.
function dataIndex(task) {
  const idx = new NumberIndex()
  for (const f of filesUnder(join(E, 'tasks', task, 'files'))) idx.add(readFileSync(f, 'utf8'))
  for (const f of filesUnder(join(E, 'mcp-data'))) idx.add(readFileSync(f, 'utf8'))
  const truth = JSON.parse(readFileSync(join(E, 'tasks', task, 'task.json'), 'utf8')).truth
  idx.add(JSON.stringify(truth.facts.map(f => [f.value, ...(f.alt ?? [])])))
  return idx
}

function parse(dir) {
  const events = jsonl(join(dir, 'events.jsonl'))
  const steps = []
  let cur, final
  const usage = {}
  for (const ev of events) {
    if (ev.type === 'status' && ev.phase === 'step_start') steps.push(cur = { calls: [], results: [], text: [] })
    else if (ev.type === 'tool_call') cur?.calls.push(ev)
    else if (ev.type === 'tool_result') cur?.results.push(ev)
    else if (ev.type === 'text') cur?.text.push(ev.text)
    else if (ev.type === 'status' && ev.phase === 'step_end') {
      if (cur) cur.usage = ev.usage ?? {}
      for (const [k, v] of Object.entries(ev.usage ?? {})) if (typeof v === 'number') usage[k] = (usage[k] ?? 0) + v
    } else if (ev.type === 'final') final = ev
  }
  const stopAt = steps.findIndex(s => s.calls.length === 0 && s.text.length > 0)
  const before = stopAt >= 0 ? steps[stopAt].text.join('\n') : ''
  const notes = jsonl(join(dir, 'session.jsonl'))
    .filter(o => o.type === 'user/message' && o.data?.source?.kind === 'result-check')
    .map(o => ({ summary: o.data.source.summary, text: o.data.content.map(c => c.text ?? '').join('\n') }))
  const names = new Map()
  const outcomes = []
  const failures = []
  for (const s of steps.slice(0, stopAt >= 0 ? stopAt : steps.length)) {
    for (const c of s.calls) names.set(c.callId, c.tool)
    for (const r of s.results) {
      const name = names.get(r.callId) ?? '?'
      const isError = r.status === 'error'
      const code = r.error?.code
      if (isError && code && IGNORED.some(p => p.test(code))) { failures.push({ name, code, ignored: true }); continue }
      const text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '')
      const o = readOutcome(isError, text, undefined)
      outcomes.push({ callId: r.callId, name, ...o })
      if (o.failed) failures.push({ name, code, reason: o.reason })
    }
  }
  const sameTool = unresolvedFailures(outcomes, 'same-tool').length > 0 && !acknowledgesFailure(before)
  const anyTool = unresolvedFailures(outcomes, 'any-tool').length > 0 && !acknowledgesFailure(before)
  // Tokens spent after the first answer: the cost of the note, when the plugin fired.
  const usageAfter = {}
  for (const s of stopAt >= 0 ? steps.slice(stopAt + 1) : []) {
    for (const [k, v] of Object.entries(s.usage ?? {})) if (typeof v === 'number') usageAfter[k] = (usageAfter[k] ?? 0) + v
  }
  return {
    steps: steps.length, calls: steps.reduce((n, s) => n + s.calls.length, 0), usageAfter,
    callsAfter: stopAt >= 0 ? steps.slice(stopAt + 1).reduce((n, s) => n + s.calls.length, 0) : 0,
    tools: [...new Set(steps.flatMap(s => s.calls.map(c => c.tool)))],
    failures, before, final: final?.text ?? '', finalReason: final?.reason?.kind, notes, usage,
    replay: { anyToolFailureFlag: anyTool, sameToolFailureFlag: sameTool },
  }
}

const rows = []
const byTask = new Map()
const runsRoot = join(E, 'runs')
for (const model of existsSync(runsRoot) ? readdirSync(runsRoot) : []) {
  for (const task of readdirSync(join(runsRoot, model)).sort()) {
    const idx = dataIndex(task)
    for (const rep of readdirSync(join(runsRoot, model, task)).sort()) {
      const dir = join(runsRoot, model, task, rep)
      if (!existsSync(join(dir, 'meta.json'))) continue
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
      const r = parse(dir)
      const notInData = text => unsourcedClaims(text, idx).map(c => c.raw)
      const row = { model, task, rep: Number(rep), code: meta.code, signal: meta.signal, sec: Math.round(meta.ms / 1000), ...r,
        notInDataBefore: notInData(r.before), notInDataFinal: notInData(r.final) }
      rows.push(row)
      if (!byTask.has(task)) byTask.set(task, [])
      byTask.get(task).push(row)
    }
  }
}
writeFileSync(join(E, 'summary.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')

// One review packet per task: prompt, truth, and each run's answers and note.
mkdirSync(join(E, 'review'), { recursive: true })
for (const [task, list] of byTask) {
  const t = JSON.parse(readFileSync(join(E, 'tasks', task, 'task.json'), 'utf8'))
  const out = [`# ${task}`, '', '## Prompt', '', t.prompt, '', '## Truth', '', '```json', JSON.stringify(t.truth, null, 2), '```', '']
  for (const r of list) {
    out.push(`## Run ${r.model} #${r.rep}`, '', `- tools: ${r.tools.join(', ') || 'none'} (${r.calls} calls, ${r.steps} steps)`,
      `- tool failures before the first answer: ${JSON.stringify(r.failures)}`,
      `- numbers not found in the task data (hint only): before ${JSON.stringify(r.notInDataBefore)}, final ${JSON.stringify(r.notInDataFinal)}`,
      `- plugin note: ${r.notes.length ? r.notes.map(n => n.summary).join(' / ') : 'none'}`, '')
    out.push('### First answer (before any note)', '', r.before || '(none)', '')
    if (r.notes.length) {
      out.push('### Plugin note', '', '```text', r.notes.map(n => n.text).join('\n---\n'), '```', '', '### Final answer (after the note)', '', r.final || '(none)', '')
    }
  }
  writeFileSync(join(E, 'review', `${task}.md`), out.join('\n'))
}
const fired = rows.filter(r => r.notes.length).length
console.log(`${rows.length} runs, plugin fired on ${fired}; review packets in review/`)
