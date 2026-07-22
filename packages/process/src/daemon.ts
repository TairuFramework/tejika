import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { dirname, resolve } from 'node:path'
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
 * Current owner of each `pidPath` WITHIN this process, one token per successful boot.
 *
 * FOOTGUN the token exists for: the pid guard alone cannot scope a cleanup, because two
 * daemons booted on one `pidPath` from one process share `process.pid` — so a shutting-down
 * daemon would read its successor's record, recognise its own pid, and delete a live daemon.
 * That successor is normal: the mutex is not held across `onShutdown`, and a re-boot in that
 * window classifies the closer as `stale` and takes over. The token tells "my record" from "a
 * sibling boot's record with my pid"; `startedAt` cannot (two boots can share a ms).
 *
 * KEYED ON THE RESOLVED PATH, like `@sozai/lock`'s own queue: `./app.pid` and `/abs/app.pid`
 * are one file, two strings — keyed raw, a predecessor's guard passes against a live successor.
 */
const stateOwners = new Map<string, symbol>()

/**
 * Remove our socket and record, under the boot mutex if it can be taken INSTANTLY.
 *
 * FOOTGUN: a try-lock, NEVER a waiting acquire. `stopDaemon` holds the mutex through its whole
 * SIGTERM-and-poll, waiting for THIS process to exit — so blocking here would make every stop
 * burn `killTimeoutMs` then SIGKILL a daemon whose `onShutdown` never finished.
 *
 * A failed try-lock is safe: the holder is either a stopper waiting for us (binds nothing) or
 * a booter that classified us stale and re-claimed — whose fresh record the two guards refuse
 * to touch (on-disk pid rejects a foreign process, owner token rejects another boot of ours).
 * The lock only narrows the read-act window.
 */
async function cleanUp(
  lockPath: string,
  pidPath: string,
  ownerKey: string,
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
    if (stateOwners.get(ownerKey) === owner && readDaemonState(pidPath)?.pid === process.pid) {
      safeRemove(socketPath)
      removeDaemonState(pidPath)
    }
  } finally {
    // Only ever our own entry: a successor's claim must survive our shutdown.
    if (stateOwners.get(ownerKey) === owner) stateOwners.delete(ownerKey)
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
  // The `stateOwners` key: one identity per FILE, not per spelling of its path.
  const ownerKey = resolve(pidPath)
  const lockPath = opts.lockPath ?? getLockPathFor(pidPath)
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const handleSignals = opts.handleSignals !== false

  // An already-aborted signal used to be ignored (its `abort` never fires), so the daemon
  // booted and never closed. Aborting means "do not run" — say so before claiming anything.
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

  // Classification through bind runs under the BOOT mutex — released the moment the socket
  // binds and the record is `ready`, since holding it for the daemon's life would block every
  // stop and status read.
  //
  // `claimedState`, not a re-read of the on-disk pid, tells the catch whether the record is
  // ours: several `runDaemon` calls racing one pidPath in one process share `process.pid`, so
  // a pid compare would let a loser delete the winner's record. The flag never authorises
  // deleting a foreign record; at worst it unlinks an already-gone path.
  const owner = Symbol('daemon-owner')
  let claimedState = false
  try {
    const status = await classifyState(readDaemonState(pidPath))
    if (status.state === 'running' || status.state === 'running-not-owned') {
      throw new DaemonAlreadyRunningError(status.pid, socketPath)
    }
    // `not-running`, `stale`, `booting` are all free to take. `booting` is load-bearing: a
    // `ready: false` record is only written inside this section by a mutex holder — we hold
    // it, so its writer does not, so it is abandoned. This proof replaced the old ten-second
    // boot grace, a guess that failed both ways (too short: steal a slow booter's socket, a
    // split brain; too long: block a legitimate boot behind a corpse).

    if (existsSync(socketPath)) {
      if (await isSocketLive(socketPath)) {
        // A foreign daemon holds the socket with no state file. We hold the mutex but its
        // socket is not ours to steal. Its pid is unknown, so the error carries none rather
        // than the old `-1` that a consumer passing `err.pid` to `process.kill` would fire.
        throw new DaemonAlreadyRunningError(undefined, socketPath)
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
    // With the claim, NOT after the bind: from the instant the record is ours, no earlier
    // boot of this process may remove it. Publishing later leaves the claim-to-bind window
    // unguarded — a predecessor in `onShutdown` would read our fresh record, see no owner,
    // and delete it.
    stateOwners.set(ownerKey, owner)

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600)
        resolve()
      })
    })

    writeDaemonState(pidPath, { ...claimed, ready: true })
  } catch (err) {
    server.close(() => {})
    // Only our own record: a failure before `writeDaemonState` leaves the prior stale record,
    // which the next booter reaps under this mutex.
    if (claimedState) removeDaemonState(pidPath)
    if (stateOwners.get(ownerKey) === owner) stateOwners.delete(ownerKey)
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
        await cleanUp(lockPath, pidPath, ownerKey, socketPath, owner)
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
