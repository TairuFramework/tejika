import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import spawn from 'nano-spawn'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createDeadline } from '../src/deadline.js'
import { DaemonBootError } from '../src/errors.js'
import type { SpawnedDaemon } from '../src/index.js'
import { spawnDaemon } from '../src/spawn.js'
import { readDaemonState } from '../src/state.js'
import { stopDaemon } from '../src/stop.js'

const APP = 'tejika-test'
const daemonEntry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
const crashEntry = fileURLToPath(new URL('./fixtures/crash-entry.ts', import.meta.url))
const exitZeroEntry = fileURLToPath(new URL('./fixtures/exit-zero-entry.ts', import.meta.url))
const crashExitRunner = fileURLToPath(new URL('./fixtures/spawn-crash-exit.ts', import.meta.url))

const neverBindEntry = fileURLToPath(new URL('./fixtures/never-bind-entry.ts', import.meta.url))
const gatedEntry = fileURLToPath(new URL('./fixtures/gated-daemon-entry.ts', import.meta.url))
const children: Array<SpawnedDaemon> = []

async function expectGone(pid: number): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0)
          return false
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true
          throw error
        }
      },
      { timeout: 5000 },
    )
    .toBe(true)
}

// nano-spawn merges `env` over process.env without changing the parent's NODE_OPTIONS.
const env = { NODE_OPTIONS: '--import tsx' }

// `spawnDaemon` resolves the instant the socket accepts connections. The daemon
// writes its `ready: true` record the moment it binds, but that write happens in
// the child process and the OS accepts connections from the bind itself — so this
// process can connect (and read the record) a beat before the child's write is
// visible here. The gap is a few milliseconds and only shows up on a loaded CI
// runner. Poll for the settled record instead of assuming cross-process file
// consistency is instantaneous.
async function readReadyRecord(path: string): Promise<{ ready: boolean; pid: number }> {
  const deadline = Date.now() + 5_000
  let record = JSON.parse(readFileSync(path, 'utf8')) as { ready: boolean; pid: number }
  while (!record.ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    record = JSON.parse(readFileSync(path, 'utf8')) as { ready: boolean; pid: number }
  }
  return record
}

let dir: string
let socketPath: string
let pidPath: string
let logPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-spawn-'))
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
  logPath = join(dir, 'daemon.log')
})

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await stopDaemon({ app: APP, pidPath }).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

test('spawns a daemon and resolves once its socket accepts', { timeout: 30_000 }, async () => {
  await spawnDaemon({
    app: APP,
    entry: daemonEntry,
    socketPath,
    pidPath,
    logPath,
    env,
    timeoutMs: 20_000,
  })
  const record = await readReadyRecord(pidPath)
  expect(record.ready).toBe(true)
  expect(record.pid).toBeGreaterThan(0)
})

// The embedded-runtime path (Electron's Node via `process.execPath` +
// ELECTRON_RUN_AS_NODE). Here `process.execPath` is the node running vitest, so
// an explicit override still boots a real daemon.
test('runs the daemon under an explicit execPath', { timeout: 30_000 }, async () => {
  await spawnDaemon({
    app: APP,
    entry: daemonEntry,
    execPath: process.execPath,
    socketPath,
    pidPath,
    logPath,
    env,
    timeoutMs: 20_000,
  })
  const record = await readReadyRecord(pidPath)
  expect(record.ready).toBe(true)
})

// Proves the override actually drives the executable rather than being ignored:
// a bogus execPath must fail. If `spawnDaemon` fell back to `node`, this would
// boot successfully.
test('a bogus execPath fails the boot', { timeout: 30_000 }, async () => {
  const error = await spawnDaemon({
    app: APP,
    entry: daemonEntry,
    execPath: '/nonexistent/bin/definitely-not-here',
    socketPath,
    pidPath,
    logPath,
    env,
    timeoutMs: 20_000,
  }).catch((err: unknown) => err)

  expect(error).toBeInstanceOf(DaemonBootError)
})

