import { describe, expect, it } from 'vitest'
import { acknowledgesFailure, readOutcome, unresolvedFailures, type ToolOutcome } from '../../src/failures.ts'

describe('readOutcome', () => {
  it('trusts the harness error flag and keeps a short reason', () => {
    expect(readOutcome(true, 'ENOENT: no such file', undefined)).toEqual({ failed: true, reason: 'ENOENT: no such file' })
    expect(readOutcome(true, 'raw text', 'Permission denied')).toEqual({ failed: true, reason: 'Permission denied' })
    expect(readOutcome(true, '   ', undefined)).toEqual({ failed: true })
  })

  it('reads a JSON status that means failure', () => {
    expect(readOutcome(false, '{"status": "error", "error": "Slurm queue unavailable"}', undefined))
      .toEqual({ failed: true, reason: 'error: Slurm queue unavailable' })
    expect(readOutcome(false, '{"status": "dependency_missing"}', undefined)).toEqual({ failed: true, reason: 'dependency_missing' })
    expect(readOutcome(false, '{"status": "blocked_by_policy"}', undefined).failed).toBe(true)
  })

  it('leaves successful and non-JSON results alone', () => {
    expect(readOutcome(false, '{"status": "ok", "n": 3}', undefined)).toEqual({ failed: false })
    expect(readOutcome(false, 'exit code 1\nFAILED tests/a.spec.ts', undefined)).toEqual({ failed: false })
    expect(readOutcome(false, '{not json', undefined)).toEqual({ failed: false })
    expect(readOutcome(false, '[{"status": "error"}]', undefined)).toEqual({ failed: false })
  })

  it('honours a custom status list', () => {
    expect(readOutcome(false, '{"status": "skipped"}', undefined, ['skipped']).failed).toBe(true)
  })

  it('shortens long reasons to one line', () => {
    const { reason } = readOutcome(true, `line one\n${'x'.repeat(500)}`, undefined)
    expect(reason!.length).toBeLessThanOrEqual(200)
    expect(reason).not.toContain('\n')
  })
})

describe('unresolvedFailures', () => {
  const o = (callId: string, name: string, failed: boolean): ToolOutcome => ({ callId, name, failed })

  it('keeps a failure nothing after it made up for', () => {
    expect(unresolvedFailures([o('1', 'read', false), o('2', 'fetch', true)]).map(f => f.callId)).toEqual(['2'])
    expect(unresolvedFailures([o('1', 'fetch', true), o('2', 'fetch', true)]).map(f => f.callId)).toEqual(['1', '2'])
  })

  it('by default, drops a failure once any later call succeeds (the agent moved on)', () => {
    expect(unresolvedFailures([o('1', 'fetch', true), o('2', 'fetch', false)])).toEqual([])
    expect(unresolvedFailures([o('1', 'fetch', true), o('2', 'read', false)])).toEqual([])
  })

  it('with same-tool, only a later success of that tool counts', () => {
    expect(unresolvedFailures([o('1', 'fetch', true), o('2', 'read', false)], 'same-tool').map(f => f.callId)).toEqual(['1'])
    expect(unresolvedFailures([o('1', 'fetch', true), o('2', 'fetch', false)], 'same-tool')).toEqual([])
  })

  it('does not count a success before the failure', () => {
    expect(unresolvedFailures([o('1', 'fetch', false), o('2', 'fetch', true)]).map(f => f.callId)).toEqual(['2'])
  })
})

describe('acknowledgesFailure', () => {
  it('recognises English and Chinese statements of failure', () => {
    for (const text of [
      'The download failed, so the table is incomplete.',
      "I couldn't reach the server.",
      'The request timed out.',
      '数据下载失败，结果不完整。',
      '无法连接到集群。',
    ]) expect(acknowledgesFailure(text)).toBe(true)
  })

  it('does not fire on an ordinary answer', () => {
    expect(acknowledgesFailure('All 3 steps completed; results are in out/table.csv.')).toBe(false)
    expect(acknowledgesFailure('分析完成，共 1708 个细胞。')).toBe(false)
  })
})
