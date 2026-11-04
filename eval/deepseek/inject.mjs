// Misses on DeepSeek answers: change one sourced number in a first answer (last digit + 1,
// or value × 1.2) and see whether each version of the check flags the changed number.
//   node inject.mjs <old src dir> <new src dir>
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const E = dirname(fileURLToPath(import.meta.url))
const load = async dir => ({
  N: await import(pathToFileURL(join(resolve(dir), 'numbers.ts')).href),
})
const versions = { old: await load(process.argv[2]), new: await load(process.argv[3]) }
const text = parts => (parts ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')

function sessionOf(dir, N) {
  const log = readFileSync(join(dir, 'session.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const index = new N.NumberIndex()
  for (const o of log) {
    if (o.type === 'user/message' && o.data?.source?.kind !== 'result-check') index.add(text(o.data.content))
    else if (o.type === 'tool/call') index.add(String(o.data.arguments ?? ''))
    else if (o.type === 'tool/result') index.add(text(o.data.message?.content))
    else if (o.type === 'assistant/message') {
      const content = o.data.message?.content ?? []
      if (!content.some(p => p.type === 'tool-call') && text(content).trim()) return { index, answer: text(content) }
    }
  }
  return { index, answer: '' }
}

const sig = raw => raw.replace(/[^\d]/g, '').replace(/^0+/, '').length
const results = []
for (const model of readdirSync(join(E, 'runs'))) {
  for (const task of readdirSync(join(E, 'runs', model))) {
    for (const rep of readdirSync(join(E, 'runs', model, task))) {
      const dir = join(E, 'runs', model, task, rep)
      if (!existsSync(join(dir, 'session.jsonl'))) continue
      const s = { old: sessionOf(dir, versions.old.N), new: sessionOf(dir, versions.new.N) }
      const answer = s.old.answer
      const text0 = versions.old.N.claimableText(answer)
      // Candidates: numbers both versions read as claims and that a tool output states directly.
      const claims = versions.old.N.extractClaims(answer).filter(c => versions.old.N.isSourced(c, s.old.index))
      for (const claim of claims.slice(0, 6)) {
        const at = text0.indexOf(claim.raw)
        if (at < 0) continue
        const m = /^([-−+]?)([\d,]+)(?:\.(\d+))?(.*)$/.exec(claim.raw)
        if (m === null) continue
        const decimals = m[3]?.length ?? 0
        const last = Number(claim.raw.replace(/[^\d]/g, '').at(-1))
        const typo = claim.raw.replace(/(\d)(?!.*\d)/, String(last === 9 ? 8 : last + 1))
        let scaled = (claim.value * 1.2).toFixed(decimals)
        if (m[2].includes(',')) scaled = scaled.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        for (const [kind, wrong] of [['typo', typo], ['x1.2', `${m[1]}${scaled}${m[4]}`]]) {
          if (wrong === claim.raw) continue
          const changed = answer.slice(0, at) + wrong + answer.slice(at + claim.raw.length)
          const caught = {}
          for (const v of ['old', 'new']) caught[v] = versions[v].N.unsourcedClaims(changed, s[v].index).some(c => c.raw === wrong)
          results.push({ model, task, kind, digits: sig(claim.raw), ...caught })
        }
      }
    }
  }
}
const pct = (a, b) => `${b ? ((100 * a) / b).toFixed(1) : 0}% of ${b}`
for (const kind of ['typo', 'x1.2']) {
  const rows = results.filter(r => r.kind === kind)
  for (const v of ['old', 'new']) {
    const by = f => { const sub = rows.filter(f); return pct(sub.filter(r => r[v]).length, sub.length) }
    console.log(`${kind} ${v}: all ${by(() => true)} | 1-2 digits ${by(r => r.digits <= 2)} | 3 digits ${by(r => r.digits === 3)} | 4+ digits ${by(r => r.digits >= 4)}`)
  }
}
const lost = results.filter(r => r.old && !r.new)
console.log(`caught by old but not new: ${lost.length}; by new but not old: ${results.filter(r => r.new && !r.old).length}`)
const byTask = {}
for (const r of lost) byTask[r.task] = (byTask[r.task] ?? 0) + 1
console.log('lost by task:', JSON.stringify(byTask))
