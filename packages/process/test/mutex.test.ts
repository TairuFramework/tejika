import { spawn as spawnChild } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { serve } from '@enkaku/server'
import { acquireFileLock, TimeoutInterruption } from '@sozai/lock'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { type DaemonHandle, type RunDaemonOptions, runDaemon } from '../src/daemon.js'
import { isSocketLive } from '../src/socket.js'
import { spawnDaemon } from '../src/spawn.js'
import { readDaemonState, writeDaemonState } from '../src/state.js'
import { stopDaemon } from '../src/stop.js'
import type { PingProtocol } from './fixtures/protocol.js'

const APP = 'tejika-test'
const daemonEntry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
// nano-spawn merges `env` over process.env, so the child gets tsx without this process
// having to mutate its own NODE_OPTIONS.
const childEnv = { NODE_OPTIONS: '--import tsx' }

let dir: string
let socketPath: string
let pidPath: string
let lockPath: string
let logPath: string
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
  dir = mkdtempSync(join(tmpdir(), 'tejika-mutex-'))
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
  lockPath = `${pidPath}.lock`
  // Explicit, so the spawned daemon's log lands in the temp dir rather than the real data dir.
  logPath = join(dir, 'daemon.log')
})

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => {})))
  await stopDaemon({ app: APP, pidPath }).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

// A boot that cannot take the mutex has not found a running daemon — it has found someone
// who is booting or stopping one and will not let go. Distinct from
// DaemonAlreadyRunningError, and distinct on purpose.
test('a boot that cannot take the mutex throws TimeoutInterruption and claims nothing', async () => {
  const held = await acquireFileLock(lockPath, { timeout: 0 })
  try {
    await expect(boot({ lockTimeoutMs: 100 })).rejects.toBeInstanceOf(TimeoutInterruption)
    expect(readDaemonState(pidPath)).toBeNull()
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
  } finally {
    held.release()
  }
})

// The boot WAITS rather than racing. Before the mutex, a booter that found the lockfile
// held simply classified it and either threw or reaped it — there was nothing to wait on.
test('a boot blocked on the mutex proceeds as soon as it is released', async () => {
  const held = await acquireFileLock(lockPath, { timeout: 0 })
  const booting = boot({ lockTimeoutMs: 5_000 })
  let settled = false
  void booting.then(() => {
    settled = true
  })

  try {
    await delay(200)
    expect(settled).toBe(false)
  } finally {
    held.release()
  }

  const handle = await booting
  expect(handle.pid).toBe(process.pid)
  await expect(isSocketLive(socketPath)).resolves.toBe(true)
})

// A booter SIGKILLed between writing its `ready: false` record and binding leaves that
// record behind naming a live-looking pid. The old code waited out a ten-second boot grace
// before it dared reclaim it. This test writes exactly that abandoned `ready: false` record
// itself — no mutex is held here — and proves the boot reclaims it immediately, with no
// clock elapsing. The contested-mutex side of the property — that a boot actually waits out
// a lock someone else is holding — is covered by the two lock-contention tests above.
test('an abandoned booting record is taken immediately, with no grace period', async () => {
  // A live process that is not a daemon: exactly what a recycled pid looks like.
  const impostor = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  try {
    await new Promise<void>((resolve) => impostor.once('spawn', () => resolve()))
    writeDaemonState(pidPath, {
      pid: impostor.pid as number,
      socketPath,
      startedAt: Date.now(),
      ready: false,
    })

    const started = Date.now()
    const handle = await boot()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(handle.pid).toBe(process.pid)
    expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
    expect(readDaemonState(pidPath)?.ready).toBe(true)
  } finally {
    impostor.kill('SIGKILL')
  }
})

// The flagship property. A stop holds the mutex from the classification through the
// SIGTERM, the exit poll and the removal, so a boot racing it cannot slip in, find a
// half-dead daemon, and unlink a socket that is still being served.
//
// It is also the deadlock regression test. The daemon's own shutdown must RETAKE the
// mutex to clean up, and the stop is holding it — so the daemon takes it with a try-lock
// and never blocks. If it ever blocks instead, this stop cannot finish until
// `killTimeoutMs` expires and it SIGKILLs a daemon whose `onShutdown` never ran: the
// elapsed-time assertion is what catches that.
test('a stop and a boot never interleave', { timeout: 30_000 }, async () => {
  await spawnDaemon({ app: APP, entry: daemonEntry, socketPath, pidPath, logPath, env: childEnv })
  const childPID = readDaemonState(pidPath)?.pid as number
  expect(childPID).toBeGreaterThan(0)
  expect(childPID).not.toBe(process.pid)

  const started = Date.now()
  const stopping = stopDaemon({ app: APP, pidPath, killTimeoutMs: 5_000 })
  // Let the stop take the mutex first; the boot must then wait it out.
  await delay(50)
  const booting = boot({ lockTimeoutMs: 10_000 })

  try {
    const stopped = await stopping
    expect(stopped).toEqual({ stopped: true, pid: childPID })
    // A blocking cleanup in the daemon would make this ~5s (killTimeoutMs) or ~7s (plus the
    // SIGKILL grace) rather than a prompt SIGTERM shutdown.
    expect(Date.now() - started).toBeLessThan(3_000)

    const handle = await booting
    expect(handle.pid).toBe(process.pid)
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
    // The stop's removal must not have taken the new daemon's record with it: the record on
    // disk names the booter, and it is ready.
    expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
    expect(readDaemonState(pidPath)?.ready).toBe(true)
  } finally {
    // However this test resolves, `booting` must always be settled and its rejection
    // handled: an abandoned in-process boot could otherwise still be mid-flight when
    // `afterEach` runs, or surface as an unhandled rejection.
    await booting.catch(() => undefined)
  }
})
