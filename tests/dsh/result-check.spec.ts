/**
 * The plugin inside a real dsh agent loop, against a scripted model (no network).
 * Runs only from a DeepSeek Harness source checkout: `npm run test:dsh -- <checkout>`.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import * as ResultCheck from '../../src/index.ts'
import type { Config } from '../../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ResultCheck, config)
  ctx.tools.register(defineContentToolFixture({
    name: 'stats', description: 'returns stats', parameters: {},
    async execute() { return [{ type: 'text', text: '{"auc": 0.87312, "n_cells": 1708, "frac_failed": 0.125}' }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'fetch', description: 'always throws', parameters: {},
    async execute() { throw new Error('HTTP 503 from upstream') },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'job', description: 'reports a failed status', parameters: {},
    async execute() { return [{ type: 'text', text: '{"status": "error", "error": "Slurm queue unavailable"}' }] },
  }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: a, status }) => {
      if (a === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function run(ctx: Context, script: Script, prompts: string[] = ['go']): Promise<{ agent: Agent; adapter: MockAdapter }> {
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('s1'), { provider: 'mock', model: 'mock' })
  for (const text of prompts) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
  }
  return { agent, adapter }
}

/** The notes this plugin sent, in order. */
function notes(agent: Agent): { text: string; summary: string }[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'result-check')
    .map(e => ({
      text: e.data.content.map(b => (b.type === 'text' ? b.text : '')).join(''),
      summary: (e.data.source as { summary?: string }).summary ?? '',
    }))
}

describe('unreported tool failures', () => {
  it('sends the model back once when a failure goes unmentioned', async () => {
    const ctx = await harness()
    const { agent, adapter } = await run(ctx, [
      toolCallResponse('c1', 'fetch', {}),
      textResponse('Here is the summary of the page.'),
      textResponse('The fetch failed (HTTP 503), so I could not summarise the page.'),
    ])
    const found = notes(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.summary).toBe('Result check: 1 unreported tool failure')
    expect(found[0]!.text).toContain('`fetch` (call c1)')
    expect(found[0]!.text).toContain('HTTP 503')
    expect(adapter.requests).toHaveLength(3)
  })

  it('reads a JSON status error as a failure', async () => {
    const ctx = await harness()
    const { agent } = await run(ctx, [
      toolCallResponse('c1', 'job', {}),
      textResponse('The analysis is done.'),
      textResponse('The job could not run: the Slurm queue was unavailable.'),
    ])
    expect(notes(agent)[0]!.text).toContain('Slurm queue unavailable')
  })

  it('stays quiet when the answer says something failed', async () => {
    const ctx = await harness()
    const { agent, adapter } = await run(ctx, [
      toolCallResponse('c1', 'fetch', {}),
      textResponse('The fetch failed with HTTP 503.'),
    ])
    expect(notes(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(2)
  })

  it('stays quiet when the tool was retried successfully', async () => {
    const ctx = await harness()
    let flakyCalls = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'flaky', description: 'fails once', parameters: {},
      async execute() {
        flakyCalls++
        if (flakyCalls === 1) throw new Error('reset')
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    const { agent } = await run(ctx, [
      toolCallResponse('c1', 'flaky', {}),
      toolCallResponse('c2', 'flaky', {}),
      textResponse('Done.'),
    ])
    expect(notes(agent)).toEqual([])
  })

  it('ignores tools matched by ignoreTools', async () => {
    const ctx = await harness({ ignoreTools: ['fe*'] })
    const { agent } = await run(ctx, [toolCallResponse('c1', 'fetch', {}), textResponse('Done.')])
    expect(notes(agent)).toEqual([])
  })
})

describe('unsourced numbers', () => {
  it('flags a number no tool returned and lists it', async () => {
    const ctx = await harness()
    const { agent } = await run(ctx, [
      toolCallResponse('c1', 'stats', {}),
      textResponse('AUC was 0.873 across 1,708 cells, and 469 of them were amacrine.'),
      textResponse('469 was my estimate; the tool did not report it. AUC 0.873 over 1,708 cells.'),
    ])
    const found = notes(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.summary).toBe('Result check: 1 unsourced number')
    expect(found[0]!.text).toContain(': 469.')
  })

  it('accepts rounded and percent forms of tool output', async () => {
    const ctx = await harness()
    const { agent } = await run(ctx, [
      toolCallResponse('c1', 'stats', {}),
      textResponse('AUC 0.873 over 1708 cells; 12.5% failed QC.'),
    ])
    expect(notes(agent)).toEqual([])
  })

  it('skips turns that called no tool', async () => {
    const ctx = await harness()
    const { agent } = await run(ctx, [textResponse('Typical values are 0.873 and 469.')])
    expect(notes(agent)).toEqual([])
  })

  it('counts numbers the user gave as sourced', async () => {
    const ctx = await harness()
    const { agent } = await run(ctx, [
      toolCallResponse('c1', 'stats', {}),
      textResponse('With your threshold of 0.375, AUC is 0.873.'),
    ], ['use a threshold of 0.375'])
    expect(notes(agent)).toEqual([])
  })

  it('does not let its own note make a number sourced in a later turn', async () => {
    const ctx = await harness()
    const { agent } = await run(ctx, [
      toolCallResponse('c1', 'stats', {}),
      textResponse('There were 469 amacrine cells.'),
      textResponse('There were 469 amacrine cells (my estimate).'),
      toolCallResponse('c2', 'stats', {}),
      textResponse('Again: 469 amacrine cells.'),
      textResponse('469 is an estimate.'),
    ], ['go', 'again'])
    expect(notes(agent)).toHaveLength(2)
  })
})

describe('limits and config', () => {
  it('sends a turn back at most maxNudgesPerTurn times', async () => {
    const ctx = await harness()
    const { agent, adapter } = await run(ctx, [
      toolCallResponse('c1', 'fetch', {}),
      textResponse('All good: 469 rows.'),
      textResponse('Still all good: 469 rows.'),
    ])
    const found = notes(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.summary).toBe('Result check: 1 unreported tool failure, 1 unsourced number')
    expect(adapter.requests).toHaveLength(3)
  })

  it('turns each check off', async () => {
    const ctx = await harness({ checkFailures: false, checkNumbers: false })
    const { agent } = await run(ctx, [toolCallResponse('c1', 'fetch', {}), textResponse('All good: 469 rows.')])
    expect(notes(agent)).toEqual([])
  })

  it('rejects a bad limit at load', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(ResultCheck, { maxNudgesPerTurn: 0 })).rejects.toThrow(/maxNudgesPerTurn/)
  })
})
