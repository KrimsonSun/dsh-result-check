/**
 * Result check: before a turn closes, compare the final answer with what the
 * session's tools actually returned, and send the model back once when they
 * disagree.
 *
 * Two deterministic checks, both ported from AiScientist (a research agent for
 * biomedical data), where prompt instructions alone did not stop these errors
 * and code checks did:
 *
 * 1. Unreported tool failures — a tool call failed, was not retried
 *    successfully, and the answer does not say anything failed.
 * 2. Unsourced numbers — the answer states a number that no tool output, tool
 *    argument or user message of the session contains, at the precision the
 *    answer writes it.
 *
 * No model call is made. The plugin steers at `agent/turn-stopping` (at most
 * `maxNudgesPerTurn` times per turn), so the model gets one more step to retry,
 * correct, or say where a number came from.
 * @module dsh-result-check
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { acknowledgesFailure, DEFAULT_FAILURE_STATUSES, readOutcome, unresolvedFailures, type ToolOutcome } from './failures.ts'
import { NumberIndex, unsourcedClaims, type NumberClaim } from './numbers.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'result-check': { kind: 'result-check' } & ContextFormed
  }
}

export { acknowledgesFailure, readOutcome, unresolvedFailures } from './failures.ts'
export type { ToolOutcome } from './failures.ts'
export { extractClaims, NumberIndex, unsourcedClaims } from './numbers.ts'
export type { NumberClaim } from './numbers.ts'

export const name = 'result-check'

export interface Config {
  /** Flag tool failures the answer does not mention (default true). */
  checkFailures?: boolean
  /** Flag numbers no tool output, tool argument or user message contains (default true). */
  checkNumbers?: boolean
  /** Check numbers only in turns that called at least one tool (default true). */
  numbersNeedToolCall?: boolean
  /** Plain integers with fewer digits are not checked (default 3, so 100 and up). */
  minIntegerDigits?: number
  /** JSON `status` values that mean a tool call failed. */
  failureStatuses?: string[]
  /** Tool names (`*` wildcards) whose failures are ignored, e.g. exploratory reads. */
  ignoreTools?: string[]
  /** Skip agents running as subagents (default false: they are checked too). */
  skipSubagents?: boolean
  /** Most times one turn is sent back (default 1). */
  maxNudgesPerTurn?: number
  /** Most numbers listed in one message (default 8). */
  maxListedNumbers?: number
}

export const Config: z<Config> = z.object({
  checkFailures: z.boolean().default(true),
  checkNumbers: z.boolean().default(true),
  numbersNeedToolCall: z.boolean().default(true),
  minIntegerDigits: z.number().default(3),
  failureStatuses: z.array(z.string()).default([...DEFAULT_FAILURE_STATUSES]),
  ignoreTools: z.array(z.string()).default([]),
  skipSubagents: z.boolean().default(false),
  maxNudgesPerTurn: z.number().default(1),
  maxListedNumbers: z.number().default(8),
})

/** What the plugin knows about one session. */
interface SessionState {
  /** Seen from turn 1, so every earlier tool output is in `sources`. */
  complete: boolean
  sources: NumberIndex
  turn: number | undefined
  callNames: Map<string, string>
  outcomes: ToolOutcome[]
  toolCalls: number
  answer: string
  nudges: number
}

/** What one check found. */
export interface Findings {
  failures: ToolOutcome[]
  numbers: NumberClaim[]
}

type Block = { readonly type: string; readonly text?: string }

function textOf(content: readonly Block[]): string {
  return content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

function positiveInteger(value: number | undefined, key: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error(`result-check: \`${key}\` must be an integer >= 1, got ${String(value)}`)
  }
  return value
}

/** The message the model gets when a check finds something. */
export function renderFindings(findings: Findings, maxListed: number): string {
  const parts = [
    '[result-check] Before you finish, check your answer against this session\'s tool output. '
    + 'This note was produced by an automatic check, not written by the user.',
  ]
  if (findings.failures.length > 0) {
    const lines = findings.failures.map(f => `- \`${f.name}\` (call ${f.callId})${f.reason ? `: ${f.reason}` : ''}`)
    parts.push(
      'These tool calls failed and were not retried successfully, and your answer does not mention it:\n'
      + `${lines.join('\n')}\n`
      + 'Retry them, or tell the user plainly what failed and how that limits your answer.',
    )
  }
  if (findings.numbers.length > 0) {
    const shown = findings.numbers.slice(0, maxListed).map(n => n.raw)
    const more = findings.numbers.length - shown.length
    parts.push(
      'These numbers in your answer appear in no tool output, tool argument or user message of this session: '
      + `${shown.join(', ')}${more > 0 ? ` (and ${more} more)` : ''}.\n`
      + 'For each one, say which output it comes from or how you derived it, or correct it. '
      + 'Do not change a number that is right.',
    )
  }
  parts.push('Then give your final answer again.')
  return parts.join('\n\n')
}

