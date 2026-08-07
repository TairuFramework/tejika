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
 */
export function createFileLogConfig(options: FileLogConfigOptions): FileLogConfig {
  const withConsole = options.console != null && options.console !== false
  const sinks: Record<string, Sink> = {}
  const loggers: FileLogConfig['loggers'] = []

  for (const file of options.files) {
    if (sinks[file.name] != null) {
      throw new Error(`Duplicate log file name: ${file.name}`)
    }
    if (withConsole && file.name === 'console') {
      throw new Error('Reserved log file name: console')
    }
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
      lowestLevel: options.console === true ? 'error' : (options.console as LogLevel),
      sinks: ['console'],
    })
  } else {
    // File-only: keep logtape's own meta records out of the app's log files.
    loggers.push({ category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] })
  }

  return { sinks, loggers }
}
