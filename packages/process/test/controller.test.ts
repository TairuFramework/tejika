import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Client } from '@enkaku/client'
import { appEnvVar } from '@tejika/env'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDaemonClient } from '../src/client.js'
import { connectWithRetry, ensureDaemon } from '../src/controller.js'
import { createDeadline } from '../src/deadline.js'
import { stopDaemon } from '../src/status.js'
import type { PingProtocol } from './fixtures/protocol.js'

// A pass-through spy: every test in this file still runs the real client. Only
// the timeout-wiring test below inspects the options `ensureDaemon` hands over —
// what the client is *told* is the whole of that bug, and nothing else can see it.
vi.mock('../src/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client.js')>()
  return { ...actual, createDaemonClient: vi.fn(actual.createDaemonClient) }
})

const APP = 'tejika-test'
const entry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
const hangEntry = fileURLToPath(new URL('./fixtures/hang-entry.ts', import.meta.url))
const env = { NODE_OPTIONS: '--import tsx' }
// @tejika/env's override for `getPIDPath(APP)`: lets a test exercise the DEFAULT
// pid path without writing to the real state dir.
const PID_PATH_VAR = appEnvVar(APP, 'PID_PATH')

let dir: string
let socketPath: string
let pidPath: string
let logPath: string

const options = () => ({
  app: APP,
  entry,
  socketPath,
  pidPath,
  logPath,
  env,
  timeoutMs: 20_000,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-controller-'))
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
  logPath = join(dir, 'daemon.log')
})

afterEach(async () => {
  await stopDaemon({ app: APP, pidPath }).catch(() => {})
  delete process.env[PID_PATH_VAR]
  rmSync(dir, { recursive: true, force: true })
})

test('spawns a daemon and returns a working client', { timeout: 30_000 }, async () => {
  const client = await ensureDaemon<PingProtocol>(options())
  await expect(client.request('ping')).resolves.toBe('pong')
  await client.dispose()
})

// The flagship scenario this branch exists for: two CLIs cold-start the same
// daemon at the same moment. One child wins the O_EXCL claim and binds; the other
// loses it, throws DaemonAlreadyRunningError and exits nonzero. `spawnDaemon`
// raced that exit against the socket wait and turned ANY exit into a
// DaemonBootError — and the exit reliably beats the wait's first 50ms poll — so
// the losing CLI failed even though a healthy daemon was up and it should simply
// have connected to it. BOTH callers must end up with a working client.
test('two concurrent cold starts both get a working client', {
  timeout: 60_000,
}, async () => {
  const results = await Promise.allSettled([
    ensureDaemon<PingProtocol>(options()),
    ensureDaemon<PingProtocol>(options()),
  ])

  const rejected = results.filter((r) => r.status === 'rejected')
  expect(
    rejected.map((r) => `${(r.reason as Error).name}: ${(r.reason as Error).message}`),
  ).toEqual([])

  const clients = results.map((r) => (r as PromiseFulfilledResult<Client<PingProtocol>>).value)
  for (const client of clients) {
    await expect(client.request('ping')).resolves.toBe('pong')
  }
  await Promise.all(clients.map((client) => client.dispose()))
})

// The same flagship scenario in the configuration the README actually documents:
// `pidPath` OMITTED. `spawnDaemon` defaulted `socketPath` from `app` but never
// defaulted `pidPath`, so the PARENT held `undefined`, `anotherDaemonHoldsLock`
// short-circuited to `false`, and every losing child's exit became a
// `DaemonBootError` again — while a healthy daemon was up. The child still used a
// lockfile (`runDaemon` falls back to `getPIDPath(app)`), so the split-brain race
// stayed closed; only the parent's concession check was dead. The test above never
// caught it because it always passes `pidPath` explicitly.
//
// The default is redirected into the tmp dir through @tejika/env's PID_PATH
// override: set on THIS process so the parent's `getPIDPath` resolves there, and
// passed through `env` so the child resolves to the same file.
test('two concurrent cold starts with a defaulted pidPath both get a working client', {
  timeout: 60_000,
}, async () => {
  process.env[PID_PATH_VAR] = pidPath
  const defaulted = {
    app: APP,
    entry,
    socketPath,
    logPath,
    env: { ...env, [PID_PATH_VAR]: pidPath },
    timeoutMs: 20_000,
  }

  const results = await Promise.allSettled([
    ensureDaemon<PingProtocol>(defaulted),
    ensureDaemon<PingProtocol>(defaulted),
  ])

  const rejected = results.filter((r) => r.status === 'rejected')
  expect(
    rejected.map((r) => `${(r.reason as Error).name}: ${(r.reason as Error).message}`),
  ).toEqual([])

  // The parent must have handed the child the path it defaulted to, rather than
  // letting the child resolve its own: a divergent `env` would otherwise give
  // parent and child two different lockfiles.
  expect(readFileSync(pidPath, 'utf8')).toContain('"ready":true')

  const clients = results.map((r) => (r as PromiseFulfilledResult<Client<PingProtocol>>).value)
  for (const client of clients) {
    await expect(client.request('ping')).resolves.toBe('pong')
  }
  await Promise.all(clients.map((client) => client.dispose()))
})