/** One-line account shown on the notice row. */
export function summarize(findings: Findings): string {
  const parts: string[] = []
  const f = findings.failures.length
  const n = findings.numbers.length
  if (f > 0) parts.push(`${f} unreported tool failure${f === 1 ? '' : 's'}`)
  if (n > 0) parts.push(`${n} unsourced number${n === 1 ? '' : 's'}`)
  return `Result check: ${parts.join(', ')}`
}

export function apply(ctx: Context, config: Config): void {
  const checkFailures = config.checkFailures !== false
  const checkNumbers = config.checkNumbers !== false
  const numbersNeedToolCall = config.numbersNeedToolCall !== false
  const minIntegerDigits = positiveInteger(config.minIntegerDigits ?? 3, 'minIntegerDigits')
  const maxNudges = positiveInteger(config.maxNudgesPerTurn ?? 1, 'maxNudgesPerTurn')
  const maxListed = positiveInteger(config.maxListedNumbers ?? 8, 'maxListedNumbers')
  const statuses = config.failureStatuses ?? [...DEFAULT_FAILURE_STATUSES]
  const ignored = (config.ignoreTools ?? []).map(wildcard)
  const skipSubagents = config.skipSubagents === true

  const states = new WeakMap<Session, SessionState>()

  function stateFor(session: Session, firstTurn: number | undefined): SessionState {
    let state = states.get(session)
    if (state === undefined) {
      state = {
        // A session first seen at its turn 1 has nothing before it; any other
        // first sight (a resumed or forked session) misses earlier output.
        complete: firstTurn === 1,
        sources: new NumberIndex(),
        turn: undefined,
        callNames: new Map(),
        outcomes: [],
        toolCalls: 0,
        answer: '',
        nudges: 0,
      }
      states.set(session, state)
    }
    return state
  }

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'turn/start': {
        const state = stateFor(session, event.data.turn)
        state.turn = event.data.turn
        state.callNames.clear()
        state.outcomes = []
        state.toolCalls = 0
        state.answer = ''
        state.nudges = 0
        return
      }
      case 'user/message': {
        // Our own notes repeat the numbers they flag; they are not a source.
        if (event.data.source.kind === 'result-check') return
        stateFor(session, undefined).sources.add(textOf(event.data.content))
        return
      }
      case 'tool/call': {
        const state = stateFor(session, undefined)
        state.callNames.set(event.data.callId, event.data.name)
        state.toolCalls++
        state.sources.add(event.data.arguments)
        return
      }
      case 'tool/result': {
        const state = stateFor(session, undefined)
        const { message, error } = event.data
        const text = textOf(message.content)
        state.sources.add(text)
        const name = state.callNames.get(message.toolCallId) ?? 'unknown tool'
        if (ignored.some(p => p.test(name))) return
        const outcome = readOutcome(message.isError, text, error?.reason, statuses)
        state.outcomes.push({ callId: message.toolCallId, name, ...outcome })
        return
      }
      case 'assistant/message': {
        const state = stateFor(session, undefined)
        state.answer = event.data.interrupted ? '' : textOf(event.data.message.content)
        return
      }
      default:
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = states.get(agent.session)
    if (state === undefined || state.turn !== turn) return
    if (skipSubagents && agent.session.header.origin === 'subagent') return
    if (state.nudges >= maxNudges) return
    const answer = state.answer.trim()
    if (!answer) return

    const findings: Findings = { failures: [], numbers: [] }
    if (checkFailures) {
      const unresolved = unresolvedFailures(state.outcomes)
      if (unresolved.length > 0 && !acknowledgesFailure(answer)) findings.failures = unresolved
    }
    if (checkNumbers && state.complete && (state.toolCalls > 0 || !numbersNeedToolCall)) {
      findings.numbers = unsourcedClaims(answer, state.sources, { minIntegerDigits })
    }
    if (findings.failures.length === 0 && findings.numbers.length === 0) return

    state.nudges++
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: renderFindings(findings, maxListed) }],
      source: { kind: 'result-check', form: 'notice', summary: summarize(findings) },
    }))
  })
}
