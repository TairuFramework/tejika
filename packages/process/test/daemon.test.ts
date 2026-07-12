import { getEventListeners } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ClientMessage, ServerMessage, ServerTransportOf } from '@enkaku/protocol'
import { serve } from '@enkaku/server'
import { SocketTransport } from '@enkaku/socket'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type DaemonHandle, type RunDaemonOptions, runDaemon } from '../src/daemon.js'
import { DaemonAlreadyRunningError } from '../src/errors.js'
import { readLockRecord } from '../src/lock.js'
import { isSocketLive } from '../src/socket.js'
import type { PingProtocol } from './fixtures/protocol.js'

const APP = 'tejika-test'

let dir: string
let socketPath: string
let pidPath: string
const handles: Array<DaemonHandle> = []

const boot = async (over: Partial<RunDaemonOptions<PingProtocol>> = {}): Promise<DaemonHandle> => {
  const handle = await runDaemon<PingProtocol>({
    app: APP,
    socketPath,
    pidPath,
    handleSignals: false,
    serve: (transport) =>
      serve<PingProtocol>({ requireAuth: false, handlers: { ping: () => 'pong' }, transport }),
    ...over,
  })
  handles.push(handle)
  return handle
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-daemon-'))
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
})

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => {})))
  rmSync(dir, { recursive: true, force: true })
})

describe('runDaemon', () => {
  test('returns a handle and marks the lock ready', async () => {
    const handle = await boot()
    expect(handle.pid).toBe(process.pid)
    expect(handle.socketPath).toBe(socketPath)
    expect(handle.pidPath).toBe(pidPath)
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
    const record = readLockRecord(pidPath)
    expect(record?.ready).toBe(true)
    expect(record?.pid).toBe(process.pid)
  })

  test('refuses to boot beside a live daemon and leaves its socket alone', async () => {
    await boot()
    await expect(boot()).rejects.toBeInstanceOf(DaemonAlreadyRunningError)
    // The incumbent must survive untouched — this is the split-brain guarantee.
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
    expect(readLockRecord(pidPath)?.pid).toBe(process.pid)
  })

  test('two concurrent boots: exactly one wins, no live socket is unlinked', async () => {
    const results = await Promise.allSettled([boot(), boot()])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DaemonAlreadyRunningError)
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
  })

  test('reclaims a stale lockfile left by a dead process', async () => {
    // A pid far above any live process, so kill(pid, 0) yields ESRCH.
    writeFileSync(
      pidPath,
      JSON.stringify({ pid: 2 ** 22, socketPath, startedAt: Date.now(), ready: true }),
      'utf8',
    )
    const handle = await boot()
    expect(handle.pid).toBe(process.pid)
    expect(readLockRecord(pidPath)?.pid).toBe(process.pid)
  })

  test('reclaims a corrupt lockfile', async () => {
    writeFileSync(pidPath, 'garbage', 'utf8')
    await expect(boot()).resolves.toBeDefined()
    expect(readLockRecord(pidPath)?.pid).toBe(process.pid)
  })

  test('removes a stale socket file before binding', async () => {
    writeFileSync(socketPath, '', 'utf8')
    await expect(boot()).resolves.toBeDefined()
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
  })

  test('refuses a live socket held with no lockfile, without unlinking it', async () => {
    // A foreign listener owns the socket and there is no lockfile — so we win the
    // O_EXCL claim, but the live socket is not ours to steal. We must release the
    // lock and leave the socket alone.
    const foreign = createNetServer()
    await new Promise<void>((resolve) => foreign.listen(socketPath, resolve))
    try {
      await expect(boot()).rejects.toBeInstanceOf(DaemonAlreadyRunningError)
      await expect(isSocketLive(socketPath)).resolves.toBe(true)
      // The lock must have been released on the failed boot, not leaked.
      expect(readLockRecord(pidPath)).toBeNull()
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()))
    }
  })
})

