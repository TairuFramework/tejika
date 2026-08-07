# Design: `getLogDir()` in `@tejika/env`, and a new `@tejika/log` package

**Date:** 2026-08-07
**Branch:** `feat/log-dir-and-file-sink`
**Triages:** `docs/agents/plans/next/2026-08-07-sakui-request-log-dir-and-file-sink.md`

Sakui asked for two things: a shared log-directory helper, and a file-sink factory so hosts stop
hand-configuring `@logtape/file`. Both are accepted. The sink is the reason the path helper exists,
so they land together.

## 1. `@tejika/env`: `getLogDir(app)`

```ts
export function getLogDir(app: string): string {
  return getAppEnvVar(app, 'LOG_DIR') ?? envPaths(app, { suffix: '' }).log
}
```

Exported from `packages/env/src/paths.ts` and `packages/env/src/index.ts`, following the same shape
as `getDataDir` and `getStateDir`: an `<APP>_LOG_DIR` override first, a platform default otherwise.

The default is the platform log location — `~/Library/Logs/<app>` on macOS,
`$XDG_STATE_HOME/<app>` (`~/.local/state/<app>`) on Linux, `AppData\Local\<app>\Log` on Windows — rather than Sakui's
invented `<dataDir>/logs`. Logs are the one thing every platform already has an opinion about, and
`env-paths` already exposes `.log`, so `@tejika/env` gains no new dependency.

## 2. `@tejika/process`: `spawnDaemon`'s default log path moves

`packages/process/src/spawn.ts` currently defaults to `join(getDataDir(app), 'daemon.log')`. It
becomes `join(getLogDir(app), 'daemon.log')`.

This is breaking for any consumer that does not pass `logPath`: the file moves, and nothing migrates
the old one. Sakui passes `logPath` explicitly
(`apps/cli/src/daemon/controller.ts`), so it is unaffected until it chooses to move.
`DaemonBootError` already carries the resolved path, so its error messages stay correct with no
change.

## 3. `@tejika/log`: the new package

A new package rather than an addition to `@tejika/env`. `@tejika/env` is the foundation every other
package depends on, and its dependencies are two small leaf libraries; putting `@logtape/file` there
would push a logging stack onto `@tejika/server` and `@tejika/cli`, which do not want one.

Dependencies: `@tejika/env` (workspace), `@logtape/file` (`^2.3.0`, a regular dependency), and
`@logtape/logtape` (`^2.3.0`, a peer dependency — the source of the `getConsoleSink` function and
the `Sink`/`Config`/`LogLevel` types). No dependency on `@sozai/log`: this package never calls
`setup()`/`configureSync()` itself, so it has nothing to gain from it and nothing to import from
it — `getConsoleSink` and the types it needs come from `@logtape/logtape` directly, which
`@sozai/log` was only re-exporting unchanged.

Why here rather than `@sozai/log`: `@sozai/log` runs in browsers as well as Node and must stay
environment-agnostic. `@tejika/*` is already filesystem- and process-bound — it owns pidfiles,
sockets, lockfiles, and platform paths — so a filesystem sink belongs beside the path helpers it
uses. `@sozai/log` provides the logger and the namespace; this package provides the place on disk.

### Why `@logtape/logtape` is a peer dependency

Logtape's configuration is process-global: `configureSync`/`setup()` sets it once for the whole
process, and a second `@logtape/logtape` module instance in the tree means a second, independent
piece of that global state — sinks configured through one instance are invisible to code that
imported the other. An app must run exactly one logtape instance, so every package that touches
logtape's API declares it as a peer and lets the host's package manager collapse everyone onto one
copy, rather than each package pinning (and thereby risking multiplying) its own.

`@logtape/file` stays a regular dependency, not a peer: it holds no global state — it only builds
`Sink` values — so there is no instance-multiplication risk to guard against by forcing it onto the
host. Making it a peer would also mean every host has to know `@logtape/file`'s own option names
just to satisfy the peer requirement, which defeats the point of this package hiding them.

### 3.1 `createFileSink`

```ts
export type FileSinkOptions = {
  app: string
  name: string
  dir?: string                          // default: getLogDir(app)
  format?: 'text' | 'jsonLines'         // default: 'text'
  rotate?: 'daily' | 'hourly' | false   // default: 'daily'
  retentionDays?: number                // default: 30; ignored when rotate is false
  sync?: boolean                        // default: false
}

export function createFileSink(options: FileSinkOptions): Sink
```

Behaviour:

- Creates the directory if missing, recursively, with mode `0o700`. Local logs are personal data,
  the same reasoning that gives the socket directory its mode.
- Filenames: `<name>-YYYY-MM-DD` under `rotate: 'daily'`, `<name>-YYYY-MM-DDTHH` under `'hourly'`,
  and a bare `<name>` when rotation is off. The extension is `.log` for `text` and `.jsonl` for
  `jsonLines`.
- `format` selects logtape's default text formatter or `getJsonLinesFormatter()`.
- `retentionDays` becomes `maxAgeMs`; older files are pruned on rotation. With `rotate: false` there
  is no rotation to prune on, so the option is ignored.
- `sync: true` sets `bufferSize: 0`, flushing each record as it is written. The default is buffered:
  most logs are human-read daemon output where a lost tail on a hard kill costs nothing. A corpus
  whose records must survive the process opts in — an unflushed record is a lost record.
- Rotation delegates to `getTimeRotatingFileSink`; `rotate: false` uses `getFileSink`.

### 3.2 `createFileLogConfig`

