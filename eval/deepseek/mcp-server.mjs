// MCP stdio server for the eval: read-only data tools over mcp-data/.
// Two calls fail on purpose: billing metrics return a JSON error status, and
// run r4 returns an MCP error (the tracking server "404").
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'mcp-data')
const load = name => JSON.parse(readFileSync(join(DATA, `${name}.json`), 'utf8'))
const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })
const fail = text => ({ content: [{ type: 'text', text }], isError: true })

serveStdio(() => {
  const server = new McpServer({ name: 'data', version: '1.0.0' })

  server.registerTool('list_datasets', { description: 'List datasets that get_dataset can return.', inputSchema: z.object({}) },
    async () => ok([{ name: 'trial_0427', description: 'Phase 2 trial, responder endpoint at week 12, two arms' }]))

  server.registerTool('get_dataset', { description: 'Return a dataset by name as JSON.', inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => name === 'trial_0427' ? ok(load('trial_0427')) : fail(`unknown dataset: ${name}`))

  server.registerTool('get_service_metrics', {
    description: 'Weekly SLO metrics for one service: uptime, p95 latency, error rate and request count.',
    inputSchema: z.object({ service: z.string(), week: z.string().describe('ISO week, e.g. 2026-W44') }),
  }, async ({ service }) => {
    if (service === 'billing') return ok({ service: 'billing', status: 'error', reason: 'metrics backend timeout after 30 s' })
    const all = load('services')
    return all[service] ? ok(all[service]) : fail(`unknown service: ${service}`)
  })

  server.registerTool('list_runs', { description: 'List training run ids of a project.', inputSchema: z.object({ project: z.string() }) },
    async ({ project }) => project === 'retina-cls' ? ok({ project, runs: ['r1', 'r2', 'r3', 'r4', 'r5'] }) : fail(`unknown project: ${project}`))

  server.registerTool('get_run', { description: 'Training run details: hyperparameters and per-epoch validation accuracy.', inputSchema: z.object({ run_id: z.string() }) },
    async ({ run_id }) => {
      if (run_id === 'r4') return fail('tracking server returned 404 for run r4')
      const runs = load('runs')
      return runs[run_id] ? ok(runs[run_id]) : fail(`unknown run: ${run_id}`)
    })

  server.registerTool('list_pipeline_steps', { description: 'List the steps of a pipeline run.', inputSchema: z.object({ run: z.string() }) },
    async ({ run }) => run === 'rnaseq-0412' ? ok({ run, steps: ['fastqc', 'trim', 'align', 'quantify', 'report'] }) : fail(`unknown run: ${run}`))

  server.registerTool('get_pipeline_step', { description: 'Status and outputs of one step of a pipeline run.', inputSchema: z.object({ run: z.string(), step: z.string() }) },
    async ({ run, step }) => {
      if (run !== 'rnaseq-0412') return fail(`unknown run: ${run}`)
      const steps = load('pipeline_rnaseq-0412')
      return steps[step] ? ok(steps[step]) : fail(`unknown step: ${step}`)
    })

  return server
})
