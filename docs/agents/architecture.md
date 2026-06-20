# Tejika Architecture

Tejika (手近, "near at hand") is the **local-side** foundation for the Yulsi stack —
the counterpart to Enkaku (遠隔, "remote"). Enkaku provides the transport/remote
primitives; tejika provides everything at hand on the local machine: local paths,
ports, daemons, and HTTP servers. Tejika sits **above Enkaku and below**
Mokei / Kubun / Sakui, which compose these packages into apps.

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

## Dependency graph

```
@tejika/env       no @tejika deps (foundational)
@tejika/process   env + @enkaku/{socket-transport,client,server} + nano-spawn
@tejika/server    env + @enkaku/http-server-transport + hono + @hono/node-server + get-port
@tejika/cli       commander, ink, react; env (default option values)
@tejika/ui        ink, @inkjs/ui, react
```

`env` underpins `process` and `server`. `cli` and `ui` are independent of each
other; consuming apps compose both.

## Key decision: depends on Enkaku directly

Tejika depends on `@enkaku/*` (floor `^0.17`) directly rather than re-exporting or
wrapping it. The local-process and HTTP-server packages use Enkaku transports and
client/server as-is. Bugs in `@enkaku/*` are fixed at the Enkaku source repo, never
worked around here.
