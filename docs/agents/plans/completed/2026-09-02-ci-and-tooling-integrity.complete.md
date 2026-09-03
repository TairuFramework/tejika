# CI and tooling integrity — complete

**Status:** complete
**Date:** 2026-09-02
**Origin:** repo audit 2026-07-02 (repo config / CI / tooling section); roadmap
"Now" phase, step 1.

## Goal

Close the genuinely-open build/test/lint tooling gaps so CI and the local-commit
gate are trustworthy and self-consistent, and fix documentation that no longer
matched the code.

## Re-scope: three audit findings were already satisfied

Grounding the 2026-07-06 audit item against current repo state showed three of
its findings had been fixed by later changes; they were verified, not
re-implemented:

- **CI lint is not self-defeating.** CI runs `pnpm exec biome ci .` (non-mutating)
  via the shared `TairuFramework/kigu` workflow, not the repo's mutating `lint`
  script.
- **Biome guardrails already enforced.** The `@kigu/dev` preset the repo extends
  already sets `useConsistentArrayType` (generic), `useConsistentTypeDefinitions`
  (type), and `organizeImports` to error/on.
- **Fresh-clone build-order half-done.** `turbo.json`'s `test` task already
  declared `dependsOn: ["^build:js"]`.

## What was built (four tejika commits + one kigu commit)

1. **`turbo.json` task graph.** Removed the dead `clean` task and no-op `^clean`
   dependency; narrowed `build:js` inputs to concrete globs; added a cacheable
   `build:types` task and a repo-wide `test:types` gate.
2. **Pre-commit hook.** Replaced the mutating `biome check --write --staged`
   (which left fixes unstaged) with a non-mutating, fail-loud `biome check
   --staged` pointing at `pnpm lint`, and swapped the emitting `build:types`
   type-check for non-emitting `pnpm -r run test:types`. The hook no longer
   touches `lib/` or the index.
3. **`lint:ci` + `.gitignore`.** Added a non-mutating `lint:ci` (`biome ci .`)
   for local parity with CI; filled `.gitignore` gaps (`*.log`, `.DS_Store`,
   `*.tsbuildinfo`, `.env`, `.env.*`, `!.env.example`, `.superpowers/`).
4. **Documentation.** Corrected the `architecture.md` dependency graph
   (`get-port` belongs to `@tejika/env`, not `@tejika/server`; server has
   `@enkaku/protocol`); dropped the nonexistent `tests/integration/` reference
   and bumped `@enkaku` `0.18`→`0.21` in `development.md`; documented the
   `@kigu/dev` hoisted tool-binary contract; added a node-pty `spawn-helper`
   troubleshooting note to `packages/test/README.md`.
5. **`@kigu/dev` tsconfig preset (kigu repo, unpublished).** Added
   `verbatimModuleSyntax: true` and `noUncheckedIndexedAccess: true` to the
   shared preset — committed in the kigu repo, **not published**. See the
   follow-on `backlog/2026-09-02-adopt-stricter-kigu-tsconfig.md`.

## Key design decisions (rationale preserved)

- **Fail-loud, non-mutating pre-commit — not auto-fix-and-re-stage.** A
  `git add -u` re-stage of Biome's fixes would silently broaden a
  partially-staged commit to include unstaged hunks the author excluded, and
  index-preserving re-staging is fragile in a POSIX `sh` hook. A non-mutating
  check that fails and points at `pnpm lint` is correct and mirrors CI exactly.
- **Turbo outputs are disjoint by design.** SWC emits only `.js` (no source
  maps); `tsc` emits `.d.ts` + `.d.ts.map`. Scoping `build:js` to `lib/**/*.js`
  and `build:types` to the `.d.ts`/`.d.ts.map` globs avoids cache-restore
  overlap.
- **`test:types`/`build:types` depend on `^build:types`.** Package
  `tsconfig.test.json` extends the package tsconfig (NodeNext, no `paths`
  mapping), so cross-package `@tejika/*` type resolution goes through the
  imported package's built `lib/*.d.ts`. The dependency makes `turbo run
  test:types` self-sufficient. `test:types` is `cache: false` (type resolution
  spans the whole dependency graph — error-prone to enumerate as inputs; the
  check is fast).
- **Concrete turbo `inputs`, not `$TURBO_DEFAULT$`.** `$TURBO_DEFAULT$` expands
  to the full-package default and would not narrow anything; the shared preset
  version is captured by turbo's global hash (root `package.json` +
  `pnpm-lock.yaml`), not per-task globs.
- **Removing the dead `clean` node is behaviour-neutral.** A plain `build:js`
  (swc) does not empty `lib/` first, so a renamed/deleted source can leave a
  stale `.js`; pack/publish integrity is already protected by `prepack`'s
  `build:clean`. Wiring a real clean-before-build was left out of scope.
- **node-pty and phantom-deps are documentation, not code.** A published package
  (`@tejika/test`) must not carry a `postinstall` that runs on consumers; the
  repo's own CI (`test-platforms.yml`) already `chmod +x`es the helper, so the
  gap was consumer-facing docs. The hoisted-linker tool contract is intentional
  (`nodeLinker: hoisted` is pinned) and is verified transitively by `pnpm
  build`/`pnpm test`.
- **tsconfig hardening upstream, unpublished.** The `@kigu/dev` preset is the
  correct home so every stack repo benefits; decoupling the release kept this
  branch's scope and risk contained. `verbatimModuleSyntax` closes an SWC
  per-file transpile gap (an un-annotated type-only import can emit a runtime
  import `tsc` would not flag); `noUncheckedIndexedAccess` is a separately
  motivated strictness change.

## Deferred (not done, by decision)

- **Shared workflow `@main` pin.** kigu publishes no release tags and is a
  first-party same-org repo; pinning to a commit SHA buys reproducibility at the
  cost of a permanent manual-bump burden with no tag to track. Revisit when kigu
  starts tagging releases.
- **Adopting the stricter `@kigu/dev` tsconfig in tejika.** ~~Waits on a kigu
  release~~ — **done in this branch.** kigu published `@kigu/dev@0.3.0` carrying
  `verbatimModuleSyntax` + `noUncheckedIndexedAccess`; tejika bumped the range to
  `^0.3.0`. Only fallout was one `noUncheckedIndexedAccess` hit — a destructured
  `process.argv.slice(2)` in `packages/process/test/fixtures/stop-nonpositive-pid.ts`,
  fixed with an argument-presence guard. `pnpm build`/`pnpm test`/`biome ci` green.

## Verification

- `pnpm build` 7/7 (FULL TURBO), `pnpm test` 10/10 (all package suites green);
  `pnpm exec biome ci .` clean (127 files).
- `turbo run test:types` self-sufficient from a stale/absent `lib/` (10 tasks: 7
  `test:types` + 3 upstream `build:types`); `turbo run build:js --dry=json`
  confirmed the narrowed inputs and no `clean` task.
- Per-task reviews (all clean first pass) + a final whole-branch review (Opus,
  clean, merge-approved); the spec was reviewed by Codex before implementation.

## Informational (non-blocking, known)

- `pnpm test` and the hook's `test:types` assume upstream `lib/*.d.ts` already
  built; on a never-built fresh clone the type-check cannot resolve `@tejika/*`.
  This is the deliberate non-mutating tradeoff (the old hook built types but
  mutated `lib/`) and is pre-existing for `pnpm test`; dev/CI always build first.
