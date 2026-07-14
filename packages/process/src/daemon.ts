import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type {
  ClientMessage,
  ProtocolDefinition,
  ServerMessage,
  ServerTransportOf,
} from '@enkaku/protocol'
import type { Server } from '@enkaku/server'
import { SocketTransport } from '@enkaku/socket'
import { acquireFileLock, type FileLock } from '@sozai/lock'
import { getPIDPath, getSocketPath } from '@tejika/env'
import { DaemonAlreadyRunningError } from './errors.js'
import { isSocketLive, safeRemove } from './socket.js'
import {
  type DaemonState,
  getLockPathFor,
  readDaemonState,
  removeDaemonState,
  writeDaemonState,
} from './state.js'
import { classifyState } from './status.js'

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_LOCK_TIMEOUT_MS = 10_000

export type RunDaemonOptions<Protocol extends ProtocolDefinition> = {
  app: string
  socketPath?: string
  pidPath?: string
  /** Boot mutex path. Default `${pidPath}.lock`. */
  lockPath?: string
  /**
   * Budget for taking the boot mutex. Default 10000ms — a concurrent `stopDaemon` can
   * hold it for `killTimeoutMs` plus the SIGKILL grace, and waiting that out is correct.
   */
  lockTimeoutMs?: number
  /** Build the Enkaku server for one accepted connection's transport. */
  serve: (transport: ServerTransportOf<Protocol>) => Server<Protocol>
  /**
   * Build the per-connection transport from the raw socket. Defaults to
   * `new SocketTransport({ socket })`. Lets a consumer wrap the connection
   * stream (e.g. sign messages) before the transport exists.
   */
  createTransport?: (socket: Socket) => ServerTransportOf<Protocol>
  /** Optional async cleanup, invoked after the server stops accepting. */
  onShutdown?: () => Promise<void>
  /** Install SIGTERM/SIGINT handlers that close, then exit. Default true. */
  handleSignals?: boolean
  /** Bound on `onShutdown`. Default 5000ms. */
  shutdownTimeoutMs?: number
  /** Aborting closes the daemon. */
  signal?: AbortSignal
  /** Post-boot server errors and per-connection `serve` failures. */
  onError?: (err: unknown) => void
}

export type DaemonHandle = {
  pid: number
  socketPath: string
  pidPath: string
  /** Idempotent: stop accepting, destroy connections, run onShutdown, clean up. */
  close(): Promise<void>
}

