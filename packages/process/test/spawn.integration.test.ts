import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { ensureDaemon, getDaemonStatus, stopDaemon } from '../src/index.js'

const APP = 'tejika-test'
const entry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))

// Unique paths per worker; env overrides keep the daemon off the real state dir.
const socketPath = join(tmpdir(), `tejika-proc-${process.pid}.sock`)
const pidPath = join(tmpdir(), `tejika-proc-${process.pid}.pid`)

type PingProtocol = { ping: { type: 'request'; result: { type: 'string' } } }

afterEach(async () => {
  await stopDaemon({ app: APP, pidPath }).catch(() => {})
  // Brief grace for the daemon's SIGTERM handler to close the server and unlink
  // the socket before the next test (or teardown) reuses the paths.
  await delay(100)
})

test('ensureDaemon spawns a daemon and the client reconnects after it is killed', {
  timeout: 60_000,
}, async () => {
  // Spawned daemon inherits this env: tsx loader so it can run the .ts entry,
  // and a pid-path override so it writes its pidfile to tmp instead of the real
  // state dir. The override is load-bearing: the fixture calls runDaemon WITHOUT
  // a pidPath, so it defaults to getPIDPath('tejika-test'), which honors
  // TEJIKA_TEST_PID_PATH first — and the assertions below read that same path.
  // (The socket path needs no env override; it is passed explicitly via
  // ensureDaemon -> spawnDaemon -> the entry's --socket-path flag.)
  const prevNodeOptions = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = [prevNodeOptions, '--import tsx'].filter(Boolean).join(' ')
  process.env.TEJIKA_TEST_PID_PATH = pidPath

  try {
    const client = await ensureDaemon<PingProtocol>({ app: APP, entry, socketPath })

    // Baseline: the daemon is up and answers a request.
    expect(getDaemonStatus({ app: APP, pidPath }).running).toBe(true)
    await expect(client.request('ping')).resolves.toBe('pong')

    // Hard-kill the daemon, let the socket tear down, then revive a fresh one
    // on the same socket via a throwaway ensureDaemon (clears the stale socket
    // + respawns). The original client should heal and serve again.
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
    process.kill(pid, 'SIGKILL')
    await delay(500)
    const revived = await ensureDaemon<PingProtocol>({ app: APP, entry, socketPath })

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
  } finally {
    if (prevNodeOptions == null) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = prevNodeOptions
    delete process.env.TEJIKA_TEST_PID_PATH
  }
})
