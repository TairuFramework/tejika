# Tejika Roadmap

## Phase 1 + 2 — Foundation + CLI packages (DONE)
- All five `@tejika/*` packages built and published at `0.1.0`: `env`, `process`,
  `server`, `cli`, `ui`. See `completed/2026-06-20-tejika-packages-extraction.partial.md`.

## Now — Audit hardening (from repo audit 2026-07-02)

Packages are live on npm, so security and publish correctness come first.
Order of attack (each item is a plan in `next/`):

1. `2026-07-06-server-security-hardening.md` — Host gate scope + network-mode
   auth (security, small diffs).
2. `2026-07-06-publishing-readiness.md` — LICENSE, metadata, `react`/`ink` to
   peer deps, release automation.
3. `2026-07-06-ci-and-tooling-integrity.md` — non-mutating `lint:ci`,
   pre-commit fix, turbo/biome/tsconfig.
4. `2026-07-06-port-and-cli-option-validation.md` — env + CLI port validation,
   preAction hook fix.
5. `2026-07-06-process-daemon-robustness.md` — daemon boot lock,
   `EPERM`/PID-recycling, shutdown, timeouts.
6. `2026-07-06-ui-input-safety-and-polish.md` — `isActive` key handling +
   interaction tests.

Test backfill is folded into each plan's acceptance rather than a separate
pass. Remaining env mediums: `backlog/2026-07-06-env-paths-hardening.md`.

## Next — Mokei adopts `@tejika/*`
- Migrate Mokei to consume the five packages and delete its duplicated code.
  See `next/2026-06-20-mokei-tejika-migration.md`. Can proceed in parallel with
  hardening; API-shape items (daemon handle/AbortSignal, `getPIDPath` rename)
  are cheapest before more consumers land.

## Later (separate repos / specs)
- Other consumer migrations.
- Consumer-driven API seams: `backlog/2026-07-05-extend-process-daemon-serving-and-client.md`,
  `backlog/2026-06-24-widen-attach-enkaku-transport-allowed-origin.md`.
