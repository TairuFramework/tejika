# Tejika Roadmap

## Phase 1 + 2 — Foundation packages (DONE)
- Seven `@tejika/*` packages built: `env`, `log`, `process`, `server`, `cli`, `ui`
  (runtime) + `test` (harness). Core five published at `0.1.0`; `log` added
  2026-08-08 (`completed/2026-08-08-log-dir-and-file-sink.complete.md`).
- First consumer proven: **Mokei adopts all six runtime packages** across
  host-node/host-monitor/cli — DONE 2026-09-01
  (`completed/2026-09-01-mokei-tejika-migration.complete.md`).

## Now — Audit hardening (from repo audit 2026-07-02) + API freeze prep

Packages are live on npm, so security and publish correctness come first.
Done: server-security (`completed/2026-07-07-server-security-hardening.complete.md`),
port-and-CLI-validation (`completed/2026-07-13-port-and-cli-option-validation.complete.md`),
daemon-robustness (`completed/2026-07-11-process-daemon-robustness.complete.md`).

Remaining, in order:

1. `next/2026-07-06-env-paths-hardening.md` — **first.** Breaking `getStateDir`→
   `getConfigDir` and `getPIDPath` renames + socket-length/Windows guards. Land
   before a release consumers pin, and before Sakui migrates.
2. `next/2026-07-06-publishing-readiness.md` — LICENSE, metadata, `react`/`ink`
   to peer deps, release automation.
3. `next/2026-07-06-ci-and-tooling-integrity.md` — non-mutating `lint:ci`,
   pre-commit fix, turbo/biome/tsconfig.
4. `next/2026-07-06-ui-input-safety-and-polish.md` — `isActive` key handling +
   interaction tests.

## Next — Sakui adopts `@tejika/*` (desktop)

Sakui is the active driver of new tejika work (it requested log-dir/file-sink and
the daemon `execPath` override, both now shipped). It is the next consumer focus:

- `backlog/2026-07-09-sakui-tejika-api-migration.md` — migrate Sakui to the current
  `@tejika/process` API (`runDaemon({ createTransport })` + `createDaemonTransport`),
  delete its bespoke daemon/controller code. Lands when Sakui next bumps the dep.
- `backlog/2026-09-01-windows-named-pipe-socket.md` — `getSocketPath` named-pipe
  support for Sakui's Windows desktop distribution (macOS target unaffected).

## Later
- Other consumer migrations (kubun `connector-explorer` surfaced
  `backlog/2026-06-24-widen-attach-enkaku-transport-allowed-origin.md`).
- Upstream: `backlog/2026-07-15-sozai-lock-max-hold-time.md` (`@sozai/lock`).
- Deferred internal cleanups: `backlog/2026-07-11-process-daemon-deferred-cleanups.md`,
  `backlog/2026-07-13-help-recursion-and-server-port-validation.md`,
  `backlog/2026-07-13-runink-exit-codes-and-non-tty-guard.md`,
  `backlog/2026-09-01-log-reserved-name-console-target.md`.
