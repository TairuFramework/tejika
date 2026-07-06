# CI and tooling integrity: non-mutating lint, pre-commit fix, turbo/biome/tsconfig gaps

**Priority:** next (step 3 of the 2026-07-02 audit's order of attack — CI integrity)
**Origin:** repo audit 2026-07-02 (repo config / CI / tooling section).
**Where:** root `package.json`, `.githooks/pre-commit`, `turbo.json`, `biome.json`, `tsconfig.build.json`, `.github/workflows/build-test.yml`, `.gitignore`, `docs/agents/`.

## Findings

### CI lint is self-defeating (med)

Root `lint` is `biome check --write ./packages`: CI auto-fixes violations in
its own checkout and passes; nothing fails, nothing lands. Add a non-mutating
`lint:ci` (`biome ci ./packages`) and have the kigu workflow call it.

### Pre-commit hook, same family (med)

`.githooks/pre-commit:6` auto-fixes staged files but never re-stages them, so
the commit ships pre-fix content with fixes left unstaged. Also L13 runs
`build:types` (mutates `lib/`, slow) as the type-check; use `test:types`
(`--noEmit`).

### turbo.json (med)

`build:js` `dependsOn: ["^clean"]` references a `clean` script no package
defines (they define `build:clean`) — the dependency is a no-op; no `inputs`
filter; only `build:js` is modeled (no test/lint/types tasks).

### Guardrails unenforced by linter (med)

Biome has `style/useConsistentArrayType` (`syntax: "generic"`) and
`style/useConsistentTypeDefinitions`; enable them so the `Array<T>` / `type`
guardrails aren't convention-only.

### tsconfig (med)

SWC per-file transpilation without `verbatimModuleSyntax` means un-annotated
type-only imports can emit broken runtime imports that tsc won't catch; also
consider `noUncheckedIndexedAccess`. Fix in `tsconfig.build.json` or upstream
in `@kigu/dev` — decide which; if upstream, file it there and note the link
here.

### Shared workflow pinned to `@main` (med)

`.github/workflows/build-test.yml:8` — mutable ref; pin a tag or commit SHA.

### Phantom dev deps (low-med)

`vitest` and `tsx` resolve only via hoisting from `@kigu/dev`; breaks under
isolated linkers. Declare per package (catalog entry) or accept as an explicit
kigu-preset contract (document the decision).

### .gitignore (low)

Missing `*.log`, `.DS_Store`, `.env*`, `*.tsbuildinfo`, `.superpowers/`
(currently only ignored via its own nested `.gitignore`).

### Docs drift (low)

- `docs/agents/architecture.md:28-29` puts `get-port` in `@tejika/server`
  (it's in `@tejika/env`) and omits `@enkaku/protocol`.
- `docs/agents/development.md:10` references `tests/integration/` which doesn't
  exist, and CI's `integration-tests-dir` input is never passed, so that step
  always skips. Reconcile (delete the reference or create the dir and pass the
  input).

## Acceptance

- CI fails on a deliberately introduced lint violation (verify once, then
  revert).
- Pre-commit either re-stages its fixes or fails loudly; type-check step uses
  `test:types`.
- `turbo.json` models build/test/lint/types with working `dependsOn` and
  `inputs`.
- Biome enforces `Array<T>` and `type` (repo passes with rules on).
- Shared workflow pinned to an immutable ref.
- Docs match reality (`architecture.md`, `development.md`).
