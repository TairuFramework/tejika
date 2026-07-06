# Tejika Architecture

Tejika (手近, "near at hand") is a **local-side** foundation library —
the counterpart to Enkaku (遠隔, "remote"). Enkaku provides the transport/remote
primitives; tejika provides everything at hand on the local machine: local paths,
ports, daemons, and HTTP servers. Tejika sits **above Enkaku and below** the
apps that compose these packages.

## Packages

- **`@tejika/env`** — deterministic local paths, ports, and env-var overrides
  (`getDataDir`, `getStateDir`, `getSocketPath`, `getPidPath`, `getPort`). The
  foundational concern with no `@tejika` deps.
- **`@tejika/process`** — local daemon lifecycle: detached spawn, foreground
  bootstrap, pidfile/split-brain guard, and Enkaku client management with
  reconnect backoff.
- **`@tejika/server`** — local Hono HTTP server, loopback-private by default
  (host/origin allowlists, bearer token) or opt-in `network` mode.
- **`@tejika/cli`** — commander + Ink plumbing (`buildProgram`, `runInk`,
  option builders). No domain components.
- **`@tejika/ui`** — generic Ink component kit (`StatusLine`, `ConfirmCard`,
  `SelectCard`, ...). Behavior-first; domain components stay in apps.
- **`@tejika/test`** — integration-test harness for tejika-built CLIs:
  node-pty `PTYDriver`, non-interactive `runCLI`, disposable env-override test
  profiles, daemon wait helpers, vitest globalSetup helpers. Consumed as a
  devDependency only.

## Dependency graph

```
@tejika/env       no @tejika deps (foundational)
@tejika/process   env + @enkaku/{socket,client,server} + nano-spawn
@tejika/server    env + @enkaku/http-serve + hono + @hono/node-server + get-port
@tejika/cli       commander, ink, react; env (default option values)
@tejika/ui        ink, @inkjs/ui, react
@tejika/test      env + process + node-pty + strip-ansi (devDependency for consumers)
```

`env` underpins `process` and `server`. `cli` and `ui` are independent of each
other; consuming apps compose both. `test` builds on `env` + `process` and is
test-side only — consumers (including tejika's own packages) take it as a
devDependency.

## Key decision: depends on Enkaku directly

Tejika depends on `@enkaku/*` (floor `^0.18`) directly rather than re-exporting or
wrapping it. The local-process and HTTP-server packages use Enkaku transports and
client/server as-is. Bugs in `@enkaku/*` are fixed at the Enkaku source repo, never
worked around here.

The enkaku monorepo split (0.18 RPC) is documented in
`../kigu/docs/repo-split-design.md`; `@enkaku/socket` / `@enkaku/http-serve` are
the renamed transports.
