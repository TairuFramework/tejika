# tejika (手近)

手近 -- the local-side foundation of the stack: shared packages for CLI tooling, local
process/daemon lifecycle, local HTTP servers, and path/port resolution. The counterpart to
enkaku (遠隔, remote); it consumes enkaku's RPC client/server and transports.

## Packages

| Package | Purpose |
|---------|---------|
| [`@tejika/env`](./packages/env) | Local paths, ports and env-var overrides (`getSocketPath`, `getPort`, …) |
| [`@tejika/log`](./packages/log) | Local log files: rotating file sinks and logtape config (host supplies `@logtape/logtape`) |
| [`@tejika/process`](./packages/process) | Local daemon spawn / lifecycle / Enkaku client reconnect |
| [`@tejika/server`](./packages/server) | Local Hono HTTP server: loopback-private (default) or network mode |
| [`@tejika/cli`](./packages/cli) | commander + Ink plumbing (`buildProgram`, `runInk`, option builders) |
| [`@tejika/ui`](./packages/ui) | Generic Ink component kit (`StatusLine`, `ConfirmCard`, `SelectCard`, …) |
| [`@tejika/test`](./packages/test) | Integration-test harness: `PTYDriver`, `runCLI`, test profiles, daemon waits |

## Install

Each package is published independently and installed as needed:

```sh
pnpm add @tejika/env @tejika/process @tejika/server
pnpm add @tejika/cli @tejika/ui ink react # cli/ui need ink + react as peers
pnpm add @tejika/log @logtape/logtape # log needs a logtape host
pnpm add -D @tejika/test             # test harness is a devDependency
```

A typical CLI daemon resolves its socket/port with `@tejika/env`, boots with
`@tejika/process`, serves over `@tejika/server`, renders with `@tejika/cli` +
`@tejika/ui`, and is exercised through `@tejika/test`. See each package's README
for its primary exports and a usage example.

See [`AGENTS.md`](./AGENTS.md) for agent guidance and
[the stack overview](https://github.com/TairuFramework/kigu/blob/main/docs/stack.md).
