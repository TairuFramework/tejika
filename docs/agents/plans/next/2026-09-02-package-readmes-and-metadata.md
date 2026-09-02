# Per-package READMEs and metadata polish

**Priority:** next (follow-on from publishing readiness; low severity but every
published package currently has a blank/near-blank npm page).
**Origin:** deferred out of the publishing-readiness work
(`completed/2026-09-02-publishing-readiness.complete.md`).

## Problem

The seven published `@tejika/*` packages ship with no per-package README, so
their npm pages are blank. The root README is ~8 lines. Package metadata is
otherwise now complete (LICENSE, engines, exports, publishConfig, repository all
landed in the publishing-readiness work).

## Work

- **Per-package READMEs.** One `README.md` per package
  (`packages/{env,log,process,server,cli,ui,test}`) with: one-line purpose, an
  install line (`pnpm add @tejika/<pkg>`), and a minimal usage example of the
  package's primary export(s). Add `"README.md"` is not needed in `files` — npm
  always packs a package-root README — but confirm it appears in the tarball.
- **Root README.** Expand to the package table (purpose per package) plus a
  short install/usage orientation, matching the overview in `AGENTS.md`.
- **`repository.url` metadata suggestion.** publint emits a suggestion on the
  `repository.url` form for every package; normalise it (e.g. the
  `git+https://…​.git` form pnpm/npm prefer) so publint is fully clean.

## Acceptance

- Each of the seven packages has a README that renders a non-empty npm page.
- `pnpm dlx publint` on each package is fully clean (no `repository.url`
  suggestion remaining).
- Root README documents all seven packages.