describe('signal handling', () => {
  test('installs SIGTERM/SIGINT handlers when handleSignals is true and removes them on close', async () => {
    const beforeTerm = process.listenerCount('SIGTERM')
    const beforeInt = process.listenerCount('SIGINT')
    const handle = await boot({ handleSignals: true })
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1)
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1)
    await handle.close()
    // No listener may leak across daemons living in one process.
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm)
    expect(process.listenerCount('SIGINT')).toBe(beforeInt)
  })
})

describe('DaemonHandle.close', () => {
  test('removes the socket and the lockfile', async () => {
    const handle = await boot()
    await handle.close()
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('is idempotent', async () => {
    const handle = await boot()
    await handle.close()
    await expect(handle.close()).resolves.toBeUndefined()
  })

  test('runs onShutdown only after the server stops accepting', async () => {
    let acceptingDuringShutdown: boolean | undefined
    const handle = await boot({
      onShutdown: async () => {
        acceptingDuringShutdown = await isSocketLive(socketPath)
      },
    })
    await handle.close()
    expect(acceptingDuringShutdown).toBe(false)
  })

  test('closes even while a client connection is open', async () => {
    const handle = await boot()
    const { connectSocket } = await import('@enkaku/socket')
    const client = await connectSocket(socketPath)
    // server.close() drains connections, so close() must destroy this socket
    // itself rather than waiting on it.
    await expect(handle.close()).resolves.toBeUndefined()
    client.destroy()
  })

  test('cleans up even when onShutdown rejects, and rethrows', async () => {
    const handle = await boot({
      onShutdown: async () => {
        throw new Error('cleanup exploded')
      },
    })
    await expect(handle.close()).rejects.toThrow('cleanup exploded')
    expect(readLockRecord(pidPath)).toBeNull()
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
  })

  test('cleans up when onShutdown hangs past shutdownTimeoutMs', async () => {
    const handle = await boot({
      shutdownTimeoutMs: 50,
      onShutdown: () => new Promise<void>(() => {}),
    })
    await expect(handle.close()).rejects.toThrow(/timed out/i)
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('is triggered by an AbortSignal', async () => {
    const controller = new AbortController()
    await boot({ signal: controller.signal })
    controller.abort()
    await delay(200)
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
    expect(readLockRecord(pidPath)).toBeNull()
  })

  // The signal outlives the daemon — one process may boot and close several — so
  // the abort listener must not outlive the daemon that registered it.
  test('removes its abort listener on close', async () => {
    const controller = new AbortController()
    const handle = await boot({ signal: controller.signal })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    await handle.close()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})

describe('an already-aborted signal', () => {
  // Adding an `abort` listener to an ALREADY-aborted signal never fires, so this
  // used to boot a daemon that claimed the lock, bound the socket, and then simply
  // never closed. Aborting means "do not run", and the caller's own reason must
  // come back untouched rather than being reshaped into a timeout.
  test('refuses to boot, propagating the caller reason, and claims nothing', async () => {
    const caught = await boot({ signal: AbortSignal.abort() }).catch((err: unknown) => err)
    expect((caught as Error).name).toBe('AbortError')
    expect(readLockRecord(pidPath)).toBeNull()
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
  })
})

describe('connection handling', () => {
  test('a synchronously throwing serve kills one connection, not the daemon', async () => {
    const errors: Array<unknown> = []
    await boot({
      serve: () => {
        throw new Error('bad connection')
      },
      onError: (err) => errors.push(err),
    })
    const { connectSocket } = await import('@enkaku/socket')
    const client = await connectSocket(socketPath)
    await delay(50)
    client.destroy()
    expect(errors).toHaveLength(1)
    // The daemon must still be accepting.
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
  })

  test('createTransport receives the raw socket and its transport is used', async () => {
    let sawSocket = false
    await boot({
      createTransport: (socket) => {
        sawSocket = true
        return new SocketTransport<ClientMessage, ServerMessage>({
          socket,
        }) as unknown as ServerTransportOf<PingProtocol>
      },
    })
    const { connectSocket } = await import('@enkaku/socket')
    const client = await connectSocket(socketPath)
    await delay(50)
    client.destroy()
    expect(sawSocket).toBe(true)
  })
})