test('surfaces a boot crash before the socket-wait timeout', { timeout: 30_000 }, async () => {
  const started = Date.now()
  const error = await spawnDaemon({
    app: APP,
    entry: crashEntry,
    socketPath,
    // A real pidPath: `spawnDaemon` now consults the lock before calling a child
    // exit a boot failure, so the crash path is only exercised honestly when
    // there IS a lockfile to consult (here: none, so the exit is a real crash).
    pidPath,
    logPath,
    env,
    // A long budget: the point is that we fail fast on the child's exit rather
    // than burning this timeout.
    timeoutMs: 20_000,
  }).catch((err: unknown) => err)

  expect(error).toBeInstanceOf(DaemonBootError)
  expect((error as DaemonBootError).logPath).toBe(logPath)
  expect((error as DaemonBootError).message).toContain(logPath)
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(readFileSync(logPath, 'utf8')).toContain('boom')
})

// The other half of the exit race: nano-spawn REJECTS on a nonzero exit (above)
// and RESOLVES on a zero one. A daemon that exits 0 without binding is still a
// failed boot, and until now nothing drove that branch.
test('a daemon that exits 0 without binding is still a boot failure', {
  timeout: 30_000,
}, async () => {
  const error = await spawnDaemon({
    app: APP,
    entry: exitZeroEntry,
    socketPath,
    pidPath,
    logPath,
    env,
    timeoutMs: 20_000,
  }).catch((err: unknown) => err)

  expect(error).toBeInstanceOf(DaemonBootError)
  expect((error as DaemonBootError).message).toContain('daemon exited during boot')
})

// `Promise.race` abandons the socket wait but cannot cancel it: pre-fix it kept
// polling on ref'd 50ms timers until the deadline, so a CLI that caught the boot
// error and returned still hung for the whole budget before the process could
// exit. Asserting the PROMISE settles fast (above) never observed that — only the
// process can. This runs spawnDaemon in a child with a 15s budget and times how
// long that child takes to exit after the error surfaces in milliseconds.
test('a boot crash does not pin the process for the rest of the budget', {
  timeout: 60_000,
}, async () => {
  const started = Date.now()
  const result = await spawn('node', [crashExitRunner, socketPath, pidPath, logPath], { env })
  const elapsed = Date.now() - started

  expect(result.stdout).toContain('caught DaemonBootError')
  expect(elapsed).toBeLessThan(8000)
})

test('onSpawn receives the child once before readiness with the recorded PID', {
  timeout: 30_000,
}, async () => {
  const spawned: Array<SpawnedDaemon> = []
  await spawnDaemon({
    app: APP,
    entry: gatedEntry,
    socketPath,
    pidPath,
    logPath,
    env,
    timeoutMs: 20_000,
    onSpawn: (child) => {
      children.push(child)
      spawned.push(child)
      expect(child.pid).toBeGreaterThan(0)
      expect(readDaemonState(pidPath)).toBeNull()
      expect(existsSync(socketPath)).toBe(false)
      writeFileSync(`${pidPath}.admitted`, '')
    },
  })
  expect(spawned).toHaveLength(1)
  expect((await readReadyRecord(pidPath)).pid).toBe(spawned[0]?.pid)
})

test('onSpawn lets the caller terminate a child after the deadline expires', async () => {
  let child: SpawnedDaemon | undefined
  const error = await spawnDaemon({
    app: APP,
    entry: neverBindEntry,
    socketPath,
    pidPath,
    logPath,
    env,
    deadline: createDeadline(500),
    onSpawn: (spawned) => {
      child = spawned
      children.push(spawned)
    },
  }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('Timed out waiting for socket')
  if (child == null) throw new Error('onSpawn was not called')
  const childPID = child.pid
  expect(() => process.kill(childPID, 0)).not.toThrow()
  expect(child.kill()).toBe(true)
  await expectGone(child.pid)
  expect(child.kill()).toBe(false)
})

test('onSpawn throwing terminates the child and preserves the error without unhandled rejection', async () => {
  const refusal = new Error('starter stopped')
  let child: SpawnedDaemon | undefined
  const error = await spawnDaemon({
    app: APP,
    entry: neverBindEntry,
    socketPath,
    pidPath,
    logPath,
    env,
    timeoutMs: 500,
    onSpawn: (spawned) => {
      child = spawned
      children.push(spawned)
      throw refusal
    },
  }).catch((error: unknown) => error)
  expect(error).toBe(refusal)
  if (child == null) throw new Error('onSpawn was not called')
  await expectGone(child.pid)
  // Let the exit promise settle; Vitest reports any unhandled rejection.
  await delay(50)
})
