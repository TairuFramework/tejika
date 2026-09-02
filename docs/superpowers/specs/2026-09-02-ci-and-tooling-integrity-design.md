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

- **L6** runs `pnpm biome check --write --staged`, which rewrites files in the
  working tree but never re-stages them, so a commit ships pre-fix content with
  the fixes left unstaged. A naive re-stage (`git add -u` the staged paths) is
  **rejected**: `git add -u <path>` stages the file's entire working-tree
  version, so for a partially-staged file it would silently sweep in unstaged
  hunks the author deliberately excluded. Index-preserving re-staging (formatting
  only the staged blob, or stashing unstaged hunks around the fix) is fragile in
  a POSIX `sh` hook. Chosen approach: **make the hook non-mutating and
  fail-loud**, exactly mirroring CI. Run `pnpm biome check --staged
  --no-errors-on-unmatched` (no `--write`); on non-zero exit, print
  `Lint failed — run \`pnpm lint\` to fix, then re-stage.` and `exit 1`. The
  author fixes and re-stages explicitly; the hook never edits the index. This
  also removes the wrapper ambiguity — the hook calls `pnpm biome` directly, not
  `pnpm run`, so the `rtk` shim is not involved.
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
  the graph. Remove the dead `clean` task and the `^clean` dependency. This is
  **behaviour-neutral**: the dependency resolves to nothing today, so nothing
  currently cleans before a turbo `build:js` anyway. Note the pre-existing
  limitation this exposes rather than fixes — a plain `build:js` (`swc src -d
  lib`) does **not** empty `lib/` first, so a renamed or deleted source file can
  leave a stale `.js` behind, which local subprocess tests could pick up.
  Pack/publish integrity is already protected (`prepack` runs `build:clean`
  first, from the publishing-readiness work), and a full `pnpm build` per
  package runs `build:clean`. Wiring a real clean-before-build into the turbo
  graph is **out of scope** here (it would re-run swc from scratch on every
  build); this item only removes the dead node.
