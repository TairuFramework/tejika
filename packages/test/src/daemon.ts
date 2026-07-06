import { getDaemonStatus } from '@tejika/process'
import { poll } from './poll.js'

export type WaitForDaemonOptions = {
  /**
   * Explicit pidfile path: a test profile's env overrides are not visible to
   * this process's own `@tejika/env` resolvers, so derive it from the
   * profile dir (e.g. `join(profile.dir, `${app}.pid`)`).
   */
  pidPath: string
  timeoutMs?: number
  intervalMs?: number
}

/**
 * Poll until the pidfile names a live process; resolve its pid. Throws on
 * timeout: an assertion that never sees the daemon running must fail loudly.
 * (Daemons write their pidfile only after their socket accepts connections,
 * so a connected client does not guarantee the pid is on disk yet.)
 */
export async function waitForDaemonRunning(options: WaitForDaemonOptions): Promise<number> {
  const { pidPath, timeoutMs = 5_000, intervalMs = 100 } = options
  const pid = await poll(
    () => {
      // `app` is unused by getDaemonStatus when pidPath is explicit.
      const status = getDaemonStatus({ app: '', pidPath })
      return status.running ? status.pid : undefined
    },
    { timeoutMs, intervalMs },
  )
  if (pid == null) {
    throw new Error(`daemon did not report running within ${timeoutMs}ms (pidfile: ${pidPath})`)
  }
  return pid
}

/**
 * Poll until the pidfile is gone or names a dead process. Returns on timeout
 * instead of throwing: teardown tolerates a stuck daemon (it will fail its
 * next write and exit on its own), an assertion should not hard-fail cleanup.
 */
export async function waitForDaemonStopped(options: WaitForDaemonOptions): Promise<void> {
  const { pidPath, timeoutMs = 5_000, intervalMs = 100 } = options
  await poll(() => !getDaemonStatus({ app: '', pidPath }).running, { timeoutMs, intervalMs })
}
