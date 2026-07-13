import { getPort, getSocketPath, parsePort, resolvePort } from '@tejika/env'
import { type Command, InvalidArgumentError, Option } from 'commander'

export type WithSocketPathOptions = {
  /** Resolve a named socket (`<name>.sock`) under the app data dir. */
  name?: string
}

/**
 * Add `-s, --socket-path <path>`. The default is resolved lazily from `@tejika/env`
 * at action time (via a preAction hook), not at registration, so an env override set
 * after the program is built is still honored and option registration stays
 * synchronous. The hook targets the command the option is registered on; a leaf
 * action reads an ancestor's value with `optsWithGlobals()`.
 */
export function withSocketPath(
  cmd: Command,
  app: string,
  opts: WithSocketPathOptions = {},
): Command {
  cmd.option('-s, --socket-path <path>', 'unix socket path')
  cmd.hook('preAction', (thisCmd) => {
    if (thisCmd.opts().socketPath == null) {
      thisCmd.setOptionValue('socketPath', getSocketPath(app, opts.name))
    }
  })
  return cmd
}

function parsePortArg(value: string): number {
  try {
    return parsePort(value)
  } catch {
    throw new InvalidArgumentError('Expected an integer between 1 and 65535.')
  }
}

export type WithPortOptions = {
  /** Preferred port when there is no env override. */
  default?: number
  /** Use `default` verbatim instead of probing for a free port. Requires `default`. */
  exact?: boolean
  /** Host to probe when finding a free port. Ignored in exact mode. */
  host?: string
}

/**
 * Add `-p, --port <port>`, parsed and range-checked into a `number`.
 *
 * The default is resolved lazily at action time (via a preAction hook), not at
 * registration, so an env override set after the program is built is honored and
 * registration stays synchronous. The hook reads and writes the command the option
 * is registered on — commander stores an option's value there — so a leaf action
 * reads an ancestor's `--port` with `optsWithGlobals()`, not `opts()`.
 *
 * Without `exact`, the hook is async (it awaits `getPort`, which probes for a free
 * port). Commander chains the action after the hook's promise, so the action does
 * see the resolved `port` either way. The hazard is `parse()` itself: it is
 * fire-and-forget and returns before the hook and action have run, so any code
 * after `parse()` observes nothing yet, and a rejection from the hook or action
 * surfaces as an unhandled rejection instead of propagating to the caller. Such a
 * program MUST call `parseAsync()`.
 *
 * With `exact: true` the hook is synchronous (`resolvePort` does no I/O), so plain
 * `parse()` works.
 */
export function withPort(cmd: Command, app: string, opts: WithPortOptions = {}): Command {
  const { default: defaultPort, exact, host } = opts
  if (exact && defaultPort == null) {
    throw new Error('withPort requires a `default` port when `exact` is set')
  }
  cmd.option('-p, --port <port>', 'port number', parsePortArg)
  if (exact && defaultPort != null) {
    cmd.hook('preAction', (thisCmd) => {
      if (thisCmd.opts().port == null) {
        thisCmd.setOptionValue('port', resolvePort(app, defaultPort))
      }
    })
  } else {
    cmd.hook('preAction', async (thisCmd) => {
      if (thisCmd.opts().port == null) {
        thisCmd.setOptionValue('port', await getPort(app, { default: defaultPort, host }))
      }
    })
  }
  return cmd
}

/** LogTape's level set, which `@sozai/log` re-exports. */
export const DEFAULT_LOG_LEVELS: Array<string> = [
  'trace',
  'debug',
  'info',
  'warning',
  'error',
  'fatal',
]

export type WithLogLevelOptions = {
  /** Accepted levels. Defaults to `DEFAULT_LOG_LEVELS`. */
  levels?: Array<string>
  /** Default level. Defaults to `warning`. */
  default?: string
}

/** Add `-l, --log-level <level>`, restricted to `levels` and defaulting to `warning`. */
export function withLogLevel(cmd: Command, opts: WithLogLevelOptions = {}): Command {
  const option = new Option('-l, --log-level <level>', 'log level')
    .choices(opts.levels ?? DEFAULT_LOG_LEVELS)
    .default(opts.default ?? 'warning')
  return cmd.addOption(option)
}
