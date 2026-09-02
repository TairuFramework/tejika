# CI and Tooling Integrity — Design

**Date:** 2026-09-02
**Origin:** repo audit 2026-07-02 (repo config / CI / tooling section); roadmap
"Now" phase, step 1 (`next/2026-07-06-ci-and-tooling-integrity.md`).

## Goal

Close the genuinely-open gaps in tejika's build/test/lint tooling so the CI and
local-commit gates are trustworthy and self-consistent, and fix documentation
that no longer matches the code.

## Context: the audit re-scoped against current reality

The 2026-07-06 audit item predates several changes that already landed. Grounding
each finding against the current repo shrinks the work substantially. The
following audit findings are **stale or already fixed** and are verified-only in
this work, not re-implemented:

- **"CI lint is self-defeating."** The audit assumed CI runs the root `lint`
  script (`biome check --write`). It does not: the shared workflow
  (`TairuFramework/kigu/.github/workflows/build-test.yml`) runs
  `pnpm exec biome ci .` directly — non-mutating, and it fails the build on a
  violation. No CI lint change is needed.
- **"Guardrails unenforced by linter."** The `@kigu/dev/biome.json` preset the
  repo extends already sets `useConsistentArrayType` (`syntax: generic`),
  `useConsistentTypeDefinitions` (`style: type`), and `organizeImports` to
  `error`/`on`. The `Array<T>` / `type` guardrails are enforced today.
- **"Fresh-clone build-order for `pnpm test`."** `turbo.json`'s `test` task
  already declares `dependsOn: ["^build:js"]`, so `pnpm test` builds upstream
  package outputs before running. This half of the finding is done.

## Work items (tejika-local)

### 1. Pre-commit hook correctness

`.githooks/pre-commit` has two defects:

- **L6** runs `pnpm biome check --write --staged` but never re-stages the files
  Biome rewrites, so a commit ships pre-fix content with the fixes left
  unstaged in the working tree. Re-stage after the autofix (`git add` the
  staged set) so the commit contains the fixed content, or fail loudly if the
  autofix changed anything. Chosen approach: re-stage — run the fix, then
  `git add -u` the paths that were already staged, so the commit is
  self-consistent and the hook stays non-blocking for autofixable issues.
- **L13** runs `pnpm run build:types`, which emits declaration files into
  `lib/` (mutating, slow) purely as a type-check. Replace with the non-emitting
  per-package type-check: `pnpm -r run test:types` (each package's
  `test:types` is `tsc --noEmit --skipLibCheck -p tsconfig.test.json`).

Verify the hook with native Biome behaviour, not the `rtk` wrapper (the audit
recorded that `rtk lint biome` reported a real import-order violation as clean).

### 2. `turbo.json` correctness and coverage

Current `turbo.json`:

```json
{
  "tasks": {
    "clean": {},
    "build:js": { "dependsOn": ["^clean"], "outputs": ["lib/**"] },
    "test": { "dependsOn": ["^build:js"], "cache": false }
  }
}
```

- **Dead `^clean` dependency.** No package defines a `clean` script (they define
  `build:clean`, `del lib`), and the `clean` task body is empty. `build:js`'s
  `dependsOn: ["^clean"]` is therefore a no-op that only adds a phantom node to
  the graph. Remove the dead `clean` task and the `^clean` dependency — each
  package's own `build:js` already runs against a fresh `swc` output directory,
  and pack/publish integrity is handled by `prepack`'s `build:clean`
  (established in the publishing-readiness work). Turbo does not need to model
  cleaning.
- **Missing `inputs`.** `build:js` has no `inputs` filter, so unrelated changes
  invalidate its cache. Add `inputs` scoped to each package's sources and swc
  config (`src/**`, `tsconfig*.json`, and the shared `swc.json`/`tsconfig`
  inputs via `$TURBO_DEFAULT$`) so the cache is correct and useful.
- **Type-check task modeled.** Add a `test:types` task (`cache: false` or
  inputs-scoped) so `turbo run test:types` is available as the repo-wide
  type gate, matching the per-package `test:types` script. Keep `test`'s
  existing `dependsOn: ["^build:js"]`.

### 3. Local `lint:ci` script for dev/CI parity

The root `lint` script mutates (`biome check --write ./packages`); there is no
non-mutating local equivalent, so a developer cannot reproduce the CI lint gate
from a script. Add `"lint:ci": "biome ci ."` to the root `package.json` scripts,
mirroring exactly what the shared workflow runs. CI itself is unchanged (it
already calls `biome ci .` inline); this is local parity only.

### 4. `.gitignore` gaps

Add the missing common ignores: `*.log`, `.DS_Store`, `.env*`, `*.tsbuildinfo`,
and `.superpowers/` (currently only ignored via its own nested `.gitignore`).
Keep the existing entries.

### 5. Documentation drift

- **`docs/agents/architecture.md`** dependency-graph block (~L45-51):
  - The `@tejika/server` line reads
    `env + @enkaku/http-serve + hono + @hono/node-server + get-port`. This is
    wrong twice: server has no `get-port` dependency, and it omits
    `@enkaku/protocol` (a real dependency). Correct to
    `env + @enkaku/{http-serve,protocol} + hono + @hono/node-server`.
  - `get-port` is a dependency of `@tejika/env` (`env-paths` + `get-port`); note
    it on the `@tejika/env` line so the graph places it correctly.
