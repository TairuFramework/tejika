import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createFileLogConfig } from '../src/config.js'

const APP = 'myapp'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-log-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('keys one sink per file target', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [
      { name: 'miss', category: [APP, 'miss'], dir },
      { name: 'audit', category: [APP, 'audit'], dir },
    ],
  })
  expect(Object.keys(config.sinks).sort()).toEqual(['audit', 'miss'])
})

test('rejects two targets sharing a name', () => {
  expect(() =>
    createFileLogConfig({
      app: APP,
      files: [
        { name: 'miss', category: [APP, 'one'], dir },
        { name: 'miss', category: [APP, 'two'], dir },
      ],
    }),
  ).toThrow(/duplicate log file name: miss/i)
})

test('rejects a file target named console alongside the console sink', () => {
  expect(() =>
    createFileLogConfig({
      app: APP,
      files: [{ name: 'console', category: [APP, 'one'], dir }],
      console: true,
    }),
  ).toThrow(/reserved log file name: console/i)
})

// 'inherit' (logtape's default) UNIONS a category's sinks with its parent's, so
// without 'override' a console root entry prints every file record to stdout too.
test('overrides parent sinks on every file logger', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir }],
    console: true,
  })
  const fileLogger = config.loggers.find((logger) => logger.sinks?.includes('miss'))
  expect(fileLogger?.parentSinks).toBe('override')
})

test('defaults a file target to info level', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir }],
  })
  const fileLogger = config.loggers.find((logger) => logger.sinks?.includes('miss'))
  expect(fileLogger?.lowestLevel).toBe('info')
})

test('honors an explicit file target level', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir, level: 'debug' }],
  })
  const fileLogger = config.loggers.find((logger) => logger.sinks?.includes('miss'))
  expect(fileLogger?.lowestLevel).toBe('debug')
})

// File-only: logtape's own meta records must not land in the app's log files.
test('silences the meta logger when there is no console sink', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir }],
  })
  expect(config.sinks.console).toBeUndefined()
  const meta = config.loggers.find(
    (logger) => Array.isArray(logger.category) && logger.category[1] === 'meta',
  )
  expect(meta?.sinks).toEqual([])
  expect(config.loggers.some((logger) => logger.category.length === 0)).toBe(false)
})

// Mirrors @sozai/log's getDefaultConfig: the root entry also counts as configuring
// the meta logger, so no separate suppression entry belongs here.
test('adds a console root entry when the console is enabled', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir }],
    console: true,
  })
  expect(config.sinks.console).toBeDefined()
  const root = config.loggers.find((logger) => logger.category.length === 0)
  expect(root?.sinks).toEqual(['console'])
  expect(root?.lowestLevel).toBe('error')
  expect(
    config.loggers.some(
      (logger) => Array.isArray(logger.category) && logger.category[1] === 'meta',
    ),
  ).toBe(false)
})

test('honors an explicit console level', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir }],
    console: 'debug',
  })
  const root = config.loggers.find((logger) => logger.category.length === 0)
  expect(root?.lowestLevel).toBe('debug')
})
