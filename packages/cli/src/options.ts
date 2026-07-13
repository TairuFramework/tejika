import { getPort, getSocketPath, parsePort, resolvePort } from '@tejika/env'
import { type Command, InvalidArgumentError } from 'commander'

/**
 * Add `-s, --socket-path <path>`. The default is resolved lazily from
 * `@tejika/env` at action time (via a preAction hook), not at registration, so
 * an env override set after the program is built is still honored and option
 * registration stays synchronous.
 */
export function withSocketPath(cmd: Command, app: string): Command {
  cmd.option('-s, --socket-path <path>', 'unix socket path')
  cmd.hook('preAction', (_thisCmd, actionCmd) => {
    if (actionCmd.opts().socketPath == null) {
      actionCmd.setOptionValue('socketPath', getSocketPath(app))
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
 * port). Commander only awaits hooks under `parseAsync()`; under the synchronous
 * `parse()` the hook is fire-and-forget, so its result lands after the action has
 * already run and `port` is undefined at action time. Such a program MUST call
 * `parseAsync()`.
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

/** Add `-l, --log-level <level>` with a static `warning` default. */
export function withLogLevel(cmd: Command): Command {
  return cmd.option('-l, --log-level <level>', 'log level', 'warning')
}