- **`docs/agents/development.md`** (Repo-specific section):
  - Remove the "Integration tests at `tests/integration/`" sentence — no such
    directory exists and the shared workflow's `integration-tests-dir` input is
    never passed, so nothing runs there. (No integration suite is being added;
    the reference is simply stale.)
  - The same paragraph says the repo "Consumes `@enkaku` 0.18"; the catalog
    pins `@enkaku/*` at `^0.21.x`. Update the version to `0.21`.

### 6. node-pty exec-bit note (doc, not code)

`@tejika/test` depends on `node-pty`, whose prebuilt `spawn-helper` sometimes
installs without the executable bit, producing an opaque `posix_spawnp failed`
when a PTY is spawned. Because `@tejika/test` is published to npm, a
`postinstall` guard would run on every consumer's install — undesirable.
Instead, document the failure mode and the `chmod +x` remedy in the
`@tejika/test` package README (a follow-on work item will create per-package
READMEs; until then, add a short note to the package's existing docs or a
`TROUBLESHOOTING` note). Scope here: a documentation note only, no lifecycle
script.

### 7. Phantom dev-dependency contract (doc, not code)

`vitest`, `tsx`, and `del` (`del-cli`) resolve in each package only by hoisting
from `@kigu/dev`. The repo pins `nodeLinker: hoisted` in `pnpm-workspace.yaml`,
so this is an explicit, intentional contract of the kigu tooling preset, not an
accident. Document the decision (a short note in `docs/agents/development.md` or
alongside the tooling notes) stating that test/build tooling binaries are
provided transitively by `@kigu/dev` under the pinned hoisted linker, and that
packages therefore do not redeclare them. No per-package dependency additions.

## Cross-repo item (decoupled from this branch)

### tsconfig hardening — upstream in `@kigu/dev`, no release

SWC transpiles per file, so without `verbatimModuleSyntax` an un-annotated
type-only import can emit a runtime `import` that `tsc` will not flag. The fix
belongs in the shared preset, not a per-repo override. In the **kigu** repo,
add to `@kigu/dev/tsconfig.json`'s `compilerOptions`:

- `"verbatimModuleSyntax": true`
- `"noUncheckedIndexedAccess": true`

Commit this in the kigu repo. **Do not publish.** tejika continues to consume
the currently-released `@kigu/dev@^0.2.1`, so this branch's build is unaffected;
tejika (and the other stack repos) adopt the stricter preset when kigu next
releases and each repo bumps `@kigu/dev` — at which point any resulting type
errors are fixed per repo. This item is validated only insofar as the kigu
package itself still type-checks; it is intentionally not wired into tejika's CI
in this work.

## Decisions and rationale

- **Re-scope over re-implement.** Three audit findings were already satisfied by
  changes that post-date the audit; re-doing them would add churn and risk
  regressions. They are verified, not rewritten.
- **Re-stage, don't fail, in pre-commit.** A blocking hook on autofixable issues
  is hostile to flow; re-staging Biome's own fixes keeps the commit consistent
  while staying non-blocking. Genuinely un-fixable lint/type errors still fail
  the hook (Biome/`tsc` non-zero exit).
- **Drop turbo `clean` modeling entirely** rather than wire a real `clean`
  dependency. Clean-before-build integrity is already guaranteed where it
  matters (`prepack`); a turbo `clean` node only complicates the graph.
- **Workflow ref stays `@main`.** kigu publishes no release tags, and it is a
  first-party same-org repo; pinning to a commit SHA buys reproducibility at the
  cost of a permanent manual-bump burden with no upstream tag to track. Revisit
  when kigu starts tagging releases.
- **node-pty and phantom-deps are documentation, not code.** A published package
  must not carry a `postinstall` that runs on consumers, and the hoisted-linker
  tool contract is intentional — both are best captured as documented
  decisions.
- **tsconfig hardening upstream, unreleased.** The preset is the correct home so
  every stack repo benefits; decoupling the release keeps this tejika branch's
  scope and risk contained.

## Out of scope / deferred

- Wiring the stricter tsconfig into tejika's build (waits on a kigu release +
  `@kigu/dev` bump).
- Per-package and root READMEs (`next/2026-09-02-package-readmes-and-metadata.md`)
  — the node-pty note lands wherever `@tejika/test` docs live now and moves into
  its README when that work runs.
- Any change to the shared kigu workflow file itself.

## Verification

- `pnpm exec biome ci .` clean (native Biome, **not** `rtk`).
- `pnpm build` and `pnpm test` green.
- Pre-commit hook: a deliberately mis-formatted staged file is auto-fixed **and
  re-staged** (commit contains fixed content); a genuine type error still blocks
  the commit.
- `turbo run build:js` and `turbo run test:types` succeed with the new task
  graph; no reference to a `clean` task remains.
- Docs match code: architecture.md server line lists `@enkaku/{http-serve,protocol}`
  and no `get-port`; development.md has no `tests/integration/` reference and
  says `@enkaku` `0.21`.
- kigu: `@kigu/dev` still type-checks with the two added compiler options; change
  committed in the kigu repo, unpublished.
