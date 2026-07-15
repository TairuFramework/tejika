import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import spawn from 'nano-spawn'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DaemonBootError } from '../src/errors.js'
import { spawnDaemon } from '../src/spawn.js'
import { stopDaemon } from '../src/stop.js'

const APP = 'tejika-test'
const daemonEntry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
const crashEntry = fileURLToPath(new URL('./fixtures/crash-entry.ts', import.meta.url))
const exitZeroEntry = fileURLToPath(new URL('./fixtures/exit-zero-entry.ts', import.meta.url))
const crashExitRunner = fileURLToPath(new URL('./fixtures/spawn-crash-exit.ts', import.meta.url))

// nano-spawn merges `env` over process.env, so the child gets tsx without this
// process having to mutate its own NODE_OPTIONS.
const env = { NODE_OPTIONS: '--import tsx' }

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
  const record = JSON.parse(readFileSync(pidPath, 'utf8')) as { ready: boolean; pid: number }
  expect(record.ready).toBe(true)
  expect(record.pid).toBeGreaterThan(0)
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
