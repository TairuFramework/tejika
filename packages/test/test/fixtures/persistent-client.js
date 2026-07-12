import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ensureDaemon } from '@tejika/process'

// A long-lived client process for the cross-process SIGKILL/revive scenario.
// Holds a single ensureDaemon() connection for its whole lifetime, prints
// READY once connected, then on each "ping" line from stdin retries a request
// for up to 20s and reports the outcome. The retry loop mirrors
// packages/process/test/controller.test.ts's in-process reconnect test: a
// caller SIGKILLs the daemon and revives it out-of-band (a fresh process, not
// this one), and THIS client's own auto-reconnect must heal the connection
// rather than a new client simply seeing a healthy daemon.
const APP = 'tejika-e2e'
const entry = fileURLToPath(new URL('./daemon-entry.js', import.meta.url))

const client = await ensureDaemon({ app: APP, entry, timeoutMs: 20_000 })
console.log('READY')

const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  if (line.trim() !== 'ping') continue
  const deadline = Date.now() + 20_000
  let result
  while (Date.now() < deadline) {
    try {
      result = await client.request('ping')
      if (result === 'pong') break
    } catch {
      // mid-reconnect: the in-flight request aborts; keep polling.
    }
    await delay(200)
  }
  console.log(result === 'pong' ? 'PONG:pong' : 'PONG:timeout')
}
