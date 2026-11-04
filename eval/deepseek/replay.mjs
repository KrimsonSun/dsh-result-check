// Replay the plugin's number check (and failure check) on recorded dsh runs with a given version of its code.
//   node replay.mjs <dir with numbers.ts and failures.ts> [label]
// Reproduces what the plugin saw before the first answer: the user prompt, tool arguments and tool results.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const E = dirname(fileURLToPath(import.meta.url))
const src = resolve(process.argv[2])
const label = process.argv[3] ?? src
const N = await import(pathToFileURL(join(src, 'numbers.ts')).href)
const F = await import(pathToFileURL(join(src, 'failures.ts')).href)

const rows = []
for (const model of readdirSync(join(E, 'runs'))) {
  for (const task of readdirSync(join(E, 'runs', model)).sort()) {
    const prompt = JSON.parse(readFileSync(join(E, 'tasks', task, 'task.json'), 'utf8')).prompt
    for (const rep of readdirSync(join(E, 'runs', model, task)).sort()) {
      const dir = join(E, 'runs', model, task, rep)
      if (!existsSync(join(dir, 'events.jsonl'))) continue
      // The session log holds full tool results (the --json stream truncates long ones).
      const log = readFileSync(join(dir, 'session.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      const index = new N.NumberIndex()
      const text = parts => (parts ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
      let answer = ''
      for (const o of log) {
        if (o.type === 'user/message' && o.data?.source?.kind !== 'result-check') index.add(text(o.data.content))
        else if (o.type === 'tool/call') index.add(String(o.data.arguments ?? ''))
        else if (o.type === 'tool/result') index.add(text(o.data.message?.content))
        else if (o.type === 'assistant/message') {
          const content = o.data.message?.content ?? []
          if (!content.some(p => p.type === 'tool-call') && text(content).trim()) { answer = text(content); break }
        }
      }
      const flagged = N.unsourcedClaims(answer, index).map(c => c.raw)
      rows.push({ model, task, rep: Number(rep), flagged, answer, index })
    }
  }
}
export { rows, N }
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fired = rows.filter(r => r.flagged.length)
  console.log(`${label}: ${rows.length} runs, would fire on ${fired.length}, ${fired.reduce((n, r) => n + r.flagged.length, 0)} numbers`)
  for (const r of fired) console.log(`  ${r.model.slice(9)} ${r.task.slice(0, 3)}#${r.rep}: ${r.flagged.join(', ')}`)
}
