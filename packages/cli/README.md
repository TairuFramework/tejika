# @tejika/cli

commander + Ink plumbing for building local CLI tools: a program builder, an Ink
render helper, and reusable option builders. `ink` and `react` are peer
dependencies supplied by the host.

```sh
pnpm add @tejika/cli ink react
```

- `buildProgram` — build a commander `Command` with name/version, positional
  options, and full-help-after-error wired onto the program and every
  subcommand.
- `runInk` / `renderStatic` — render an interactive Ink app and await its exit,
  or render an element once for non-interactive output.
- `withLogLevel` / `withPort` / `withSocketPath` — option builders that add the
  common `--log-level` / `--port` / `--socket-path` flags to a command, plus
  `DEFAULT_LOG_LEVELS`; `withPIDPath` adds `--pid-path`.
- `withCommandSignal` — run work with a signal that `SIGINT`/`SIGTERM` aborts,
  removing the listeners afterwards.
- `addJSONOption` / `printJSON` / `printNDJSON` — one `--json` convention for
  machine-readable output.
- `parseJSONArg` — parse a JSON flag value; `@path` reads it from a file and
  every error names the flag.
- `fail` — write `✘ <message>` to stderr and set exit code 1.
- `renderTable` — a static Ink table through `renderStatic`.
- `createDaemonCommand` — a `daemon start|stop|status|restart|logs` group over
  `@tejika/process`, generic over the app name. Start reports a socket mismatch
  when another build owns the pid file, stop and restart wait with a deadline
  then `SIGKILL`, `logs --follow` tails the daemon log, and every subcommand
  honors `--socket-path` and `--pid-path`. `waitReady` and `describeStatus` hooks
  add app-level readiness and status fields.

```ts
import { Command } from 'commander'
import { buildProgram, runInk, withPort } from '@tejika/cli'

const start = withPort(new Command('start'), 'myapp').action(async (opts) => {
  await runInk(<App port={opts.port} />)
})

// withPort resolves the default port in an async preAction hook, so the
// program must be run with parseAsync(), not parse().
await buildProgram({ name: 'myapp', version: '1.0.0', commands: [start] }).parseAsync()
```