- **Missing `inputs`.** `build:js` has no `inputs`, so turbo's default hashes
  every file in the package plus the global deps — correct but over-invalidating
  (a README edit rebuilds). Adding `$TURBO_DEFAULT$` would **not** narrow this
  (it expands to exactly that full-package default), so specify concrete globs
  instead: `["src/**", "package.json", "tsconfig*.json",
  "$TURBO_ROOT$/tsconfig.build.json"]`. The shared `@kigu/dev` swc config and
  preset version live under `node_modules` and are captured by turbo's global
  hash (root `package.json` + `pnpm-lock.yaml`), not by per-task inputs — do not
  claim a per-task glob covers them. Verify the resulting input set with
  `turbo run build:js --dry=json` (inspect each task's `inputs`/hash) before
  accepting.
- **Type-check task modeled.** Add a `test:types` task with **`cache: false`**
  (chosen over inputs-scoped: type resolution depends on the full dependency
  graph and every package's `tsconfig.test.json` chain, which is error-prone to
  enumerate as inputs; the check is fast, so skip caching) so `turbo run
  test:types` is the repo-wide type gate matching the per-package script. Keep
  `test`'s existing `dependsOn: ["^build:js"]`.

### 3. Local `lint:ci` script for dev/CI parity

The root `lint` script mutates (`biome check --write ./packages`); there is no
non-mutating local equivalent, so a developer cannot reproduce the CI lint gate
from a script. Add `"lint:ci": "biome ci ."` to the root `package.json` scripts,
mirroring exactly what the shared workflow runs. CI itself is unchanged (it
already calls `biome ci .` inline); this is local parity only.

### 4. `.gitignore` gaps

Add the missing common ignores: `*.log`, `.DS_Store`, `*.tsbuildinfo`, and
`.superpowers/` (currently only ignored via its own nested `.gitignore`). For
environment files, use `.env` and `.env.*` with an explicit `!.env.example`
exception rather than a blanket `.env*` — a bare `.env*` would also ignore
shareable templates like `.env.example`. Keep the existing entries.

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

The repo's **own** CI already handles this: `.github/workflows/test-platforms.yml`
(L41-43) runs `find node_modules -type f -name spawn-helper -exec chmod +x {} +`
before its tests. The gap is purely **consumer-facing** — a downstream project
depending on `@tejika/test` hits the raw failure with no guidance. `@tejika/test`
already ships a README (`packages/test/README.md`), so the destination is
unambiguous: add a short "Troubleshooting" note there covering the
`posix_spawnp failed` symptom and the `chmod +x` remedy (and that CI runners may
need the same step). Scope here: a documentation note in the existing README
only, no lifecycle script.

### 7. Phantom dev-dependency contract (doc, not code)

`vitest`, `tsx`, `swc`, `tsc`, and `del` (`del-cli`) resolve in each package only
by hoisting from `@kigu/dev`. The repo pins `nodeLinker: hoisted` in
`pnpm-workspace.yaml`, so this is an explicit, intentional contract of the kigu
tooling preset, not an accident. Document the decision (a short note in
`docs/agents/development.md` or alongside the tooling notes) stating that
test/build tooling binaries are provided transitively by `@kigu/dev` under the
pinned hoisted linker, and that packages therefore do not redeclare them. No
per-package dependency additions.

Documentation alone does not *enforce* the contract — a future `@kigu/dev`
release that drops a binary would break every package silently. As cheap
insurance, note that this reliance is verified transitively by CI already:
`pnpm test` / `pnpm build` invoke every one of these binaries, so a missing tool
fails the build. The doc note should state that `@kigu/dev` owns this binary
surface and that removing a binary from it is a breaking change for consumers;
no new standalone resolve-check script is added (the existing build/test run is
the check).

## Cross-repo item (decoupled from this branch)

### tsconfig hardening — upstream in `@kigu/dev`, no release

Two independently-motivated compiler options are added to the shared preset
(both were chosen for the upstream home rather than a per-repo override):

- **`verbatimModuleSyntax: true`** — SWC transpiles per file with no
  cross-file type information, so an un-annotated type-only import can emit a
  runtime `import` that `tsc` never flags. `verbatimModuleSyntax` forces
  `import type` on type-only imports at compile time, closing that gap. This is
  the primary runtime-safety motivation.
- **`noUncheckedIndexedAccess: true`** — a *separate* strictness concern (not
  implied by the import-safety rationale above): indexed access (`arr[i]`,
  `record[key]`) is typed as possibly `undefined`, catching a common class of
  latent bugs. It is a broader, potentially source-breaking change — each
  consuming repo may surface new errors on adoption. It is bundled here only
  because the user explicitly requested both options land together upstream;
  its blast radius is acknowledged and handled per-repo at adoption time.

In the **kigu** repo, add both to `@kigu/dev/tsconfig.json`'s `compilerOptions`.
Commit this in the kigu repo. **Do not publish.**

`@kigu/dev` is a config/asset package with no build or type-check script of its
own, so editing the JSON preset is not validated against any consumer in this
work — there is nothing in kigu to compile. tejika continues to consume the
lockfile-pinned `@kigu/dev@0.2.1`, so this branch is unaffected. Adoption
happens when a consumer's **lockfile** resolves a `@kigu/dev` release carrying
the change: a `0.2.x` republish flows in on a lockfile refresh under the
existing `^0.2.1` range with no manifest edit, whereas a `0.3.0`+ release needs
a range bump. Whichever path, the adopting repo runs its type-check at update
time and fixes any new errors then. This item is intentionally **not** wired
into tejika's CI here; its only in-loop deliverable is the committed, unpublished
kigu edit.

## Decisions and rationale

- **Re-scope over re-implement.** Three audit findings were already satisfied by
  changes that post-date the audit; re-doing them would add churn and risk
  regressions. They are verified, not rewritten.
- **Fail-loud, non-mutating pre-commit** rather than auto-fix-and-re-stage. A
  re-stage via `git add -u` would silently broaden a partially-staged commit to
  include unrelated unstaged hunks, and index-preserving re-staging is fragile in
  a `sh` hook. A non-mutating `biome check --staged` that fails and points at
  `pnpm lint` is correct, mirrors CI exactly, and never touches the author's
  index.
- **Drop turbo `clean` modeling entirely** rather than wire a real `clean`
  dependency. The removal is behaviour-neutral (the `^clean` dependency is
  already a no-op). Clean-before-build integrity where it matters is already
  guaranteed (`prepack`, per-package `build`); a turbo `clean` node only
  complicates the graph. The pre-existing stale-`lib/` limitation for plain
  `build:js` is noted, not fixed, here.
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
- Expanded per-package and root READMEs
  (`next/2026-09-02-package-readmes-and-metadata.md`). The node-pty note lands in
  the already-existing `packages/test/README.md` now; the broader README work is
  separate.
- Any change to the shared kigu workflow file itself.

## Verification

- `pnpm exec biome ci .` clean (native Biome, **not** `rtk`).
- `pnpm build` and `pnpm test` green.
- Pre-commit hook: a deliberately mis-formatted **staged** file makes the commit
  **fail** with the `pnpm lint` guidance (hook does not edit the working tree or
  index); after `pnpm lint` + re-stage the commit succeeds. A partially-staged
  file with separate unstaged edits: the hook never stages the unstaged hunks. A
  genuine type error still blocks the commit.
- `turbo run build:js` and `turbo run test:types` succeed with the new task
  graph; no reference to a `clean` task remains; `turbo run build:js --dry=json`
  shows the intended narrowed `inputs`.
- Docs match code: architecture.md server line lists `@enkaku/{http-serve,protocol}`
  and no `get-port`; development.md has no `tests/integration/` reference and
  says `@enkaku` `0.21`.
- kigu: `@kigu/dev/tsconfig.json` carries both new options and is valid JSON
  (the package has no compile step to run); change committed in the kigu repo,
  unpublished. Not wired into tejika CI.
