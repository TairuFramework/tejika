# Adopt the stricter `@kigu/dev` tsconfig preset

**Priority:** backlog (gated on an upstream `@kigu/dev` release).
**Origin:** deferred out of the CI/tooling-integrity work
(`completed/2026-09-02-ci-and-tooling-integrity.complete.md`).

## Context

That work added `verbatimModuleSyntax: true` and `noUncheckedIndexedAccess: true`
to the shared `@kigu/dev` tsconfig preset **in the kigu repo, unpublished**.
tejika still consumes the lockfile-pinned `@kigu/dev@0.2.1`, so the stricter
options are not yet in effect here.

- `verbatimModuleSyntax` closes an SWC per-file transpile gap: an un-annotated
  type-only import can emit a runtime `import` that `tsc` never flags. This is
  the runtime-safety motivation.
- `noUncheckedIndexedAccess` types indexed access (`arr[i]`, `record[key]`) as
  possibly `undefined` — a broader, potentially source-breaking strictness
  change.

## Work

When `@kigu/dev` next publishes a release carrying the preset change:

- Update tejika's `@kigu/dev` (a `0.2.x` republish flows in on a lockfile
  refresh under the existing `^0.2.1` range; a `0.3.0`+ release needs a range
  bump in root `package.json`).
- Run `pnpm build` + `pnpm test` and fix any new type errors surfaced by the two
  options — chiefly missing `import type` annotations (verbatimModuleSyntax) and
  unguarded indexed access (noUncheckedIndexedAccess).
- This is per-repo work; each stack repo adopts on its own schedule.

## Acceptance

- tejika resolves a `@kigu/dev` release that includes the two compiler options.
- `pnpm build` / `pnpm test` green under the stricter preset with no
  `// @ts-expect-error` or option overrides added to work around it.
