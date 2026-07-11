import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, test } from 'vitest'
import { createDeadline } from '../src/deadline.js'

// There is no `expired()` on a Deadline, on purpose: it folded "the caller
// aborted" and "the clock ran out" back into one boolean, and telling those apart
// is what this type is for. `signal` cancels the wait; `timedOut()` decides which
// of the two it was. The assertions below are written in exactly those terms.
describe('createDeadline', () => {
  test('is unbounded with no timeout and no signal', () => {
    const deadline = createDeadline()
    expect(deadline.remaining()).toBe(Number.POSITIVE_INFINITY)
    expect(deadline.timedOut()).toBe(false)
    expect(deadline.signal.aborted).toBe(false)
  })

  test('counts down and runs out', async () => {
    const deadline = createDeadline(50)
    expect(deadline.remaining()).toBeGreaterThan(0)
    expect(deadline.remaining()).toBeLessThanOrEqual(50)
    await delay(80)
    expect(deadline.remaining()).toBe(0)
    expect(deadline.signal.aborted).toBe(true)
  })

  test('aborts when the caller signal aborts, before the timer fires', () => {
    const controller = new AbortController()
    const deadline = createDeadline(10_000, controller.signal)
    expect(deadline.signal.aborted).toBe(false)
    controller.abort()
    expect(deadline.signal.aborted).toBe(true)
    // Aborted, with the budget still nearly whole — and therefore NOT a timeout.
    expect(deadline.remaining()).toBeGreaterThan(0)
    expect(deadline.timedOut()).toBe(false)
  })

  test('an already-aborted caller signal aborts the deadline immediately', () => {
    const deadline = createDeadline(10_000, AbortSignal.abort())
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(false)
  })

  test('a caller signal with no timeout still aborts', () => {
    const controller = new AbortController()
    const deadline = createDeadline(undefined, controller.signal)
    expect(deadline.signal.aborted).toBe(false)
    controller.abort()
    expect(deadline.signal.aborted).toBe(true)
    // An unbounded budget can never time out, however hard it is aborted.
    expect(deadline.timedOut()).toBe(false)
  })

  test('timedOut is true only when the time budget ran out, not on a caller abort', () => {
    const controller = new AbortController()
    const deadline = createDeadline(10_000, controller.signal)
    expect(deadline.timedOut()).toBe(false)
    controller.abort()
    // The wait is over — but the *caller* ended it, not the clock.
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(false)
  })

  test('timedOut is true once the timer fires', async () => {
    const deadline = createDeadline(50)
    expect(deadline.timedOut()).toBe(false)
    await delay(80)
    expect(deadline.timedOut()).toBe(true)
  })
})
