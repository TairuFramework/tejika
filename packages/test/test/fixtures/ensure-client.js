import { fileURLToPath } from 'node:url'
import { ensureDaemon } from '@tejika/process'

// Drives the public ensureDaemon() entry point from a genuine OS process, using
// ONLY the default socket/pid path resolution (no `socketPath`/`pidPath`
// passed) — the configuration the README documents and the one where the
// "loser gets a spurious DaemonBootError" Critical actually lived. The caller
// spawns two of these against the same profile env to race two real processes
// through ensureDaemon()'s cold-start path.
const APP = 'tejika-e2e'
const entry = fileURLToPath(new URL('./daemon-entry.js', import.meta.url))

try {
  const client = await ensureDaemon({ app: APP, entry, timeoutMs: 20_000 })
  const result = await client.request('ping')
  await client.dispose()
  if (result !== 'pong') {
    console.log(`ENSURE_CLIENT_FAIL: unexpected response ${JSON.stringify(result)}`)
    process.exit(1)
  }
  console.log('ENSURE_CLIENT_OK')
  process.exit(0)
} catch (err) {
  const name = err?.name ? err.name : 'Error'
  const message = err?.message ? err.message : String(err)
  console.log(`ENSURE_CLIENT_FAIL: ${name}: ${message}`)
  process.exit(1)
}
