# Tejika Architecture

Tejika (手近, "near at hand") is a **local-side** foundation library —
the counterpart to Enkaku (遠隔, "remote"). Enkaku provides the transport/remote
primitives; tejika provides everything at hand on the local machine: local paths,
ports, daemons, and HTTP servers. Tejika sits **above Enkaku and below** the
apps that compose these packages.

## Packages

- **`@tejika/env`** — deterministic local paths, ports, and env-var overrides
  (`getDataDir`, `getStateDir`, `getLogDir`, `getSocketPath`, `getPIDPath`,
  `getLockPath`, `getPort`, `parsePort`, `resolvePort`, plus the `appEnvVar` /
  `getAppEnvVar` override helpers). The foundational concern with no `@tejika` deps.
  `@tejika/env` sockets are POSIX unix-domain `.sock` files (guarded against the
  `sun_path` limit — 104/108 bytes including the NUL, so 103/107 usable) and Windows
  named pipes (`\\.\pipe\<name>-<hash>`, where the hash of the resolved anchor scopes the
  machine-global pipe name to the profile/user so distinct data dirs do not collide).
  `getSocketPath` branches on platform and exposes `isNamedPipe`, which `@tejika/process`
  uses to skip the filesystem-only socket steps (parent-dir `mkdir`, `chmod`, stale-file
  cleanup) for pipes — so it runs on both.
- **`@tejika/log`** — local log files: `createFileSink` (a rotating `@logtape/file`
  sink under `getLogDir(app)`) and `createFileLogConfig` (a whole logtape `Config`
  built from a list of file targets). Both are pure builders — this package never
  calls logtape's `setup()`/`configureSync()` itself; the host passes the result to
  `@sozai/log`'s (or its own) `setup()`. `@logtape/logtape` is a peer dependency, not
  a regular one, so the host controls the single logtape instance its process runs.
- **`@tejika/process`** — local daemon lifecycle: detached spawn, foreground
  bootstrap, pidfile/split-brain guard (daemon locking via `@sozai/lock`), and
  Enkaku client management with reconnect backoff.
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
@tejika/env       no @tejika deps; env-paths + get-port (foundational)
@tejika/log       env + @logtape/file (@logtape/logtape peer, no @sozai/log)
@tejika/process   env + @enkaku/{socket,client,protocol,server} + @sozai/lock + nano-spawn
@tejika/server    env + @enkaku/{http-serve,protocol} + hono + @hono/node-server
@tejika/cli       commander, ink, react; env (default option values)
@tejika/ui        ink, @inkjs/ui, react
@tejika/test      env + process + node-pty + strip-ansi (devDependency for consumers)
```

`env` underpins `log`, `process` and `server`. `cli` and `ui` are independent of each
other; consuming apps compose both. `test` builds on `env` + `process` and is
test-side only — consumers (including tejika's own packages) take it as a
devDependency.

## Key decision: depends on Enkaku directly

Tejika depends on `@enkaku/*` directly rather than re-exporting or wrapping it. The
version floor lives in the workspace catalog (`pnpm-workspace.yaml`) — currently
`@enkaku/* ^0.21`, `@sozai/* ^0.1` — and every package references it as `catalog:`. The local-process and HTTP-server packages use Enkaku transports and
client/server as-is. Bugs in `@enkaku/*` are fixed at the Enkaku source repo, never
worked around here.

The enkaku monorepo split (0.18 RPC) is documented in
`../kigu/docs/repo-split-design.md`; `@enkaku/socket` / `@enkaku/http-serve` are
the renamed transports.
