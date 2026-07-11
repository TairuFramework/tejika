/**
 * A shared time budget: a countdown plus the signal that fires at zero.
 *
 * There is deliberately no `expired()`. It existed, nothing in the library ever
 * called it, and every waiter that looked like it might was in fact composing
 * `signal` (for cancellation) with `timedOut()` (for the verdict). Keeping a
 * "should I stop waiting?" predicate that folds an abort and a timeout back into
 * one boolean only invites the bug this type exists to prevent: telling the two
 * apart is the whole point, and `timedOut()` is the only sanctioned arbiter.
 */
export type Deadline = {
  /** Milliseconds left, or `Infinity` when unbounded. Never negative. */
  remaining(): number
  /**
   * True ONLY when the time budget itself ran out, never for a caller abort.
   * Reads the timeout signal's own `aborted` state, not the `remaining()`
   * millisecond proxy, so it is exact at the deadline tick. This is the arbiter
   * that lets a waiter throw a timeout for budget exhaustion yet propagate the
   * caller's `AbortError` for a cancellation.
   */
  timedOut(): boolean
  signal: AbortSignal
}

/**
 * Compose a caller's `AbortSignal` with a timeout into one budget that threads
 * through every phase of an operation, so the phases compose instead of each
 * imposing its own independent timeout.
 */
export function createDeadline(timeoutMs?: number, signal?: AbortSignal): Deadline {
  const timeout = timeoutMs != null ? AbortSignal.timeout(timeoutMs) : null
  const signals: Array<AbortSignal> = []
  if (signal != null) signals.push(signal)
  if (timeout != null) signals.push(timeout)

  // AbortSignal.any([]) is never aborted, which is exactly the unbounded case.
  const combined = AbortSignal.any(signals)
  const end = timeoutMs == null ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs

  const remaining = (): number =>
    end === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.max(0, end - Date.now())

  return {
    remaining,
    // `timeout.aborted` is the ground truth for "the clock ran out"; the
    // `remaining() === 0` disjunct only covers a caller reading it a hair early.
    timedOut: (): boolean => (timeout?.aborted ?? false) || remaining() === 0,
    signal: combined,
  }
}
