import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { connectSocket } from '@enkaku/socket'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { connectWithTimeout, createDaemonTransport, nextBackoff } from '../src/client.js'
import type { ConnectSocket } from '../src/socket.js'
import type { PingProtocol } from './fixtures/protocol.js'

const RECONNECT_MAX_MS = 5000

/** Deterministic uniform draws in [0, 1) — mulberry32. */
const seeded = (seed: number) => {
  let state = seed
  return (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Walk the backoff as the client does: feed each ceiling back in, not each delay. */
const walk = (steps: number, random: () => number) => {
  let ceilingMs = 0
  const ceilings: Array<number> = []
  const delays: Array<number> = []
  for (let i = 0; i < steps; i++) {
    const next = nextBackoff(ceilingMs, random)
    ceilingMs = next.ceilingMs
    ceilings.push(next.ceilingMs)
    delays.push(next.delayMs)
  }
  return { ceilings, delays }
}

describe('nextBackoff', () => {
  test('the first delay is a jittered value inside the base window', () => {
    expect(nextBackoff(0, () => 1)).toEqual({ ceilingMs: 250, delayMs: 250 })
    expect(nextBackoff(0, () => 0.5)).toEqual({ ceilingMs: 250, delayMs: 125 })
    expect(nextBackoff(0, () => 0)).toEqual({ ceilingMs: 250, delayMs: 0 })
  })

  test('doubles the ceiling each time and caps it', () => {
    const { ceilings } = walk(8, () => 1)
    expect(ceilings).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000])
  })

  // The bug this replaces: the next ceiling was derived from the previous jittered
  // DELAY, so each step multiplied it by `2 * random()` — expected log drift of
  // `ln2 - 1 ≈ -0.31` per attempt. The ceiling collapsed geometrically and the
  // delays reached 0 and stayed there: a busy reconnect loop. The old test passed
  // only because it pinned `random = () => 1`, the single draw that hides it. The
  // ceiling must be driven by the attempt count, so it is identical under ANY draw.
  test('the ceiling is unaffected by the jitter draws', () => {
    const top = walk(10, () => 1).ceilings
    expect(walk(10, () => 0).ceilings).toEqual(top)
    expect(walk(10, () => 0.5).ceilings).toEqual(top)
    expect(walk(10, seeded(42)).ceilings).toEqual(top)
    expect(walk(10, Math.random).ceilings).toEqual(top)
  })

  test('does not decay under jitter: late delays still average near the cap', () => {
    const { ceilings, delays } = walk(40, seeded(42))
    expect(ceilings[39]).toBe(RECONNECT_MAX_MS)

    // Pre-fix, every one of these was 0.0ms. Full jitter over a 5000ms ceiling has
    // an expected value of 2500ms; anything above 1000 proves the ceiling held.
    const late = delays.slice(30)
    const mean = late.reduce((total, value) => total + value, 0) / late.length
    expect(mean).toBeGreaterThan(1000)
    expect(Math.max(...late)).toBeLessThanOrEqual(RECONNECT_MAX_MS)
  })

  test('never returns a negative or NaN delay', () => {
    for (const draw of [0, 0.5, 1]) {
      const { delayMs } = nextBackoff(1000, () => draw)
      expect(delayMs).toBeGreaterThanOrEqual(0)
      expect(Number.isNaN(delayMs)).toBe(false)
    }
  })
})

describe('connectWithTimeout', () => {
  /**
   * A connect that never resolves on its own, and settles only by being abandoned —
   * which is exactly the contract `connectSocket` honours: it rejects an abandoned
   * attempt with `signal.reason`, having destroyed the pending socket.
   */
  const stalledConnect: ConnectSocket = (_path, options) =>
    new Promise<Socket>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
        once: true,
      })
    })

  // The timeout error must carry a `code`: `ensureDaemon` decides whether to retry
  // an attempt within its budget by looking at `err.code`, so an uncoded timeout
  // aborted the whole call on the first slow connect instead of retrying. The whole
  // reason the expiry aborts with an error of our own making, rather than letting
  // `connectSocket` time out on its own, is to own this `code`.
  test('a timed-out connect rejects with an ETIMEDOUT-coded error', async () => {
    const err = await connectWithTimeout('/nope.sock', 20, stalledConnect).catch(
      (caught: unknown) => caught,
    )
    expect((err as NodeJS.ErrnoException).code).toBe('ETIMEDOUT')
    expect((err as Error).message).toMatch(/Timed out connecting/)
  })

  // The caller's signal abandons an in-flight connect, so a connect started just
  // before dispose cannot outlive it. Its reason must reach the caller untouched:
  // converting it into the timeout error would tell `ensureDaemon` to retry a call
  // that was deliberately cancelled.
  test("a caller abort abandons the connect and keeps the caller's own reason", async () => {
    const control = new AbortController()
    const reason = new Error('daemon client disposed')
    const pending = connectWithTimeout('/nope.sock', 60_000, stalledConnect, control.signal).catch(
      (caught: unknown) => caught,
    )
    control.abort(reason)
    expect(await pending).toBe(reason)
  })
})

