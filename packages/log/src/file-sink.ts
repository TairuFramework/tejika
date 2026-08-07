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
  /** Files older than this are pruned on rotation. Defaults to 30; ignored when `rotate` is false. */
  retentionDays?: number
  /** Flush every record as it is written, instead of buffering. Defaults to `false`. */
  sync?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

/** `2026-08-07` daily, `2026-08-07T14` hourly — sortable, and parseable back for retention. */
function stampDate(date: Date, rotate: 'daily' | 'hourly'): string {
  const iso = date.toISOString()
  return rotate === 'daily' ? iso.slice(0, 10) : iso.slice(0, 13)
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
      const stamp = filename.slice(prefix.length, filename.length - suffix.length)
      const date = new Date(rotate === 'daily' ? `${stamp}T00:00:00Z` : `${stamp}:00:00Z`)
      return Number.isNaN(date.getTime()) ? null : date
    },
    maxAgeMs: retentionDays * DAY_MS,
    formatter,
    bufferSize,
  })
}
