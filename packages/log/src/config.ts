import type { Sink } from '@logtape/logtape'
import { type Config, getConsoleSink, type LogLevel } from '@sozai/log'

import { createFileSink, type FileSinkOptions } from './file-sink.js'

export type FileLogTarget = Omit<FileSinkOptions, 'app'> & {
  category: string | Array<string>
  /** Lowest level reaching this file. Defaults to `'info'`. */
  level?: LogLevel
}

export type FileLogConfigOptions = {
  app: string
  files: Array<FileLogTarget>
  /** Also log to the console: `true` at `'error'`, or an explicit level. Defaults to `false`. */
  console?: boolean | LogLevel
}

type FileLogConfig = Config<string, string>

/**
 * Build a whole logtape `Config` from a list of log files.
 *
 * Separate from {@link configureFileLogging} because `setup()` takes ONE config and is
 * first-call-wins: two helpers cannot each contribute a sink. A host whose layout this
 * does not cover builds its own config, and this one stays testable without touching
 * logtape's process-global state.
 *
 * Building a config is NOT free: every file target creates its directory and opens a
 * descriptor. Build one only when it is going to be used — every target is validated
 * before any sink is constructed, so a rejected list leaks nothing.
 */
export function createFileLogConfig(options: FileLogConfigOptions): FileLogConfig {
  const consoleLevel = options.console === true ? 'error' : options.console
  const withConsole = consoleLevel != null && consoleLevel !== false

  // Validated up front: createFileSink opens a descriptor, so throwing partway through
  // the list would strand the sinks already built with no way to dispose them.
  const names = new Set<string>()
  const categories = new Set<string>()
  for (const file of options.files) {
    if (names.has(file.name)) {
      throw new Error(`Duplicate log file name: ${file.name}`)
    }
    if (withConsole && file.name === 'console') {
      throw new Error('Reserved log file name: console')
    }
    names.add(file.name)
    // logtape keys loggers by category, and its own setup() rejects a repeat with
    // `Duplicate logger configuration for category` — long after the sinks are open.
    const category = (Array.isArray(file.category) ? file.category : [file.category]).join('.')
    if (categories.has(category)) {
      throw new Error(`Duplicate log category: ${category}`)
    }
    categories.add(category)
  }

  // Null-prototype: a target named `__proto__` must become an own property, not a setter call.
  const sinks: Record<string, Sink> = Object.create(null)
  const loggers: FileLogConfig['loggers'] = []

  for (const file of options.files) {
    sinks[file.name] = createFileSink({ ...file, app: options.app })
    loggers.push({
      category: file.category,
      lowestLevel: file.level ?? 'info',
      sinks: [file.name],
      // logtape's default, 'inherit', UNIONS these sinks with the parent's: with a console
      // root entry below, every file record would print to stdout as well.
      parentSinks: 'override',
    })
  }

  if (withConsole) {
    sinks.console = getConsoleSink()
    // Mirrors @sozai/log's getDefaultConfig. logtape counts a `category: []` entry as
    // configuring the meta logger, so its own records stay handled without a second entry.
    loggers.push({
      category: [],
      lowestLevel: consoleLevel,
      sinks: ['console'],
    })
  } else {
    // File-only: keep logtape's own meta records out of the app's log files.
    loggers.push({ category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] })
  }

  return { sinks, loggers }
}
