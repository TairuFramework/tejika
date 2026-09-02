# `@tejika/env` path-hardening follow-ups

**Priority:** backlog (low-severity cleanups deferred from the env-paths hardening
work; see `docs/agents/plans/completed/2026-09-02-env-paths-hardening.complete.md`).
**Where:** `packages/env/test/env-var.test.ts`, `packages/cli/src/options.ts`.

## Findings

### Duplicate `appEnvVar` tests (low)

`packages/env/test/env-var.test.ts` gained a `describe('appEnvVar')` block whose
"slugifies a normal app name" and "collapses non-alphanumerics" cases duplicate
pre-existing coverage in the same file; only the digit-prefix case was new. Trim
the redundant two so the suite has one home for that behavior.

### Stale `withSocketPath` option doc (low)

`packages/cli/src/options.ts` — the `WithSocketPathOptions.name` doc says the
named socket resolves "under the app data dir." Since the hardening work, a
`<APP>_SOCKET_PATH` override anchors a named socket to `dirname(override)`, falling
back to the data dir only when no override is set. Update the comment to match
(the behavior itself is correct and covered by tests).

## Acceptance

- `env-var.test.ts` has a single, non-redundant set of `appEnvVar` cases.
- `WithSocketPathOptions.name` doc describes the override-anchor-then-data-dir
  resolution.
