/**
 * Tool calls that failed in a turn, were never retried successfully, and that
 * the final answer does not mention.
 *
 * Ported from AiScientist, where a step whose tool failed or returned nothing
 * could not be accepted: "a tool failure is reported as a failure, never
 * dressed up as success". A tool counts as failed when the harness marks its
 * result as an error, or when it returns a JSON object whose `status` says so
 * (the convention MCP and many script tools follow).
 */

/** What one tool call in the turn came to. */
export interface ToolOutcome {
  readonly callId: string
  readonly name: string
  readonly failed: boolean
  /** A short reason, when the result gives one. */
  readonly reason?: string
}

/** `status` values that mean the call failed (compared case-insensitively). */
export const DEFAULT_FAILURE_STATUSES: readonly string[] = [
  'error', 'failed', 'failure', 'timeout', 'timed_out', 'unavailable', 'not_enabled',
  'dependency_missing', 'cancelled', 'canceled', 'blocked',
]

const REASON_KEYS = ['error', 'message', 'reason', 'detail', 'details', 'stderr'] as const
const MAX_REASON_CHARS = 200
const MAX_JSON_CHARS = 1_000_000

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= MAX_REASON_CHARS ? oneLine : `${oneLine.slice(0, MAX_REASON_CHARS - 1)}…`
}

function failedStatus(status: string, statuses: readonly string[]): boolean {
  const s = status.trim().toLowerCase()
  return statuses.some(x => x.toLowerCase() === s) || /^(?:error|fail|blocked)/.test(s)
}

/**
 * Did this tool result fail?
 * @param isError - the harness's own error flag on the result.
 * @param text - the result's text content.
 * @param errorReason - the harness's user-facing failure reason, when it has one.
 * @param statuses - `status` values that mean failure.
 */
export function readOutcome(
  isError: boolean | undefined,
  text: string,
  errorReason: string | undefined,
  statuses: readonly string[] = DEFAULT_FAILURE_STATUSES,
): { failed: boolean; reason?: string } {
  if (isError) {
    const reason = errorReason ?? text
    return reason.trim() ? { failed: true, reason: shorten(reason) } : { failed: true }
  }
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || trimmed.length > MAX_JSON_CHARS) return { failed: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { failed: false }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { failed: false }
  const record = parsed as Record<string, unknown>
  const status = record.status
  if (typeof status !== 'string' || !failedStatus(status, statuses)) return { failed: false }
  for (const key of REASON_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return { failed: true, reason: shorten(`${status}: ${value}`) }
  }
  return { failed: true, reason: status }
}

/** Failed calls with no later successful call to the same tool in the turn. */
export function unresolvedFailures(outcomes: readonly ToolOutcome[]): ToolOutcome[] {
  const unresolved: ToolOutcome[] = []
  outcomes.forEach((outcome, i) => {
    if (!outcome.failed) return
    const retried = outcomes.slice(i + 1).some(later => later.name === outcome.name && !later.failed)
    if (!retried) unresolved.push(outcome)
  })
  return unresolved
}

// Words that show the answer tells the user something did not work.
const ACKNOWLEDGES = /\b(?:fail(?:s|ed|ing|ure|ures)?|error(?:s|ed)?|errored|unable|couldn['’]?t|could not|cannot|can['’]?t|did not (?:work|succeed|complete|return|run|finish)|didn['’]?t (?:work|succeed|complete|return|run|finish)|wasn['’]?t able|was not able|not available|unavailable|timed? ?out|crash(?:ed|es)?|exception|denied|blocked|refused)\b|失败|报错|出错|错误|未能|无法|没能|没有成功|未成功|不成功|超时|异常|拒绝|不可用|没有返回|未返回/i

/** Does the answer say that something failed? Any such statement counts (precision first). */
export function acknowledgesFailure(answer: string): boolean {
  return ACKNOWLEDGES.test(answer)
}
