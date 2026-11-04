// Run every eval task through real dsh headless, with the result-check plugin on.
//   DSH_CMD=<dsh launcher> DSH_HOME=<dsh home> node run.mjs <model> <reps> [task,task,...]
// DSH_CMD runs the dsh CLI (default `dsh`); DSH_HOME is the home whose profile
// EVAL_PROFILE (default `result-check-eval`) loads this plugin, and whose .env
// holds DEEPSEEK_API_KEY. Each run gets a fresh workspace; output lands in
// runs/<model>/<task>/<rep>/. A run that already has meta.json is skipped, so
// the script can be resumed.
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const E = dirname(fileURLToPath(import.meta.url))
const DSH = process.env.DSH_CMD ?? 'dsh'
const HOME = process.env.DSH_HOME
if (!HOME) throw new Error('set DSH_HOME to the dsh home that holds the eval profile')
const PROFILE = process.env.EVAL_PROFILE ?? 'result-check-eval'
const PATCH = join(E, 'eval.patch.yml')
const TIMEOUT_MS = 15 * 60 * 1000
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 4)

const [model = 'deepseek-flash', repsArg = '1', only = ''] = process.argv.slice(2)
const reps = Number(repsArg)
const tasks = readdirSync(join(E, 'tasks')).sort().filter(t => !only || only.split(',').some(o => t.startsWith(o)))

function findSession(id) {
  const root = join(HOME, 'sessions')
  for (const proj of readdirSync(root)) {
    const f = join(root, proj, id, 'session.v4.jsonl.zstd')
    if (existsSync(f)) return f
  }
}

function runOne(task, rep) {
  const dir = join(E, 'runs', model, task, String(rep))
  if (existsSync(join(dir, 'meta.json'))) return Promise.resolve('skipped')
  const work = join(dir, 'work')
  mkdirSync(work, { recursive: true })
  cpSync(join(E, 'tasks', task, 'files'), work, { recursive: true })
  const { prompt } = JSON.parse(readFileSync(join(E, 'tasks', task, 'task.json'), 'utf8'))
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(DSH, ['--profile', PROFILE, '--patch', PATCH, ...(process.env.EVAL_EXTRA_PATCH ? ['--patch', process.env.EVAL_EXTRA_PATCH] : []), '--approval-policy', 'never', '--json', prompt], {
      cwd: work, env: { ...process.env, DSH_HOME: HOME, EVAL_MODEL: model, EVAL_MCP_SERVER: join(E, 'mcp-server.mjs'), DSH_TELEMETRY_DISABLED: '1' },
    })
    child.stdout.pipe(createWriteStream(join(dir, 'events.jsonl')))
    child.stderr.pipe(createWriteStream(join(dir, 'err.txt')))
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const meta = { task, rep, model, code, signal, ms: Date.now() - started }
      try {
        const first = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n')[0]
        const id = JSON.parse(first).sessionId
        const f = id && findSession(id)
        if (f) writeFileSync(join(dir, 'session.jsonl'), execFileSync('zstd', ['-dc', f]))
        meta.sessionId = id
      } catch (e) { meta.extractError = String(e) }
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
      resolve(`${task}#${rep} code=${code}${signal ? ' ' + signal : ''} ${(meta.ms / 1000).toFixed(0)}s`)
    })
  })
}

const queue = tasks.flatMap(t => Array.from({ length: reps }, (_, i) => [t, i + 1]))
let next = 0
async function worker() {
  while (next < queue.length) {
    const [t, r] = queue[next++]
    console.log(await runOne(t, r))
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
console.log('done', model, queue.length, 'runs')
