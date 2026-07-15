import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getDataDir, getPIDPath, getSocketPath } from '@tejika/env'
import spawn from 'nano-spawn'
import { createDeadline, type Deadline } from './deadline.js'
import { DaemonBootError } from './errors.js'
import { waitForSocket } from './socket.js'
import { readDaemonState } from './state.js'
import { classifyState } from './status.js'

export type SpawnDaemonOptions = {
  app: string
  /** Entry script run with `node`. Always receives `--socket-path <path>` and `--pid-path <path>`. */
  entry: string
  args?: Array<string>
  socketPath?: string
  pidPath?: string
  logPath?: string
  /** Merged over `process.env` for the child. */
  env?: Record<string, string>
  /** Budget for the socket wait. Ignored when `deadline` is given. Default 3000ms. */
  timeoutMs?: number
  deadline?: Deadline
  signal?: AbortSignal
}

/** Never settles. Used to withdraw a boot-crash claim we decided not to make. */
function pending(): Promise<never> {
  return new Promise<never>(() => {})
}

/**
 * Did SOMEONE ELSE claim the state file? A child exiting is only a boot failure if it is the
 * whole story. Flagship scenario: two CLIs cold-start one daemon, one wins the mutex and binds,
 * the loser throws `DaemonAlreadyRunningError` and exits nonzero before the socket wait's first
 * poll. That is a loser conceding, not a crash — say nothing and let the wait run against the
 * winner's socket.
 */
async function anotherDaemonHoldsState(
  pidPath: string,
  childPID: number | undefined,
): Promise<boolean> {
  const state = readDaemonState(pidPath)
  if (state == null || state.pid === childPID) return false
  const status = await classifyState(state)
  // `booting` is not `running` — but it IS a live process that has claimed the state
  // file, and its socket is exactly what the wait below is waiting for.
  return status.state === 'booting' || status.state === 'running'
}

/**
 * Spawn the detached daemon and wait until its socket accepts connections.
 * The wait races the child's exit, so a boot crash surfaces the child's error
 * and a pointer to `logPath` immediately rather than after the full timeout.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<void> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  // Defaulted like `socketPath` and passed to the child UNCONDITIONALLY. Left undefined, the
  // concession check below went inert in the default config (child still locked, but the parent
  // had no path to read) and every losing child became a `DaemonBootError`. Explicit also avoids
  // a parent/child divergence: env's PID_PATH override could resolve differently in the child.
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  const logPath = opts.logPath ?? join(getDataDir(opts.app), 'daemon.log')
  const deadline = opts.deadline ?? createDeadline(opts.timeoutMs ?? 3000, opts.signal)

  mkdirSync(dirname(logPath), { recursive: true })
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })

  const args = [opts.entry, '--socket-path', socketPath, '--pid-path', pidPath]
  if (opts.args != null) args.push(...opts.args)

  const logFD = openSync(logPath, 'a')
  const subprocess = spawn('node', args, {
    detached: true,
    stdio: ['ignore', logFD, logFD],
    env: opts.env,
  })

  const bootFailed = async (message: string, cause: unknown): Promise<never> => {
    const childPID = await subprocess.nodeChildProcess.then(
      (child) => child.pid,
      () => undefined,
    )
    if (await anotherDaemonHoldsState(pidPath, childPID)) return await pending()
    throw new DaemonBootError(message, { logPath, cause })
  }

  // The child outlives us; its promise settles only if it dies. Racing it against
  // the socket wait turns a boot crash into an immediate, specific error rather
  // than an opaque timeout — unless another daemon has taken the lock, in which
  // case this exit is not a crash and must not end the wait.
  const exited: Promise<never> = subprocess.then(
    (result) => bootFailed('daemon exited during boot', result),
    (cause: unknown) => bootFailed('daemon failed to start', cause),
  )

  try {
    // Dereference the child so it can outlive us.
    const child = await subprocess.nodeChildProcess
    child.unref()
  } catch {
    // The child never started at all — `node` could not be executed. Throwing the
    // raw errno from here would abandon `exited`, whose rejection nothing has
    // handled yet: an unhandled rejection, which is fatal in Node. `exited` already
    // carries this same failure as a `DaemonBootError`, so say nothing and let the
    // race below surface it, with the log path attached, like every other boot
    // failure.
  } finally {
    // The child holds its own copy of the descriptor; release ours.
    closeSync(logFD)
  }

  // `Promise.race` abandons the loser but cannot cancel it. Without this, a boot
  // crash surfaces in milliseconds while the abandoned socket wait keeps polling
  // on ref'd 50ms timers until the deadline — pinning the process alive for the
  // whole budget and defeating the point of failing fast.
  const abandon = new AbortController()
  const waitDeadline: Deadline = {
    remaining: () => deadline.remaining(),
    // Only the shared budget running out is a timeout. Abandoning the wait is
    // neither a timeout nor a caller abort — nobody reads its rejection. So the
    // abandon signal belongs in `signal`, which is what actually cancels the wait,
    // and nowhere else.
    timedOut: () => deadline.timedOut(),
    signal: AbortSignal.any([deadline.signal, abandon.signal]),
  }

  try {
    await Promise.race([waitForSocket(socketPath, { deadline: waitDeadline }), exited])
  } finally {
    // Once the race settles, the loser must be released and must not become an
    // unhandled rejection.
    abandon.abort()
    exited.catch(() => {})
  }
}
