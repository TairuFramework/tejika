import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DaemonBootError } from '../src/errors.js'
import { spawnDaemon } from '../src/spawn.js'
import { stopDaemon } from '../src/status.js'

const APP = 'tejika-test'
const daemonEntry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
const crashEntry = fileURLToPath(new URL('./fixtures/crash-entry.ts', import.meta.url))

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
