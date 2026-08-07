import { reset, setup } from '@sozai/log'

import { createFileLogConfig, type FileLogConfigOptions } from './config.js'

export type ConfigureFileLoggingOptions = FileLogConfigOptions & {
  /** Clear any existing configuration first. Defaults to `false`. */
  reset?: boolean
}

/**
 * Configure logging to write the given files, through `@sozai/log`.
 *
 * `reset` is handled here rather than passed through: `setup()` returns early once
 * logging is configured, so a `reset` flag inside the config never reaches
 * `configureSync` and is silently swallowed.
 */
export function configureFileLogging(options: ConfigureFileLoggingOptions): void {
  if (options.reset) reset()
  setup(createFileLogConfig(options))
}
