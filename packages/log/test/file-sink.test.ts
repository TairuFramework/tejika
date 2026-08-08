import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// `getTimeRotatingFileSink` derives every filename from the system clock at
// construction and at rotation, never from `record.timestamp` — so the clock is
// pinned here, once, rather than relying on the calendar or the record's date.
// Pinned as LOCAL wall-clock time, since stamps are local: an instant pinned in UTC
// would name the files differently depending on the machine's timezone.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-log-'))
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 7, 7, 14, 30))
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

/** The local calendar day, `YYYY-MM-DD`, derived independently of the sink's own stamp. */
function localDay(date: Date): string {
  return date.toLocaleDateString('en-CA')
}

/** A local calendar day `days` before the pinned clock. */
function daysAgo(days: number): string {
  const now = new Date()
  return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days))
}

test('names a daily text file after the current date', () => {
  const sink = createFileSink({ app: APP, name: 'miss', dir, sync: true })
  sink(record('hello'))
  expect(readdirSync(dir)).toEqual(['miss-2026-08-07.log'])
})

test('names an hourly file down to the hour', () => {
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

// logtape rotates on LOCAL time: its `getRotationKey` reads getFullYear/getMonth/getDate/
// getHours. A UTC stamp disagrees everywhere outside UTC — the first rotation after start
// reopens the SAME filename, so one file spans two local days, and every later file carries
// the wrong day. The stamp must be built from the same local components.
test('stamps the filename from local time, not UTC', () => {
  // 00:30 on the 8th in Asia/Tokyo, still the 7th in UTC.
  vi.setSystemTime(new Date('2026-08-07T15:30:00Z'))
  const sink = createFileSink({ app: APP, name: 'miss', dir, sync: true })
  sink(record('hello'))
  expect(readdirSync(dir)).toEqual([`miss-${localDay(new Date())}.log`])
})

test('stamps an hourly filename from the local hour', () => {
  vi.setSystemTime(new Date('2026-08-07T15:30:00Z'))
  const now = new Date()
  const hour = String(now.getHours()).padStart(2, '0')
  const sink = createFileSink({ app: APP, name: 'miss', dir, rotate: 'hourly', sync: true })
  sink(record('hello'))
  expect(readdirSync(dir)).toEqual([`miss-${localDay(now)}T${hour}.log`])
})

// Retention is the riskiest behaviour here: `parseFilename` has to be an exact inverse of
// the `filename` generator, or logtape prunes the wrong files or none at all. Cleanup runs
// on the first flush, since logtape's `lastCleanupTimestamp` starts undefined.
test('prunes only its own stale files', () => {
  const stale = `miss-${daysAgo(10)}.log`
  const alsoStale = `miss-${daysAgo(5)}.log`
  const recent = `miss-${daysAgo(1)}.log`
  const foreignName = `other-${daysAgo(10)}.log`
  const foreignExtension = `miss-${daysAgo(10)}.jsonl`
  const unparseable = 'miss-not-a-date.log'
  for (const name of [stale, alsoStale, recent, foreignName, foreignExtension, unparseable]) {
    writeFileSync(join(dir, name), 'old\n')
  }

  const sink = createFileSink({ app: APP, name: 'miss', dir, retentionDays: 3, sync: true })
  sink(record('hello'))

  expect(readdirSync(dir).sort()).toEqual(
    [`miss-${localDay(new Date())}.log`, foreignExtension, foreignName, recent, unparseable].sort(),
  )
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