async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`onShutdown timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  try {
    await Promise.race([work, timeout])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

/**
 * Stop accepting, then destroy live connections so `close()` can settle.
 * `server.close()` drains existing connections before firing its callback, so
 * destroying must happen after the call and before the await, or a connected
 * client wedges shutdown forever.
 */
async function closeServer(server: NetServer, connections: Set<Socket>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err == null ? resolve() : reject(err)))
  })
  for (const socket of connections) socket.destroy()
  connections.clear()
  await closed
}

/**
 * The current owner of each `pidPath` WITHIN this process, as a token unique to one
 * successful boot.
 *
 * The pid guard alone cannot scope a cleanup to the boot that owns it: two daemons booted
 * on the same `pidPath` from ONE process share `process.pid`, so a shutting-down daemon
 * would happily read its successor's record, recognise its own pid, and delete a live
 * daemon's socket and record. That successor is not exotic — the mutex is deliberately not
 * held across `onShutdown` (up to `shutdownTimeoutMs`), and in that window a re-boot on the
 * same path classifies the closing daemon as `stale` (its socket no longer accepts) and
 * legitimately takes over. The token distinguishes "my own record" from "a sibling boot's
 * record that happens to carry my pid"; a whole-record comparison would not, since two boots
 * in one process can share a `startedAt` millisecond.
 */
const stateOwners = new Map<string, symbol>()

/**
 * Remove our socket and our state record, under the boot mutex when it can be taken
 * INSTANTLY.
 *
 * A try-lock, never a waiting acquire: `stopDaemon` holds the mutex for its whole
 * SIGTERM-and-poll, and what it is waiting for is this very process to exit. Blocking here
 * would make every stop wait out `killTimeoutMs` and then SIGKILL a daemon whose
 * `onShutdown` never finished.
 *
 * A failed try-lock means someone else holds the mutex, and both possibilities are safe:
 * a stopper waiting for us (it binds nothing, so our own cleanup is uncontended), or a
 * booter that found our socket closed, classified us stale, and claimed the state file —
 * whose fresh record the guards below refuse to touch. Two guards, one per direction:
 * the on-disk pid rejects a FOREIGN process's record, and the owner token rejects another
 * boot from THIS process. The lock only narrows the window between reading and acting.
 */
async function cleanUp(
  lockPath: string,
  pidPath: string,
  socketPath: string,
  owner: symbol,
): Promise<void> {
  let lock: FileLock | null = null
  try {
    lock = await acquireFileLock(lockPath, { timeout: 0 })
  } catch {
    // Held by someone else. Fall through: the guards below still apply.
  }
  try {
    if (stateOwners.get(pidPath) === owner && readDaemonState(pidPath)?.pid === process.pid) {
      safeRemove(socketPath)
      removeDaemonState(pidPath)
    }
  } finally {
    // Only ever our own entry: a successor's claim must survive our shutdown.
    if (stateOwners.get(pidPath) === owner) stateOwners.delete(pidPath)
    lock?.release()
  }
}

/**
 * Boot a daemon in the current process. Claims the boot mutex BEFORE binding,
 * so two concurrent boots cannot both pass a liveness check and unlink each
 * other's socket. Returns a handle; signal handlers are installed by default.
 */
export async function runDaemon<Protocol extends ProtocolDefinition>(
  opts: RunDaemonOptions<Protocol>,
): Promise<DaemonHandle> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  const lockPath = opts.lockPath ?? getLockPathFor(pidPath)
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const handleSignals = opts.handleSignals !== false

  // An already-aborted signal used to be ignored silently: adding an `abort`
  // listener to it never fires, so the daemon booted, claimed the lock, bound the
  // socket, and simply never closed. Aborting means "do not run" — say so before
  // claiming anything, and propagate the caller's own reason untouched.
  if (opts.signal?.aborted === true) throw opts.signal.reason

  // 0o700 before the bind: the socket is unreachable during the window between
  // listen() and chmod(), rather than briefly world-accessible.
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 })

  const lock = await acquireFileLock(lockPath, {
    timeout: opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    signal: opts.signal,
  })

  const connections = new Set<Socket>()
  const server = createServer((socket) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
    try {
      const transport =
        opts.createTransport?.(socket) ??
        (new SocketTransport<ClientMessage, ServerMessage>({
          socket,
        }) as unknown as ServerTransportOf<Protocol>)
      const handler = opts.serve(transport)
      socket.once('close', () => void handler.dispose())
    } catch (err) {
      // One bad connection must not take the daemon down.
      opts.onError?.(err)
      socket.destroy()
    }
  })

  // Everything from the classification through the bind runs under the boot mutex. It is
  // a BOOT mutex, not a presence record: it is released the moment the socket is bound
  // and the record says `ready`, because holding it for the daemon's lifetime would block
  // every stop and every status read behind a live daemon.
  //
  // `claimedState` — not a re-read of the pid off disk — is what tells the catch below
  // whether the record on disk is ours to remove. Comparing pids there would be wrong:
  // several `runDaemon` calls racing the SAME pidPath from inside one process (exactly
  // what the concurrent-boot tests do) all share `process.pid`, so a loser that never
  // wrote anything would misidentify the winner's live record as its own and delete it.
  // The flag is sound without claiming exclusivity the mutex does not provide: a closing
  // daemon's `cleanUp` can still REMOVE a record without the mutex (its try-lock may fail
  // — that is the design), but a removal can only turn our own record into no record. It
  // can never put a foreign record under our flag, so the flag never authorises deleting
  // one; at worst `removeDaemonState` unlinks a path that is already gone.
  const owner = Symbol('daemon-owner')
  let claimedState = false
  try {
    const status = await classifyState(readDaemonState(pidPath))
    if (status.state === 'running' || status.state === 'running-not-owned') {
      throw new DaemonAlreadyRunningError(status.pid, socketPath)
    }
    // `not-running`, `stale` and `booting` are ALL free to take. `booting` is the
    // load-bearing one: a `ready: false` record is only ever written inside this section,
    // by a process holding this mutex. We hold it, so its writer does not, so it is
    // abandoned. That is a proof — and it is what replaced the old ten-second boot grace,
    // a guess that failed in both directions (too short: steal a live-but-slow booter's
    // socket, a split brain; too long: block a legitimate boot behind a corpse).

    if (existsSync(socketPath)) {
      if (await isSocketLive(socketPath)) {
        // A foreign daemon holds the socket without a state file. We hold the mutex, but
        // its socket is not ours to steal.
        throw new DaemonAlreadyRunningError(-1, socketPath)
      }
      safeRemove(socketPath)
    }

    const claimed: DaemonState = {
      pid: process.pid,
      socketPath,
      startedAt: Date.now(),
      ready: false,
    }
    writeDaemonState(pidPath, claimed)
    claimedState = true

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600)
        resolve()
      })
    })

    writeDaemonState(pidPath, { ...claimed, ready: true })
    // Under the mutex, and only once the record on disk is ours and ready: from here on
    // WE are the boot that owns `pidPath` in this process, and any earlier boot still
    // running its `onShutdown` must no longer clean up after us.
    stateOwners.set(pidPath, owner)
  } catch (err) {
    server.close(() => {})
    // Only ever our own record: a failure BEFORE `writeDaemonState` leaves whatever stale
    // record was already on disk, which is not ours to remove — the next booter reaps it
    // under this same mutex.
    if (claimedState) removeDaemonState(pidPath)
    throw err
  } finally {
    lock.release()
  }

  // The boot promise has settled; its `reject` would be a no-op for later errors.
  server.removeAllListeners('error')
  server.on('error', (err) => opts.onError?.(err))

  let closing: Promise<void> | undefined

  // Declared before `close` so the handlers are in scope when `close` removes them.
  const onSignal = (): void => {
    void close().then(
      () => process.exit(0),
      (err) => {
        console.error(err)
        process.exit(1)
      },
    )
  }

  const onAbort = (): void => {
    void close().catch((err: unknown) => opts.onError?.(err))
  }

  const close = async (): Promise<void> => {
    if (closing != null) return await closing
    closing = (async (): Promise<void> => {
      if (handleSignals) {
        process.off('SIGTERM', onSignal)
        process.off('SIGINT', onSignal)
      }
      // The caller's signal outlives this daemon — several may boot and close in
      // one process — so the listener must not outlive the daemon that added it.
      opts.signal?.removeEventListener('abort', onAbort)
      try {
        await closeServer(server, connections)
        if (opts.onShutdown != null) await withTimeout(opts.onShutdown(), shutdownTimeoutMs)
      } finally {
        // Always: a rejected or timed-out onShutdown must not leak the socket file or the
        // state record.
        await cleanUp(lockPath, pidPath, socketPath, owner)
      }
    })()
    return await closing
  }

  if (handleSignals) {
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  return { pid: process.pid, socketPath, pidPath, close }
}
