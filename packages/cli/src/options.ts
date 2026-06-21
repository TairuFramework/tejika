import { getPort, getSocketPath } from '@tejika/env'
import type { Command } from 'commander'

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

/**
 * Add `-p, --port <port>`. The default is resolved lazily from `@tejika/env`
 * (`getPort` is async) in an async preAction hook, keeping registration sync.
 *
 * IMPORTANT: because the hook is async, the program MUST be run with
 * `program.parseAsync()` — commander only awaits async hooks under parseAsync.
 * Under the synchronous `parse()`, the awaited default is dropped and `port`
 * stays undefined at action time.
 */
export function withPort(cmd: Command, app: string): Command {
  cmd.option('-p, --port <port>', 'port number')
  cmd.hook('preAction', async (_thisCmd, actionCmd) => {
    if (actionCmd.opts().port == null) {
      actionCmd.setOptionValue('port', await getPort(app))
    }
  })
  return cmd
}

/** Add `-l, --log-level <level>` with a static `warning` default. */
export function withLogLevel(cmd: Command): Command {
  return cmd.option('-l, --log-level <level>', 'log level', 'warning')
}
