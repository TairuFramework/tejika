import { describe, expect, test } from 'vitest'
import { poll } from '../src/poll.js'

describe('poll', () => {
  test('resolves the first truthy result', async () => {
    let calls = 0
    const result = await poll(
      () => {
        calls++
        return calls >= 3 ? 'done' : undefined
      },
      { intervalMs: 10 },
    )
    expect(result).toBe('done')
    expect(calls).toBe(3)
  })

  test('supports async functions', async () => {
    const result = await poll(async () => 42)
    expect(result).toBe(42)
  })

  test('returns undefined on timeout', async () => {
    const start = Date.now()
    const result = await poll(() => false, { timeoutMs: 100, intervalMs: 10 })
    expect(result).toBeUndefined()
    expect(Date.now() - start).toBeGreaterThanOrEqual(100)
  })

  test('calls fn at least once even with a zero timeout', async () => {
    let calls = 0
    const result = await poll(
      () => {
        calls++
        return 'immediate'
      },
      { timeoutMs: 0 },
    )
    expect(result).toBe('immediate')
    expect(calls).toBe(1)
  })
})
