# Sakui request: `getLogDir()` in `@tejika/env`, and a file-sink factory over `@logtape/file`

**Filed:** 2026-08-07, from a Sakui project-loop review. **Origin repo:** `../sakui/`.
**Status:** proposal from a downstream consumer — not yet triaged by this repo.

Two related gaps, both surfaced building Sakui's miss log (a local-only JSONL corpus of unmatched
user intents, written by the CLI daemon and — next — by the desktop worker).

## 1. `@tejika/env`: a `getLogDir(app)` helper

`packages/env/src/paths.ts` exposes `getDataDir`, `getStateDir`, `getSocketPath`, `getPIDPath`
and `getLockPath`. There is no log directory.

Sakui invented its own convention — `<dataDir>/logs/` — in application code, which means:

- the CLI daemon and the desktop worker have nothing shared to agree on, so the desktop sink
  (still to be written) can silently pick a different location;
- the convention is not overridable the way the others are, since it never passes through
  `getAppEnvVar`.

**Ask:** `getLogDir(app: string): string`, following the same shape as its neighbours —
`getAppEnvVar(app, 'LOG_DIR') ?? <platform default>`. Whether the default belongs under the data
dir, the state dir, or `envPaths(app).log` is this repo's call; Sakui only needs one answer that
both of its hosts can import.

## 2. A file-sink factory over `@logtape/file`

`@sozai/log` re-exports only `getConsoleSink`, so any host wanting to write logs to disk takes a
direct `@logtape/file` dependency and hand-configures it. Sakui's CLI does exactly that today:

```ts
// roughly what Sakui's CLI hand-rolls
getTimeRotatingFileSink(join(sakuiLogDir(), 'miss-.jsonl'), {
  bufferSize: 0,          // synchronous flush — an unflushed miss is a lost miss
  // + rotation and retention, configured per-host
})
```

**Ask:** a small factory in this repo — `@tejika/env`, or a new `@tejika/log` if that reads
better — that takes an app name plus a log name and returns a configured rotating file sink,
defaulting its directory to `getLogDir(app)`. Something along the lines of:

```ts
createFileSink({ app, name: 'miss', rotate: 'daily', retentionDays: 30, sync: true })
```

Exact surface is this repo's call; the point is that a host should not have to know
`@logtape/file`'s option names or re-derive the path convention to get a rotating log file.

### Why here and not in `@sozai/log`

This was originally going to be filed against `@sozai/log` as "re-export `@logtape/file`'s
sinks". That is the wrong home: **`@sozai/log` has to stay environment-agnostic** — it runs in
browsers as well as Node, and pulling in a filesystem-bound sink would make it not so.
**`@tejika/*` is already allowed to be filesystem- and process-bound** (it owns pidfiles,
sockets, lockfiles, platform paths), so a filesystem sink belongs here, next to the path helpers
it would use.

That also keeps the layering honest for consumers: `@sozai/log` provides the logger and the
namespace, this repo provides the place on disk to put it. Sakui's runtime emits through
`getSakuiLogger(['runtime','miss'])` with no filesystem knowledge at all, and each host attaches
its own sink — that split is the design, and it only works if the filesystem half lives
somewhere a browser build never reaches.

## Sakui's stake

Concretely: the CLI daemon has a hand-rolled sink today, and the desktop worker needs an
equivalent one for dogfooding-floor Milestone 1. Landing these two would let both hosts share one
line of configuration instead of duplicating the convention — and would remove Sakui's direct
`@logtape/file` dependency.

Not urgent: Sakui's CLI path works as hand-rolled, and M1 is not currently scheduled.

## Outcome (2026-08-07)

Both asks accepted and implemented. `getLogDir(app)` landed in `@tejika/env`, defaulting
to the platform log directory (`envPaths(app).log`) rather than `<dataDir>/logs`, with a
`<APP>_LOG_DIR` override. The sink factory landed in a new `@tejika/log` package —
`createFileSink`, `createFileLogConfig`, `configureFileLogging` — keeping `@logtape/file`
out of the foundational `@tejika/env`. `spawnDaemon`'s default `daemon.log` moved under
the log dir, a breaking change for consumers that passed no `logPath`.

Sakui migrates in its own repo once these versions publish.
