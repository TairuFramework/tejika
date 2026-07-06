import { setTimeout as delay } from 'node:timers/promises'

export type PollOptions = {
  timeoutMs?: number
  intervalMs?: number
}

/**
 * Poll `fn` until it returns a truthy value; resolve `undefined` on timeout.
 * Always calls `fn` at least once. The wait primitive under `PTYDriver.waitFor*`
 * and the daemon wait helpers, exported for consumers' own conditions.
 */
export async function poll<T>(
  fn: () => T | Promise<T>,
  options: PollOptions = {},
): Promise<T | undefined> {
  const { timeoutMs = 15_000, intervalMs = 100 } = options
  const end = Date.now() + timeoutMs
  while (true) {
    const result = await fn()
    if (result) return result
    if (Date.now() >= end) return undefined
    await delay(intervalMs)
  }
}
