import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, test } from 'vitest'
import { createDeadline } from '../src/deadline.js'

describe('createDeadline', () => {
  test('is unbounded with no timeout and no signal', () => {
    const deadline = createDeadline()
    expect(deadline.remaining()).toBe(Number.POSITIVE_INFINITY)
    expect(deadline.expired()).toBe(false)
    expect(deadline.signal.aborted).toBe(false)
  })

  test('counts down and expires', async () => {
    const deadline = createDeadline(50)
    expect(deadline.remaining()).toBeGreaterThan(0)
    expect(deadline.remaining()).toBeLessThanOrEqual(50)
    await delay(80)
    expect(deadline.expired()).toBe(true)
    expect(deadline.remaining()).toBe(0)
    expect(deadline.signal.aborted).toBe(true)
  })

  test('aborts when the caller signal aborts, before the timer fires', () => {
    const controller = new AbortController()
    const deadline = createDeadline(10_000, controller.signal)
    expect(deadline.signal.aborted).toBe(false)
    controller.abort()
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.expired()).toBe(true)
  })

  test('an already-aborted caller signal expires the deadline immediately', () => {
    expect(createDeadline(10_000, AbortSignal.abort()).expired()).toBe(true)
  })

  test('a caller signal with no timeout still expires on abort', () => {
    const controller = new AbortController()
    const deadline = createDeadline(undefined, controller.signal)
    expect(deadline.expired()).toBe(false)
    controller.abort()
    expect(deadline.expired()).toBe(true)
  })

  test('timedOut is true only when the time budget ran out, not on a caller abort', () => {
    const controller = new AbortController()
    const deadline = createDeadline(10_000, controller.signal)
    expect(deadline.timedOut()).toBe(false)
    controller.abort()
    // The deadline is now expired — but the *caller* aborted it, not the clock.
    expect(deadline.expired()).toBe(true)
    expect(deadline.timedOut()).toBe(false)
  })

  test('timedOut is true once the timer fires', async () => {
    const deadline = createDeadline(50)
    expect(deadline.timedOut()).toBe(false)
    await delay(80)
    expect(deadline.timedOut()).toBe(true)
  })
})