describe('createDaemonTransport', () => {
  let dir: string
  let socketPath: string
  let server: Server | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tejika-client-'))
    socketPath = join(dir, 'app.sock')
  })

  afterEach(async () => {
    if (server != null) await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  test('throws when nothing is listening', async () => {
    await expect(
      createDaemonTransport<PingProtocol>({ app: 'tejika-test', socketPath }),
    ).rejects.toThrow()
  })

  test('exposes the three Client hooks plus dispose', async () => {
    server = createServer()
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve))

    const daemonTransport = await createDaemonTransport<PingProtocol>({
      app: 'tejika-test',
      socketPath,
    })
    expect(daemonTransport.transport).toBeDefined()
    expect(typeof daemonTransport.handleTransportDisposed).toBe('function')
    expect(typeof daemonTransport.handleTransportError).toBe('function')

    // After dispose the hooks must stop handing out fresh transports, or
    // shutdown races a reconnect.
    daemonTransport.dispose()
    expect(daemonTransport.handleTransportDisposed()).toBeUndefined()
    expect(daemonTransport.handleTransportError()).toBeUndefined()
  })

  test('rejects promptly rather than hanging when the socket is absent', async () => {
    const started = Date.now()
    await expect(
      createDaemonTransport<PingProtocol>({
        app: 'tejika-test',
        socketPath,
        connectTimeoutMs: 200,
      }),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  // The behavioural half of the clamp fix: `ensureDaemon` clamps the FIRST connect
  // to what is left of its budget, and that clamp used to become the transport's
  // permanent reconnect timeout. Here the first connect is given a tiny budget
  // (50ms — it is fast and local, so it succeeds) while the steady-state timeout is
  // 2000ms, and the RECONNECT connect is made slow (300ms). If the reconnect were
  // still judged against the 50ms first-connect budget, `connectWithTimeout` would
  // reject with ETIMEDOUT and destroy the socket that connected — so the reconnect
  // must instead be allowed its 2000ms and produce a working stream.
  test('the reconnect connect is bounded by connectTimeoutMs, not the first-connect clamp', async () => {
    server = createServer()
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve))
    const connections: Array<Socket> = []
    server.on('connection', (socket) => connections.push(socket))

    let attempts = 0
    const connect = async (path: string): Promise<Socket> => {
      attempts += 1
      // Only the reconnect is slow. A real AF_UNIX connect never is, which is why
      // the seam has to be injected to reach this at all.
      if (attempts > 1) await delay(300)
      return await connectSocket(path)
    }

    const daemonTransport = await createDaemonTransport<PingProtocol>(
      {
        app: 'tejika-test',
        socketPath,
        connectTimeoutMs: 2000,
        initialConnectTimeoutMs: 50,
      },
      connect,
    )

    // The drop: the client's own hook, and the only way in to the reconnect path.
    const next = daemonTransport.handleTransportDisposed()
    expect(next).toBeDefined()

    // The reconnect socket is opened lazily, when the transport is first read.
    const read = (next as NonNullable<typeof next>)
      .read()
      .then(() => 'read' as const)
      .catch((err: unknown) => err as Error)
    const outcome = await Promise.race([read, delay(1500).then(() => 'connected' as const)])

    // Pre-fix this was an ETIMEDOUT Error at ~50ms. The server never writes, so a
    // healthy reconnect simply leaves the read pending.
    expect(outcome).toBe('connected')
    expect(attempts).toBe(2)
    expect(connections.length).toBe(2)

    daemonTransport.dispose()
    // The first transport was never really disposed — only its hook was called —
    // so its peer socket would keep `server.close()` draining forever.
    for (const socket of connections) socket.destroy()
  })

  test('dispose() tears down the connection, so the peer observes it close', async () => {
    server = createServer()
    const accepted = new Promise<Socket>((resolve) => server?.once('connection', resolve))
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve))

    const daemonTransport = await createDaemonTransport<PingProtocol>({
      app: 'tejika-test',
      socketPath,
    })
    const serverSocket = await accepted
    const serverSideClosed = new Promise<void>((resolve) => serverSocket.once('close', resolve))

    daemonTransport.dispose()

    await Promise.race([
      serverSideClosed,
      delay(2000).then(() => {
        throw new Error('timed out waiting for the server to observe the socket close')
      }),
    ])
  })
})
