import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getFileSink, getTimeRotatingFileSink } from '@logtape/file'
import { getJsonLinesFormatter, type Sink } from '@logtape/logtape'
import { getLogDir } from '@tejika/env'

export type FileSinkFormat = 'text' | 'jsonLines'
export type FileSinkRotation = 'daily' | 'hourly' | false

export type FileSinkOptions = {
  app: string
  /** Base filename, without a date stamp or extension. */
  name: string
  /** Defaults to `getLogDir(app)`. */
  dir?: string
  /** `'text'` (default) writes `.log`, `'jsonLines'` writes `.jsonl`. */
  format?: FileSinkFormat
  /** Rotation interval, or `false` for a single file. Defaults to `'daily'`. */
  rotate?: FileSinkRotation
  /**
   * Files older than this are pruned on rotation. Defaults to 30; ignored when `rotate` is false.
   *
   * Pruning only matches this sink's own `<name>-<stamp>.<extension>` pattern, so files left
   * behind by a different `rotate` or `format` setting are never pruned — changing either
   * strands the old files until they are removed by hand.
   */
  retentionDays?: number
  /** Flush every record as it is written, instead of buffering. Defaults to `false`. */
  sync?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * `2026-08-07` daily, `2026-08-07T14` hourly — sortable, and parseable back for retention.
 *
 * Built from LOCAL components, matching logtape: its `getRotationKey` decides when to rotate
 * from `getFullYear`/`getMonth`/`getDate`/`getHours`, so a UTC stamp disagrees everywhere
 * outside UTC — the first rotation would reopen the same filename, silently letting one file
 * span two local days, and every later file would carry the wrong day.
 */
function stampDate(date: Date, rotate: 'daily' | 'hourly'): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return rotate === 'daily' ? day : `${day}T${pad(date.getHours())}`
}

/** The exact inverse of {@link stampDate}, or `null` for anything it did not write. */
function parseStamp(stamp: string): Date | null {
  const match = STAMP_RE.exec(stamp)
  if (match == null) return null
  const [, year, month, day, hour] = match
  return new Date(Number(year), Number(month) - 1, Number(day), hour == null ? 0 : Number(hour))
}

/**
 * A rotating log file for `app`, under `getLogDir(app)` unless told otherwise.
 *
 * The return type is `Sink` rather than logtape's `Sink & Disposable`: this repo compiles
 * against `lib: es2025`, which has no `Disposable` global. Logtape still disposes the sink
 * through the config that holds it, on `reset()` and at process exit.
 */
export function createFileSink(options: FileSinkOptions): Sink {
  const {
    app,
    name,
    dir = getLogDir(app),
    format = 'text',
    rotate = 'daily',
    retentionDays = 30,
    sync = false,
  } = options
  // Owner-only, like the socket dir beside it: local logs hold personal data.
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const extension = format === 'jsonLines' ? 'jsonl' : 'log'
  const formatter = format === 'jsonLines' ? getJsonLinesFormatter() : undefined
  // 0 disables the sink's write buffer, so a record written just before the process
  // exits is already on disk. Left undefined, logtape applies its own default.
  const bufferSize = sync ? 0 : undefined

  if (rotate === false) {
    return getFileSink(join(dir, `${name}.${extension}`), { formatter, bufferSize })
  }

  return getTimeRotatingFileSink({
    directory: dir,
    interval: rotate,
    filename: (date) => `${name}-${stampDate(date, rotate)}.${extension}`,
    // With a custom `filename` and no `parseFilename`, logtape prunes by file mtime.
    // Parsing our own stamp back keeps retention tied to the record dates instead.
    parseFilename: (filename) => {
      const prefix = `${name}-`
      const suffix = `.${extension}`
      if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) return null
      return parseStamp(filename.slice(prefix.length, filename.length - suffix.length))
    },
    maxAgeMs: retentionDays * DAY_MS,
    formatter,
    bufferSize,
  })
}