```ts
export type FileLogTarget = Omit<FileSinkOptions, 'app'> & {
  category: string | Array<string>
  level?: LogLevel                      // default: 'info'
}

export type FileLogConfigOptions = {
  app: string
  files: Array<FileLogTarget>
  console?: boolean | LogLevel          // default: false
}

export function createFileLogConfig(options: FileLogConfigOptions): Config<string, string>
```

No `configureFileLogging` wrapper: `@tejika/log` does not call `setup()`/`configureSync()` at all,
because that would mean touching logtape's process-global configuration from a package that does
not own the app's logging lifecycle. `createFileLogConfig` is a pure builder — the host passes its
result to `@sozai/log`'s (or its own) `setup()` itself. That call is genuinely one line
(`setup(createFileLogConfig({ ... }))`), so the wrapper was saving little while adding a second
place that knew about `setup()`'s first-call-wins behaviour. A host with a layout this builder does
not cover builds its own `Config` the same way and calls `setup()` on it identically; the builder
itself stays testable without touching logtape's process-global state.

Semantics:

- One sink per target, keyed by the target's `name`. Two targets sharing a name throw, rather than
  silently collapsing into one file.
- Every file logger entry carries `parentSinks: 'override'`. Logtape's default `'inherit'` unions a
  category's sinks with its parent's, so without this a console root entry would also print every
  file record to stdout — the double-write that `@sozai/log`'s `getDefaultConfig` comment documents.
- `console: false` (the default) adds `{ category: ['logtape', 'meta'], lowestLevel: 'error', sinks:
  [] }`, keeping logtape's own meta records out of the app's log files.
- `console: true` or `console: <level>` instead adds a console sink and the root entry
  `{ category: [], lowestLevel: level ?? 'error', sinks: ['console'] }`, mirroring
  `@sozai/log`'s `getDefaultConfig`. Logtape counts a `category: []` entry as configuring the meta
  logger, so no separate suppression entry is needed in this case.

There is no `reset` option on the builder: `createFileLogConfig` never calls `setup()`, so there is
nothing here to reset. `@sozai/log`'s `setup()` returns early when logging is already configured and
DISCARDS the config it was handed — a `reset` flag placed inside that config would never reach
`configureSync` and would be silently swallowed — so a host that means to reconfigure calls
`@sozai/log`'s `reset()` itself, before `setup()`. `createFileLogConfig`'s doc comment carries this
warning for exactly that caller.

### 3.3 What Sakui's host code becomes

```ts
import { reset, setup } from '@sozai/log'
import { createFileLogConfig } from '@tejika/log'

reset()
setup(
  createFileLogConfig({
    app: 'sakui',
    files: [{ name: 'miss', category: ['sakui', 'runtime', 'miss'], format: 'jsonLines', sync: true }],
  }),
)
```

replacing the `mkdirSync` + `getTimeRotatingFileSink` + hand-built `Config` in
`apps/cli/src/tui/miss-logging.ts`, and removing Sakui's direct `@logtape/file` dependency. The
desktop worker attaches the same sink with the same one call. Migrating Sakui is out of scope for
this repo's work; it happens in the Sakui repo once these versions publish.

## 4. Tests

`packages/env/test/paths.test.ts` gains a `getLogDir` block with the three cases its neighbours
already have: a deterministic per-app path, the `MYAPP_LOG_DIR` override winning, and an
empty-or-whitespace override falling back to the default.

`packages/log/test/file-sink.test.ts`, with `MYAPP_LOG_DIR` pointed at an `mkdtemp` directory:

- a missing log directory is created;
- filename and extension follow `format` and `rotate`, including the unrotated bare name;
- `jsonLines` output parses one JSON object per line;
- under `sync: true`, a record is readable from disk without disposing the sink.

`packages/log/test/config.test.ts`:

- sink keys match target names, and a duplicate `name` throws;
- every file logger entry carries `parentSinks: 'override'`;
- `console: false` produces the meta-suppression entry, `console: true` produces the root entry
  instead;
- `configureFileLogging` end to end: log a record, read it back off disk. `reset()` runs in
  `afterEach`, since logtape's configuration is process-global.

`packages/process`: no existing test asserts the default log path — `controller.test.ts` and
`mutex.test.ts` both pass `logPath` explicitly. Add one that omits it, with `<APP>_LOG_DIR` pointed
at a temp directory, asserting the daemon's output lands at `<logDir>/daemon.log`.

## 5. Wiring and docs

- `pnpm-workspace.yaml` catalog gains `@logtape/file` and `@logtape/logtape` at `^2.3.0`, and
  `@sozai/log` at `^0.3.0`. `@sozai/*` is already in `minimumReleaseAgeExclude`.
- `packages/log/` mirrors `packages/env/`'s `package.json` scripts, `tsconfig.json`, and
  `tsconfig.test.json`.
- `@tejika/log` ships at `0.4.0`, matching the repo's lockstep versioning rather than starting at
  `0.1.0`. This repo has no changesets; `env` and `process` bump with the rest at release time.
- `AGENTS.md`'s package overview and `docs/agents/architecture.md`'s package list and dependency
  graph both gain `log`: `env + @logtape/file + @logtape/logtape + @sozai/log`.
- The `daemon.log` move is called out as breaking for consumers who never passed `logPath`.
- On completion, the originating request moves to `docs/agents/plans/completed/` with the triage
  outcome recorded. This design document is ephemeral and does not move with it.

## Out of scope

- Migrating Sakui to the new API, which happens in the Sakui repo.
- Moving any existing `daemon.log` file, or reading from the old location as a fallback.
- Size-based rotation, remote sinks, and log-reading or tailing helpers. Nothing asks for them yet.