test('clears a stale socket file and boots anyway', { timeout: 30_000 }, async () => {
  writeFileSync(socketPath, '', 'utf8')
  const client = await ensureDaemon<PingProtocol>(options())
  await expect(client.request('ping')).resolves.toBe('pong')
  await client.dispose()
})

test('timeoutMs bounds the whole call, not just the connect retries', {
  timeout: 30_000,
}, async () => {
  const started = Date.now()
  await expect(
    ensureDaemon<PingProtocol>({ ...options(), entry: hangEntry, timeoutMs: 1500 }),
  ).rejects.toThrow()
  // Previously this took 3000ms (socket wait) + 5000ms (connect retry).
  expect(Date.now() - started).toBeLessThan(4000)
})

test('an aborted signal rejects promptly', { timeout: 30_000 }, async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  await expect(
    ensureDaemon<PingProtocol>({ ...options(), entry: hangEntry, signal: controller.signal }),
  ).rejects.toThrow()
})

// Ported from the deleted spawn.integration.test.ts: the reconnect path is
// covered nowhere else.
test('the client reconnects after the daemon is SIGKILLed and revived', {
  timeout: 60_000,
}, async () => {
  const client = await ensureDaemon<PingProtocol>(options())
  await expect(client.request('ping')).resolves.toBe('pong')

  const { pid } = JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number }
  process.kill(pid, 'SIGKILL')
  await delay(500)

  const revived = await ensureDaemon<PingProtocol>(options())

  let reconnected = false
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      if ((await client.request('ping')) === 'pong') {
        reconnected = true
        break
      }
    } catch {
      // mid-reconnect: the in-flight request aborts; keep polling.
    }
    await delay(250)
  }
  expect(reconnected).toBe(true)

  await client.dispose()
  await revived.dispose()
})

// Regression for the reviewer's Critical: `ensureDaemon` used to pass
// `deadline.signal` as the returned client's LIFECYCLE signal. `deadline.signal`
// contains `AbortSignal.timeout(timeoutMs)`, which fires on wall-clock even after
// `ensureDaemon` already returned successfully — once it fires, `client.ts` wires
// it straight to `shutdown.abort()` and the client can never reconnect again,
// silently defeating the whole reconnect-resilience feature. `timeoutMs` is kept
// short here so the bug's background timer has time to fire inside the test.
test('a client outlives its ensureDaemon timeoutMs and still reconnects', {
  timeout: 30_000,
}, async () => {
  // Boot the daemon first so the second `ensureDaemon` call below connects to an
  // already-running daemon in milliseconds — deep inside its own short budget.
  const boot = await ensureDaemon<PingProtocol>(options())
  await expect(boot.request('ping')).resolves.toBe('pong')
  await boot.dispose()

  const client = await ensureDaemon<PingProtocol>({ ...options(), timeoutMs: 300 })
  await expect(client.request('ping')).resolves.toBe('pong')

  // Let the short timeoutMs elapse in the background. The client is healthy and
  // idle; `ensureDaemon` already returned successfully before this point.
  await delay(500)

  // Kill and revive the daemon: a healthy client must still heal itself. Before
  // the fix, `AbortSignal.timeout(300)` fired at the 300ms mark and had already
  // been wired into this client's shutdown signal, so reconnect was dead.
  const { pid } = JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number }
  process.kill(pid, 'SIGKILL')
  await delay(500)
  const revived = await ensureDaemon<PingProtocol>(options())

  let reconnected = false
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      if ((await client.request('ping')) === 'pong') {
        reconnected = true
        break
      }
    } catch {
      // mid-reconnect: the in-flight request aborts; keep polling.
    }
    await delay(250)
  }
  expect(reconnected).toBe(true)

  await client.dispose()
  await revived.dispose()
})

