import { fileURLToPath } from 'node:url'
import { ensureDaemon } from '@tejika/process'

// Drives ensureDaemon() against a daemon entry that crashes before binding its
// socket, run as a genuine child process. Deliberately calls NO process.exit():
// the assertion this fixture exists for is how fast the PROCESS exits on its
// own once ensureDaemon() settles, not merely when the promise does. Pre-fix,
// spawnDaemon's abandoned socket wait kept polling on ref'd timers for the rest
// of the timeoutMs budget even after the boot-crash error had already surfaced,
// which pins a caller alive long after it caught and handled the rejection.
const APP = 'tejika-e2e-crash'
const entry = fileURLToPath(new URL('./crash-entry.js', import.meta.url))

try {
  await ensureDaemon({ app: APP, entry, timeoutMs: 15_000 })
  console.log('ENSURE_CRASH_RESULT: unexpectedly resolved')
} catch (err) {
  const name = err?.name ? err.name : 'Error'
  const logPath = err?.logPath ? err.logPath : 'none'
  console.log(`ENSURE_CRASH_RESULT: caught ${name} logPath=${logPath}`)
}
