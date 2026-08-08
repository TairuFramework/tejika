# Log directory helper and file sink — implementation

**Completed:** 2026-08-08. **Branch:** `feat/log-dir-and-file-sink`.
**Origin:** the Sakui request triaged in
`docs/agents/plans/completed/2026-08-07-sakui-request-log-dir-and-file-sink.complete.md`.

## Goal

Give hosts one shared answer for where local log files live, and one call that configures a
rotating log file, so no host has to know `@logtape/file`'s option names or re-derive the path
convention.

## What was built

- **`@tejika/env`: `getLogDir(app)`** — `getAppEnvVar(app, 'LOG_DIR') ?? envPaths(app).log`,
  following the shape of its neighbours in `packages/env/src/paths.ts`.
- **`@tejika/log`: a new package** exporting `createFileSink` (a configured `Sink` over
  `@logtape/file`) and `createFileLogConfig` (a logtape `Config` builder covering several file
  targets plus an optional console sink).
- **`@tejika/process`: `spawnDaemon`'s default log path moved** from `<dataDir>/daemon.log` to
  `<logDir>/daemon.log`.

## Key design decisions

**The log directory is the platform's own, not a subdirectory of the data dir.**
`~/Library/Logs/<app>` on macOS, `$XDG_STATE_HOME/<app>` on Linux, `AppData\Local\<app>\Log` on
Windows. Every platform already has an opinion about where logs go, and `env-paths` already
exposes `.log`, so honouring it cost `@tejika/env` no new dependency.

**A new package, not an addition to `@tejika/env`.** `@tejika/env` is the foundation every other
package depends on; putting `@logtape/file` there would push a logging stack onto `@tejika/server`
and `@tejika/cli`, which do not want one. And not in `@sozai/log`, which must stay
environment-agnostic for browser builds — `@tejika/*` is already filesystem-bound, so a filesystem
sink belongs beside the path helpers it uses.

**`@logtape/logtape` is a peer dependency, and `@tejika/log` never calls `setup()`.** Logtape's
logger tree lives on `globalThis[Symbol.for("logtape.rootLogger")]` and is shared across module
instances, but the `currentConfig` behind `isSetup()` is private to each instance. Two instances
therefore both report "not configured", both call `setup()`, and both push sinks onto the same
shared loggers — every record written twice. An app must run exactly one logtape instance, so
every package touching logtape's API declares it as a peer and lets the host collapse them onto
one copy. `@logtape/file` stays a regular dependency: it holds no global state, and making it a
peer would force every host to learn the option names this package exists to hide.

`createFileLogConfig` is therefore a pure builder — the host calls `setup()` on its result.
An earlier design had a `configureFileLogging` wrapper that called `setup()` itself; it was
dropped in the same refactor. It never shipped.

**Sink defaults: plain text, daily rotation, 30-day retention, buffered.** `format: 'jsonLines'`
and `sync: true` are the opt-ins for a corpus whose records must survive the process — an
unflushed record is a lost record.

**Every file logger entry carries `parentSinks: 'override'`.** Logtape's default `'inherit'`
unions a category's sinks with its parent's, so without this a console root entry would also print
every file record to stdout.

**Filenames are stamped from local time**, matching `@logtape/file`'s own rotation key, which uses
local calendar components. Stamping in UTC would have made the first rotation after start reopen
the same path outside the UTC offset, producing one file spanning two local days.

**`console: true` pins the meta logger separately** (`['logtape','meta']` at `'error'`, naming no
sink). A `category: []` root entry does count as configuring the meta logger, but leaves that
logger's own `lowestLevel` at `'trace'`, so a console level below `'info'` would let logtape's own
`configure()` notice through. The entry names no sink on purpose — it inherits the console below
and prints once, where a second `'console'` entry would print every meta record twice.

## Status

Complete. `@tejika/env` 53 tests, `@tejika/log` 29 tests, `@tejika/process` 119 tests, full suite
green across all 10 workspace tasks.

Breaking: `spawnDaemon` consumers that never passed `logPath` get a new `daemon.log` location, and
nothing migrates the old file. Sakui passes `logPath` explicitly, so it is unaffected until it
chooses to move.

## Deferred

One boundary of the reserved-name rule is untested: a file target named `console` while the
`console` option is off, which should be allowed.
