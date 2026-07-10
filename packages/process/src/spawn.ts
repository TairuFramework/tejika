import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getDataDir, getSocketPath } from '@tejika/env'
import spawn from 'nano-spawn'
import { createDeadline, type Deadline } from './deadline.js'
import { DaemonBootError } from './errors.js'
import { waitForSocket } from './socket.js'

export type SpawnDaemonOptions = {
  app: string
  /** Entry script run with `node`. Receives `--socket-path <path>`, and `--pid-path <path>` when given. */
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

/**
 * Spawn the detached daemon and wait until its socket accepts connections.
 * The wait races the child's exit, so a boot crash surfaces the child's error
 * and a pointer to `logPath` immediately rather than after the full timeout.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<void> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const logPath = opts.logPath ?? join(getDataDir(opts.app), 'daemon.log')
  const deadline = opts.deadline ?? createDeadline(opts.timeoutMs ?? 3000, opts.signal)

  mkdirSync(dirname(logPath), { recursive: true })
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })

  const args = [opts.entry, '--socket-path', socketPath]
  if (opts.pidPath != null) args.push('--pid-path', opts.pidPath)
  if (opts.args != null) args.push(...opts.args)

  const logFD = openSync(logPath, 'a')
  const subprocess = spawn('node', args, {
    detached: true,
    stdio: ['ignore', logFD, logFD],
    env: opts.env,
  })

  // The child outlives us; its promise settles only if it dies. Racing it against
  // the socket wait turns a boot crash into an immediate, specific error rather
  // than an opaque timeout.
  const exited: Promise<never> = subprocess.then(
    (result) => {
      throw new DaemonBootError('daemon exited during boot', { logPath, cause: result })
    },
    (cause: unknown) => {
      throw new DaemonBootError('daemon failed to start', { logPath, cause })
    },
  )

  try {
    // Dereference the child so it can outlive us.
    const child = await subprocess.nodeChildProcess
    child.unref()
  } finally {
    // The child holds its own copy of the descriptor; release ours.
    closeSync(logFD)
  }

  try {
    await Promise.race([waitForSocket(socketPath, { deadline }), exited])
  } finally {
    // Once the race settles, the loser must not become an unhandled rejection.
    exited.catch(() => {})
  }
}
