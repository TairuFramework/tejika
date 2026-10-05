import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPIDPath } from '@tejika/env'
import { getDaemonStatus, stopDaemon } from '@tejika/process'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createDaemonCommand } from '../src/daemon.js'

const APP = 'tejika-cli-test'
const entry = fileURLToPath(new URL('./fixtures/daemon-entry.js', import.meta.url))

let dir: string
let pidPath: string
let socketPath: string
let output: Array<string>
let errors: Array<string>
const saved = { ...process.env }

// Short base: a unix socket path must stay under the `sun_path` limit.
beforeEach(() => {
  dir = mkdtempSync('/tmp/tcli-')
  pidPath = join(dir, 'custom.pid')
  socketPath = join(dir, 'd.sock')
  process.env.TEJIKA_CLI_TEST_LOG_DIR = join(dir, 'logs')
  process.env.TEJIKA_CLI_TEST_STATE_DIR = join(dir, 'state')
  output = []
  errors = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stopDaemon({ app: APP, pidPath, killTimeoutMs: 5_000 }).catch(() => {})
  process.env = { ...saved }
  process.exitCode = undefined
  rmSync(dir, { recursive: true, force: true })
})

async function run(...args: Array<string>): Promise<void> {
  const program = new Command().exitOverride()
  program.addCommand(
    createDaemonCommand({
      app: APP,
      entry,
      startTimeoutMs: 15_000,
      describeStatus: async () => ({ extra: 'yes' }),
    }),
  )
  await program.parseAsync(['daemon', ...args], { from: 'user' })
}

const paths = () => ['--socket-path', socketPath, '--pid-path', pidPath]

describe('createDaemonCommand', () => {
  test('start, status, stop and restart honor a custom --pid-path', {
    timeout: 60_000,
  }, async () => {
    await run('start', ...paths(), '--json')
    const started = JSON.parse(output.join(''))
    expect(started.socketPath).toBe(socketPath)
    expect(typeof started.pid).toBe('number')
    // The record lives at the custom path, not at the env default.
    expect(existsSync(pidPath)).toBe(true)
    expect(existsSync(getPIDPath(APP))).toBe(false)
    output.length = 0

    await run('status', ...paths(), '--json')
    expect(JSON.parse(output.join(''))).toMatchObject({
      state: 'running',
      pid: started.pid,
      extra: 'yes',
    })
    output.length = 0

    // Starting again is idempotent: same daemon.
    await run('start', ...paths(), '--json')
    expect(JSON.parse(output.join('')).pid).toBe(started.pid)
    output.length = 0

    await run('restart', ...paths(), '--json')
    const restarted = JSON.parse(output.join(''))
    expect(restarted.stop).toMatchObject({ state: 'stopped', pid: started.pid })
    expect(restarted.start.pid).not.toBe(started.pid)
    output.length = 0

    await run('stop', ...paths(), '--json')
    expect(JSON.parse(output.join('')).state).toBe('stopped')
    expect((await getDaemonStatus({ app: APP, pidPath })).state).not.toBe('running')
    output.length = 0

    await run('stop', ...paths())
    expect(output.join('')).toBe('daemon not running\n')
    expect(process.exitCode).toBeUndefined()
  })

  test('reports a socket mismatch when another daemon owns the pid file', {
    timeout: 60_000,
  }, async () => {
    await run('start', ...paths(), '--json')
    output.length = 0
    await run('stop', '--socket-path', join(dir, 'other.sock'), '--pid-path', pidPath)
    expect(errors.join('')).toContain('not the selected socket')
    expect(process.exitCode).toBe(1)
    expect((await getDaemonStatus({ app: APP, pidPath })).state).toBe('running')
  })

  test('start fails fast when the daemon cannot boot', { timeout: 30_000 }, async () => {
    const program = new Command().exitOverride()
    program.addCommand(
      createDaemonCommand({
        app: APP,
        entry: join(dir, 'missing-entry.js'),
        startTimeoutMs: 10_000,
      }),
    )
    await program.parseAsync(['daemon', 'start', ...paths()], { from: 'user' })
    expect(errors.join('')).toContain('✘')
    expect(process.exitCode).toBe(1)
  })

  test('logs prints the last lines and rejects a bad count', async () => {
    mkdirSync(join(dir, 'logs'), { recursive: true })
    writeFileSync(join(dir, 'logs', 'daemon.log'), 'one\ntwo\nthree\n')
    await run('logs', '-n', '2')
    expect(output.join('')).toBe('two\nthree\n')
    output.length = 0
    await run('logs', '-n', 'x')
    expect(errors.join('')).toContain('Invalid line count "x"')
    expect(process.exitCode).toBe(1)
  })

  test('logs fails when there is no log file', async () => {
    await run('logs')
    expect(errors.join('')).toContain('Cannot read')
    expect(process.exitCode).toBe(1)
  })
})
