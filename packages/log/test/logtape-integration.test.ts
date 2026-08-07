import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureSync, getLogger, resetSync } from '@logtape/logtape'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createFileLogConfig } from '../src/config.js'

const APP = 'myapp'
let dir: string

// logtape's configuration is process-global (`configureSync`/`resetSync` mutate module-level
// state shared by every caller of this `@logtape/logtape` instance), so it would leak into
// sibling test files if left set. `sync: true` targets flush every record immediately, so
// records are already on disk with nothing to dispose before `resetSync()` runs.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-log-integration-'))
})

afterEach(() => {
  resetSync()
  rmSync(dir, { recursive: true, force: true })
})

/** The one `.jsonl` file in `directory`, or `undefined` if none was ever written. */
function jsonlFile(directory: string): string | undefined {
  const names = readdirSync(directory).filter((name) => name.endsWith('.jsonl'))
  expect(names.length).toBeLessThanOrEqual(1)
  return names[0] == null ? undefined : join(directory, names[0])
}

test('accepts a createFileLogConfig output and delivers a record to its file', () => {
  configureSync(
    createFileLogConfig({
      app: APP,
      files: [{ name: 'miss', category: [APP, 'included'], dir, format: 'jsonLines', sync: true }],
    }),
  )

  getLogger([APP, 'included']).info('unmatched intent', { intent: 'play jazz' })

  const file = jsonlFile(dir)
  expect(file).toBeDefined()
  const parsed = JSON.parse(readFileSync(file as string, 'utf8').trim()) as Record<string, unknown>
  expect(parsed.message).toBe('unmatched intent')
  expect((parsed.properties as Record<string, unknown>).intent).toBe('play jazz')
})

test('keeps a record in a different category out of the file', () => {
  configureSync(
    createFileLogConfig({
      app: APP,
      files: [{ name: 'miss', category: [APP, 'included'], dir, format: 'jsonLines', sync: true }],
    }),
  )

  getLogger([APP, 'excluded']).info('should not land')

  // getTimeRotatingFileSink opens its file eagerly, at sink construction, so the file
  // exists whether or not a record ever reaches it — the file's CONTENT is the proof
  // that category scoping kept this record out, not its mere presence.
  const file = jsonlFile(dir)
  expect(file).toBeDefined()
  expect(readFileSync(file as string, 'utf8')).toBe('')
})

test('still writes the file record to disk when console is also enabled', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'included'], dir, format: 'jsonLines', sync: true }],
    console: true,
  })
  expect(config.sinks.console).toBeDefined()
  configureSync(config)

  // Without `parentSinks: 'override'` this file logger would UNION its own sink with the
  // console root entry's, printing to stdout too, but its own sink would still fire — the
  // assertion that would actually catch a regression here is a mis-set sink name or a
  // dropped file-logger entry, either of which would leave nothing on disk at all.
  getLogger([APP, 'included']).info('through console too')

  const file = jsonlFile(dir)
  expect(file).toBeDefined()
  expect(readFileSync(file as string, 'utf8')).toContain('through console too')
})
