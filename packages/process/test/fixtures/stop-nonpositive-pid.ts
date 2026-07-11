import { writeFileSync } from 'node:fs'
import { stopDaemon } from '../../src/status.js'

// A lockfile naming pid 0, handed to `stopDaemon`. Pre-fix this classified as a
// LIVE daemon — `process.kill(0, 0)` succeeds — and `ready: false` inside the boot
// grace made it `booting`, which `stopDaemon` signals exactly like `running`. The
// SIGTERM that followed went to pid 0, which means the ENTIRE process group: this
// process killed itself, and in a real CLI it would kill the CLI.
//
// Run as a detached child (its own process group) precisely so a regression cannot
// take the test runner down with it: a pre-fix run dies by SIGTERM instead of
// printing a result.
const [pidPath, socketPath] = process.argv.slice(2)

writeFileSync(
  pidPath,
  JSON.stringify({ pid: 0, socketPath, startedAt: Date.now(), ready: false }),
  'utf8',
)

const result = await stopDaemon({ app: 'tejika-test', pidPath })
console.log(JSON.stringify(result))
