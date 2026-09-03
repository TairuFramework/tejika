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
  `DEFAULT_LOG_LEVELS`.

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
