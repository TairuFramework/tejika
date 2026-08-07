import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appEnvVar } from '@tejika/env'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { spawnDaemon } from '../src/spawn.js'
import { stopDaemon } from '../src/stop.js'

const APP = 'tejika-test'
const entry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
// @tejika/env's override for `getLogDir(APP)`: lets this test exercise the DEFAULT
// log path without writing to the real platform log dir.
const LOG_DIR_VAR = appEnvVar(APP, 'LOG_DIR')

let dir: string
let logDir: string
let socketPath: string
let pidPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-spawn-log-'))
  logDir = join(dir, 'logs')
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
  process.env[LOG_DIR_VAR] = logDir
})

afterEach(async () => {
  await stopDaemon({ app: APP, pidPath }).catch(() => {})
  delete process.env[LOG_DIR_VAR]
  rmSync(dir, { recursive: true, force: true })
})

// The default is the whole point: a consumer that passes no `logPath` must not get
// a log file in the data dir beside its database and socket.
test('defaults the daemon log under the log dir', { timeout: 30_000 }, async () => {
  await spawnDaemon({
    app: APP,
    entry,
    socketPath,
    pidPath,
    env: { NODE_OPTIONS: '--import tsx' },
    timeoutMs: 20_000,
  })
  expect(existsSync(join(logDir, 'daemon.log'))).toBe(true)
})
