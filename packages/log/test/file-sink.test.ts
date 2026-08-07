import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogRecord } from '@logtape/logtape'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createFileSink } from '../src/file-sink.js'

const APP = 'myapp'
let dir: string

// A minimal record, shaped like what logtape hands a sink.
function record(message: string): LogRecord {
  return {
    category: [APP, 'test'],
    level: 'info',
    message: [message],
    rawMessage: message,
    timestamp: Date.UTC(2026, 7, 7, 14, 30),
    properties: { answer: 42 },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

test('creates the log directory when missing', () => {
  const target = join(dir, 'nested', 'logs')
  expect(existsSync(target)).toBe(false)
  createFileSink({ app: APP, name: 'miss', dir: target, sync: true })
  expect(existsSync(target)).toBe(true)
})

// `getTimeRotatingFileSink` derives the filename from the system clock at
// construction and at rotation, not from `record.timestamp` — so the test pins
// the clock rather than relying on the record's date.
test('names a daily text file after the record date', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-07T14:30:00Z'))
  const sink = createFileSink({ app: APP, name: 'miss', dir, sync: true })
  sink(record('hello'))
  expect(readdirSync(dir)).toEqual(['miss-2026-08-07.log'])
})

// See the comment above: filenames come from the pinned system clock, not the record.
test('names an hourly file down to the hour', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-07T14:30:00Z'))
  const sink = createFileSink({ app: APP, name: 'miss', dir, rotate: 'hourly', sync: true })
  sink(record('hello'))
  expect(readdirSync(dir)).toEqual(['miss-2026-08-07T14.log'])
})

test('drops the date stamp when rotation is off', () => {
  const sink = createFileSink({ app: APP, name: 'miss', dir, rotate: false, sync: true })
  sink(record('hello'))
  expect(readdirSync(dir)).toEqual(['miss.log'])
})

test('writes parseable JSON lines under the jsonLines format', () => {
  const sink = createFileSink({ app: APP, name: 'miss', dir, format: 'jsonLines', sync: true })
  sink(record('first'))
  sink(record('second'))
  const lines = readFileSync(join(dir, 'miss-2026-08-07.jsonl'), 'utf8').trim().split('\n')
  expect(lines).toHaveLength(2)
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  expect(parsed[0]?.message).toBe('first')
  expect(parsed[1]?.message).toBe('second')
})

// `sync: true` sets bufferSize 0: a record written just before the process exits
// must already be on disk, with no dispose or flush in between.
test('flushes each record immediately under sync', () => {
  const sink = createFileSink({ app: APP, name: 'miss', dir, sync: true })
  sink(record('hello'))
  expect(readFileSync(join(dir, 'miss-2026-08-07.log'), 'utf8')).toContain('hello')
})

test('defaults the directory to the app log dir', () => {
  process.env.MYAPP_LOG_DIR = join(dir, 'from-env')
  try {
    createFileSink({ app: APP, name: 'miss', sync: true })
    expect(existsSync(join(dir, 'from-env'))).toBe(true)
  } finally {
    delete process.env.MYAPP_LOG_DIR
  }
})
