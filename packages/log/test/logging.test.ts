import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLogger, isSetup, reset } from '@sozai/log'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { configureFileLogging } from '../src/logging.js'

const APP = 'myapp'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-log-setup-'))
})

// logtape's configuration is process-global: leaving it set leaks into the next test.
afterEach(() => {
  reset()
  rmSync(dir, { recursive: true, force: true })
})

/** The one log file in `directory`, whatever date stamp it picked up. */
function onlyFile(directory: string): string {
  const names = readdirSync(directory).filter(
    (name) => name.endsWith('.log') || name.endsWith('.jsonl'),
  )
  expect(names).toHaveLength(1)
  return join(directory, names[0] as string)
}

test('writes a logged record to its file', () => {
  configureFileLogging({
    app: APP,
    files: [
      { name: 'miss', category: [APP, 'runtime', 'miss'], dir, format: 'jsonLines', sync: true },
    ],
  })
  expect(isSetup()).toBe(true)
  getLogger([APP, 'runtime', 'miss']).info('unmatched intent', { intent: 'play jazz' })
  const line = readFileSync(onlyFile(dir), 'utf8').trim()
  const parsed = JSON.parse(line) as Record<string, unknown>
  expect(parsed.message).toBe('unmatched intent')
  expect((parsed.properties as Record<string, unknown>).intent).toBe('play jazz')
})

// setup() returns early when logging is already configured, and swallows a `reset`
// flag set inside the config — so `reset: true` has to call reset() itself.
test('reconfigures when reset is set', () => {
  configureFileLogging({
    app: APP,
    files: [{ name: 'first', category: [APP, 'a'], dir, sync: true }],
  })
  const second = join(dir, 'second')
  configureFileLogging({
    app: APP,
    files: [{ name: 'second', category: [APP, 'a'], dir: second, sync: true }],
    reset: true,
  })
  getLogger([APP, 'a']).info('after reset')
  expect(readFileSync(onlyFile(second), 'utf8')).toContain('after reset')
})

test('leaves the existing configuration alone without reset', () => {
  configureFileLogging({
    app: APP,
    files: [{ name: 'first', category: [APP, 'a'], dir, sync: true }],
  })
  const second = join(dir, 'second')
  configureFileLogging({
    app: APP,
    files: [{ name: 'second', category: [APP, 'a'], dir: second, sync: true }],
  })
  getLogger([APP, 'a']).info('still first')
  expect(readFileSync(onlyFile(dir), 'utf8')).toContain('still first')
})

// setup() is first-call-wins and discards the config it is handed. Building that config
// is not free — every file target mkdirs and opens a descriptor — so an ignored call must
// not build one at all. The missing directory is the observable proxy for the leaked fd.
test('builds no config at all when the call is ignored', () => {
  configureFileLogging({
    app: APP,
    files: [{ name: 'first', category: [APP, 'a'], dir, sync: true }],
  })
  const second = join(dir, 'second')
  configureFileLogging({
    app: APP,
    files: [{ name: 'second', category: [APP, 'a'], dir: second, sync: true }],
  })
  expect(existsSync(second)).toBe(false)
})
