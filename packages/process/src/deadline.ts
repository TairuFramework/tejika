/** A shared time budget: a countdown plus the signal that fires at zero. */
export type Deadline = {
  /** Milliseconds left, or `Infinity` when unbounded. Never negative. */
  remaining(): number
  expired(): boolean
  signal: AbortSignal
}

/**
 * Compose a caller's `AbortSignal` with a timeout into one budget that threads
 * through every phase of an operation, so the phases compose instead of each
 * imposing its own independent timeout.
 */
export function createDeadline(timeoutMs?: number, signal?: AbortSignal): Deadline {
  const signals: Array<AbortSignal> = []
  if (signal != null) signals.push(signal)
  if (timeoutMs != null) signals.push(AbortSignal.timeout(timeoutMs))

  // AbortSignal.any([]) is never aborted, which is exactly the unbounded case.
  const combined = AbortSignal.any(signals)
  const end = timeoutMs == null ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs

  const remaining = (): number =>
    end === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.max(0, end - Date.now())

  return {
    remaining,
    expired: (): boolean => combined.aborted || remaining() === 0,
    signal: combined,
  }
}
