import { getEventListeners } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ClientMessage, ServerMessage, ServerTransportOf } from '@enkaku/protocol'
import { serve } from '@enkaku/server'
import { SocketTransport } from '@enkaku/socket'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { type DaemonHandle, type RunDaemonOptions, runDaemon } from '../src/daemon.js'
import { DaemonAlreadyRunningError } from '../src/errors.js'
import { isSocketLive } from '../src/socket.js'
import * as stateModule from '../src/state.js'
import { readDaemonState } from '../src/state.js'
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
  test('returns a handle and marks the state ready', async () => {
    const handle = await boot()
    expect(handle.pid).toBe(process.pid)
    expect(handle.socketPath).toBe(socketPath)
    expect(handle.pidPath).toBe(pidPath)
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
    const record = readDaemonState(pidPath)
    expect(record?.ready).toBe(true)
    expect(record?.pid).toBe(process.pid)
  })

  test('refuses to boot beside a live daemon and leaves its socket alone', async () => {
    await boot()
    await expect(boot()).rejects.toBeInstanceOf(DaemonAlreadyRunningError)
    // The incumbent must survive untouched — this is the split-brain guarantee.
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
    expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
  })

  // Deterministic now. It used to depend on an O_EXCL claim landing first, with a
  // three-attempt reap-and-retry loop behind it; now every loser simply waits for the
  // winner to release, reads a `running` record, and concedes.
  test('concurrent boots: exactly one wins, the losers concede, no live socket is unlinked', async () => {
    const results = await Promise.allSettled([boot(), boot(), boot()])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const result of results.filter((r) => r.status === 'rejected')) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(DaemonAlreadyRunningError)
    }
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
    expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
    expect(readDaemonState(pidPath)?.ready).toBe(true)
  })

  test('reclaims a stale state file left by a dead process', async () => {
    // A pid far above any live process, so kill(pid, 0) yields ESRCH.
    writeFileSync(
      pidPath,
      JSON.stringify({ pid: 2 ** 22, socketPath, startedAt: Date.now(), ready: true }),
      'utf8',
    )
    const handle = await boot()
    expect(handle.pid).toBe(process.pid)
    expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
  })

  test('reclaims a corrupt state file', async () => {
    writeFileSync(pidPath, 'garbage', 'utf8')
    await expect(boot()).resolves.toBeDefined()
    expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
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
      expect(readDaemonState(pidPath)).toBeNull()
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()))
    }
  })

  // The failure paths that never reach `writeDaemonState` prove nothing about the record
  // removal: there was no record to begin with, so their `toBeNull()` passes trivially. This
  // one fails AFTER the record is on disk — the record is written before the bind, and the
  // bind is what fails — so it is the only test that can catch a boot that leaves a
  // `ready: false` corpse behind for the next booter to trip over.
  test('removes the record it wrote when the bind itself fails', async () => {
    // A `sun_path` longer than the AF_UNIX limit (~104 bytes on darwin): `listen` fails
    // with EINVAL, deterministically, with no dependence on timing or permissions.
    const tooLongSocketPath = join(dir, `${'s'.repeat(120)}.sock`)
    expect(Buffer.byteLength(tooLongSocketPath)).toBeGreaterThan(104)
    await expect(boot({ socketPath: tooLongSocketPath })).rejects.toThrow()
    expect(readDaemonState(pidPath)).toBeNull()
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
    expect(readDaemonState(pidPath)).toBeNull()
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
    expect(readDaemonState(pidPath)).toBeNull()
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
  })

  test('cleans up when onShutdown hangs past shutdownTimeoutMs', async () => {
    const handle = await boot({
      shutdownTimeoutMs: 50,
      onShutdown: () => new Promise<void>(() => {}),
    })
    await expect(handle.close()).rejects.toThrow(/timed out/i)
    expect(readDaemonState(pidPath)).toBeNull()
  })

  // The pid guard cannot scope a cleanup on its own: a replacement booted in the SAME
  // process carries the same pid, so a naive `record.pid === process.pid` check lets a
  // daemon that is still inside `onShutdown` delete its successor's socket and record —
  // leaving a live daemon invisible to every client and to `getDaemonStatus`, and
  // unstoppable. The window is real: the boot mutex is deliberately not held across
  // `onShutdown`, and `close()` is fired un-awaited by `onAbort`.
  test('does not clean up after a same-process daemon that replaced it mid-shutdown', async () => {
    let onShutdownEntered = (): void => {}
    const entered = new Promise<void>((resolve) => {
      onShutdownEntered = resolve
    })
    let releaseShutdown = (): void => {}
    const held = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })

    const first = await boot({
      onShutdown: async () => {
        onShutdownEntered()
        await held
      },
    })
    const closing = first.close()
    // The server has stopped accepting, so `server.close()` has already unlinked the
    // socket file; only the record is still on disk, and the mutex is free: exactly the
    // state a re-boot classifies as `stale`.
    await entered

    const second = await boot()
    expect(second.pid).toBe(process.pid)
    releaseShutdown()
    await closing

    // The replacement must still be serving, and still be findable.
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
    expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
    expect(readDaemonState(pidPath)?.ready).toBe(true)
  })

  // The window the test above does not reach: there, `releaseShutdown()` fires only after
  // `second` has *fully* booted, so the owner token is already published (even by the buggy
  // post-bind `stateOwners.set`) before `first`'s `cleanUp` ever runs. Here, `first`'s
  // `onShutdown` is released from INSIDE `second`'s claim write — the first `ready: false`
  // write after the claim — so `first`'s `cleanUp` races `second`'s own claim-to-bind
  // window. The pid guard alone cannot save `second`: both records carry `process.pid`. Only
  // an owner token published WITH the claim (not after the bind) closes the gap.
  test('does not let a same-process predecessor delete a claimed-but-not-yet-bound successor', async () => {
    let onShutdownEntered = (): void => {}
    const entered = new Promise<void>((resolve) => {
      onShutdownEntered = resolve
    })
    let releaseShutdown = (): void => {}
    const held = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })

    const first = await boot({
      onShutdown: async () => {
        onShutdownEntered()
        await held
      },
    })
    const closing = first.close()
    await entered

    const originalWriteDaemonState = stateModule.writeDaemonState
    let released = false
    const spy = vi.spyOn(stateModule, 'writeDaemonState').mockImplementation((path, state) => {
      originalWriteDaemonState(path, state)
      // The claim write: the record is `second`'s from this instant, but — this is exactly
      // the bug window — its owner token is not necessarily published yet.
      if (!released && !state.ready) {
        released = true
        releaseShutdown()
      }
    })

    try {
      const second = await boot()
      await closing

      expect(second.pid).toBe(process.pid)
      await expect(isSocketLive(socketPath)).resolves.toBe(true)
      expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
      expect(readDaemonState(pidPath)?.ready).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test('is triggered by an AbortSignal', async () => {
    const controller = new AbortController()
    await boot({ signal: controller.signal })
    controller.abort()
    await delay(200)
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
    expect(readDaemonState(pidPath)).toBeNull()
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
    expect(readDaemonState(pidPath)).toBeNull()
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