// The budget clamp used to be passed as `connectTimeoutMs` — the value
// `createDaemonTransport` stores and reuses on EVERY reconnect for the life of the
// client. A cold start that spent 9.99s of a 10s budget therefore returned a
// client whose permanent reconnect timeout was ~8ms: the next time the daemon
// restarted, `connectWithTimeout` gave up after 8ms, destroyed the socket that had
// in fact connected, and retried — forever, against a perfectly healthy daemon.
// The same leak the signal comment two lines above swears off, missed for the
// timeout. Only the FIRST connect may be clamped.
test('the returned client keeps an unclamped reconnect timeout', {
  timeout: 30_000,
}, async () => {
  // Boot first, so the measured call connects on its very first attempt and stays
  // deep inside a budget deliberately far smaller than its per-attempt timeout.
  const boot = await ensureDaemon<PingProtocol>(options())
  await boot.dispose()

  const spy = vi.mocked(createDaemonClient)
  spy.mockClear()
  const client = await ensureDaemon<PingProtocol>({
    ...options(),
    timeoutMs: 200,
    connectTimeoutMs: 5000,
  })
  await expect(client.request('ping')).resolves.toBe('pong')

  const passed = spy.mock.calls[0]?.[0]
  // The first connect may be clamped to what is left of this call's budget...
  expect(passed?.initialConnectTimeoutMs).toBeLessThanOrEqual(200)
  // ...but what the transport keeps for its permanent reconnect loop must be the
  // caller's own per-attempt value, untouched by the budget.
  expect(passed?.connectTimeoutMs).toBe(5000)

  await client.dispose()
})

// Finding 2: the hardened `connectWithRetry` abort/timeout boundary (the
// `timedOut()`-before-sleep check plus the try/catch around `delay()` that
// distinguishes budget exhaustion from caller abort) had zero coverage — both
// timing tests above resolve inside `spawnDaemon`, never reaching this loop.
//
// These drive `connectWithRetry` directly rather than through `ensureDaemon`.
// A black-box attempt through `ensureDaemon` was tried first (per the review's
// own instructions) using a fixture daemon that binds briefly then goes dark:
// it is NOT reliably reachable. A raw `connect()` succeeds the instant the
// kernel queues it into the listening socket's backlog, independent of
// anything the server does afterward — even an immediate `destroy()` or a
// self-`SIGKILL` reacting to the very first connection. Since
// `connectWithRetry`'s own first attempt fires immediately after
// `spawnDaemon`'s probe succeeds, it routinely lands in the same backlog batch
// as that probe and "succeeds" at the raw-socket level before any server-side
// reaction can matter — `createDaemonClient` never awaits a protocol
// handshake, so this makes the whole `ensureDaemon` call resolve on attempt 1,
// never reaching the retry loop at all. Empirically this held for a reactive
// destroy-on-connection fixture, a reactive self-SIGKILL fixture, and a sweep
// of proactive fixed-delay-then-close windows (5-80ms): each window was either
// too short for `spawnDaemon`'s own probe to ever observe "live" (boot-crash
// failure, connectWithRetry never reached) or long enough that the very first
// retry attempt slipped through as a spurious success — no width reliably
// threaded both needles. `connectWithRetry` is exported (see its doc comment)
// specifically because of this.
const CONNECT_INTERVAL_MS = 20

test('budget exhaustion mid-retry throws a timeout Error, not AbortError', async () => {
  // Nothing is listening at this path, ever — connect attempts fail with
  // ENOENT deterministically, no race, for as long as the test needs.
  const deadPath = join(dir, 'nothing-here.sock')
  const deadline = createDeadline(400)

  const started = Date.now()
  let caught: unknown
  try {
    await connectWithRetry<PingProtocol>(
      { app: APP, entry, intervalMs: CONNECT_INTERVAL_MS },
      deadPath,
      deadline,
    )
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).name).not.toBe('AbortError')
  expect((caught as Error).message).toMatch(/ensureDaemon timed out.*budget exhausted/i)
  expect(Date.now() - started).toBeLessThan(1500)
})

test('a caller abort mid-retry propagates the original AbortError untouched', async () => {
  const deadPath = join(dir, 'nothing-here.sock')
  const controller = new AbortController()
  // A generous overall budget: the abort, not the deadline's own timeout, must
  // be what ends this call.
  const deadline = createDeadline(10_000, controller.signal)
  setTimeout(() => controller.abort(), 200)

  const started = Date.now()
  let caught: unknown
  try {
    await connectWithRetry<PingProtocol>(
      { app: APP, entry, intervalMs: CONNECT_INTERVAL_MS },
      deadPath,
      deadline,
    )
  } catch (err) {
    caught = err
  }
  expect((caught as Error).name).toBe('AbortError')
  expect(Date.now() - started).toBeLessThan(1500)
})
