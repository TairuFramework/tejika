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
import { getPIDPath, getSocketPath } from '@tejika/env'
import { DaemonAlreadyRunningError } from './errors.js'
import { claimDaemonLock, type DaemonLock, readLockRecord, reapLockFile } from './lock.js'
import { isSocketLive, safeRemove } from './socket.js'
import { classifyRecord, DEFAULT_BOOT_GRACE_MS } from './status.js'

const CLAIM_ATTEMPTS = 3
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

export type RunDaemonOptions<Protocol extends ProtocolDefinition> = {
  app: string
  socketPath?: string
  pidPath?: string
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
  bootGraceMs?: number
}

export type DaemonHandle = {
  pid: number
  socketPath: string
  pidPath: string
  /** Idempotent: stop accepting, destroy connections, run onShutdown, clean up. */
  close(): Promise<void>
}

/**
 * Take the exclusive lock, reaping a stale one. Losers never unlink anything —
 * that is what closes the split-brain race: a process that did not win the
 * O_EXCL claim has no licence to touch the socket file.
 */
async function claimOrThrow(
  pidPath: string,
  socketPath: string,
  bootGraceMs: number,
): Promise<DaemonLock> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const result = claimDaemonLock(pidPath, {
      pid: process.pid,
      socketPath,
      startedAt: Date.now(),
      ready: false,
    })
    if ('lock' in result) return result.lock

    const status = await classifyRecord(result.conflict, { bootGraceMs, now: Date.now() })
    if (status.state !== 'stale' && status.state !== 'not-running') {
      throw new DaemonAlreadyRunningError(status.pid, socketPath)
    }
    // Stale (or corrupt): reap and retry, but reap ONLY the exact file we
    // classified. `result.inode` was captured when the conflict was read; passing
    // it makes `reapLockFile` no-op if a racer reclaimed the lockfile across the
    // await above — we then loop, re-read the racer's fresh record, and either
    // win the next claim or throw DaemonAlreadyRunningError against it. Reaping
    // without the inode would delete the racer's live claim and split-brain one
    // layer down. A null inode means the file already vanished; just retry.
    if (result.inode != null) reapLockFile(pidPath, result.inode)
  }
  throw new DaemonAlreadyRunningError(readLockRecord(pidPath)?.pid ?? -1, socketPath)
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
 * Boot a daemon in the current process. Claims an exclusive lock BEFORE binding,
 * so two concurrent boots cannot both pass a liveness check and unlink each
 * other's socket. Returns a handle; signal handlers are installed by default.
 */
export async function runDaemon<Protocol extends ProtocolDefinition>(
  opts: RunDaemonOptions<Protocol>,
): Promise<DaemonHandle> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const handleSignals = opts.handleSignals !== false

  // 0o700 before the bind: the socket is unreachable during the window between
  // listen() and chmod(), rather than briefly world-accessible.
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 })

  const lock = await claimOrThrow(pidPath, socketPath, opts.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS)

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

  // Everything from the socket cleanup through the bind runs under the claimed
  // lock. If any of it throws — a foreign daemon on the socket, an EADDRINUSE
  // from a lost lockfile race, an EACCES on bind — we must release the lock: no
  // handle was returned, so the caller has no other way to free it, and a leaked
  // `ready: false` record blocks legitimate boots until bootGraceMs elapses.
  try {
    if (existsSync(socketPath)) {
      if (await isSocketLive(socketPath)) {
        // A foreign daemon holds the socket without a lockfile. We hold the lock,
        // but its socket is not ours to steal.
        throw new DaemonAlreadyRunningError(-1, socketPath)
      }
      safeRemove(socketPath)
    }

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600)
        resolve()
      })
    })
  } catch (err) {
    server.close(() => {})
    lock.release()
    throw err
  }
  // The boot promise has settled; its `reject` would be a no-op for later errors.
  server.removeAllListeners('error')
  server.on('error', (err) => opts.onError?.(err))

  lock.markReady()

  let closing: Promise<void> | undefined

  // Declared before `close` so the handler is in scope when `close` removes it.
  const onSignal = (): void => {
    void close().then(
      () => process.exit(0),
      (err) => {
        console.error(err)
        process.exit(1)
      },
    )
  }

  const close = async (): Promise<void> => {
    if (closing != null) return await closing
    closing = (async (): Promise<void> => {
      if (handleSignals) {
        process.off('SIGTERM', onSignal)
        process.off('SIGINT', onSignal)
      }
      try {
        await closeServer(server, connections)
        if (opts.onShutdown != null) await withTimeout(opts.onShutdown(), shutdownTimeoutMs)
      } finally {
        // Always: a rejected or timed-out onShutdown must not leak the socket
        // file or the lock.
        safeRemove(socketPath)
        lock.release()
      }
    })()
    return await closing
  }

  if (handleSignals) {
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
  }
  opts.signal?.addEventListener('abort', () => void close().catch((err) => opts.onError?.(err)), {
    once: true,
  })

  return { pid: process.pid, socketPath, pidPath, close }
}
