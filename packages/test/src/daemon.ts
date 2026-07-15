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
 * Poll until the daemon reports `running`; resolve its pid. Throws on timeout:
 * an assertion that never sees the daemon running must fail loudly.
 * A daemon writes its presence record (the pidfile) BEFORE binding its socket — exclusion
 * is a separate, short-lived mutex — so a record on disk is not proof of readiness:
 * `booting` is deliberately not accepted here.
 */
export async function waitForDaemonRunning(options: WaitForDaemonOptions): Promise<number> {
  const { pidPath, timeoutMs = 5_000, intervalMs = 100 } = options
  const pid = await poll(
    async () => {
      // `app` is unused by getDaemonStatus when pidPath is explicit.
      const status = await getDaemonStatus({ app: '', pidPath })
      return status.state === 'running' ? status.pid : undefined
    },
    { timeoutMs, intervalMs },
  )
  if (pid == null) {
    throw new Error(`daemon did not report running within ${timeoutMs}ms (pidfile: ${pidPath})`)
  }
  return pid
}

/**
 * Poll until the presence record (the pidfile) is gone or names a dead process. Returns on
 * timeout instead of throwing: teardown tolerates a stuck daemon.
 */
export async function waitForDaemonStopped(options: WaitForDaemonOptions): Promise<void> {
  const { pidPath, timeoutMs = 5_000, intervalMs = 100 } = options
  await poll(
    async () => {
      const status = await getDaemonStatus({ app: '', pidPath })
      return status.state === 'not-running' || status.state === 'stale'
    },
    { timeoutMs, intervalMs },
  )
}
