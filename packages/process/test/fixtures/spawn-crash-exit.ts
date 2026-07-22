// Runs `spawnDaemon` against a crashing daemon entry in a process of its own, so
// the parent test can measure when THIS process exits — not merely when the
// promise settles. A boot crash must not leave the abandoned socket wait polling
// on ref'd timers for the rest of the budget.
import { fileURLToPath } from 'node:url'

import { spawnDaemon } from '../../src/spawn.js'

const [socketPath, pidPath, logPath] = process.argv.slice(2) as [string, string, string]
const entry = fileURLToPath(new URL('./crash-entry.ts', import.meta.url))

const started = Date.now()
try {
  await spawnDaemon({
    app: 'tejika-test',
    entry,
    socketPath,
    pidPath,
    logPath,
    env: { NODE_OPTIONS: '--import tsx' },
    timeoutMs: 15_000,
  })
  console.log('unexpectedly resolved')
} catch (err) {
  console.log(`caught ${(err as Error).name} after ${Date.now() - started}ms`)
}
// Deliberately no `process.exit()`: the exit time IS the assertion.
