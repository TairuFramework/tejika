# Publishing readiness — complete

**Status:** complete
**Date:** 2026-09-02
**Origin:** repo audit 2026-07-02 (findings H4/H5 + publishing items); roadmap "Now" phase, step 2.

## Goal

Make the published `@tejika/*` tarballs publish-correct across all seven
publishable packages (`env`, `log`, `process`, `server`, `cli`, `ui`, `test`).

## What was built

1. **LICENSE** — MIT (Paul Le Cam, 2026) at the repo root and copied into every
   package directory, with `"LICENSE"` added to each `files` array. Every
   tarball now carries the license regardless of publisher.
2. **`engines.node` `>=24`** on all seven manifests (CI already tests Node
   24/26; a published floor was previously absent).
3. **Conditional exports** — `{".": {"types": "./lib/index.d.ts", "default":
   "./lib/index.js"}}` on all seven, with the top-level `main`/`types` fields
   retained as a legacy-resolver fallback. publint clean; NodeNext type
   resolution for internal `@tejika/*` cross-imports verified intact.
4. **No-map pack/publish build** — each package replaced `prepublishOnly` with
   `prepack` running `build:clean && build:js && build:types:ci`; the root
   `release` script now builds via `build:ci`. Tarballs no longer ship dangling
   `.d.ts.map` files that referenced unpublished `../src`.
5. **`react`/`ink` as peer dependencies** — moved out of `dependencies` into
   `peerDependencies` for `@tejika/cli` and `@tejika/ui` (the React/Ink-rendering
   packages), plus `catalog:` `devDependencies` for local build/test.
   `@inkjs/ui` stays a regular dependency of `ui`.
6. **Release intents** — `.changeset/publishing-readiness.md` records a `minor`
   bump for all seven, capturing this work for the next release.

## Key design decisions (rationale preserved)

- **Release stays manual, no changesets tooling.** The 2026-07-02 audit's
  "set up changesets + publish workflow" recommendation was superseded: the
  stack standard is pnpm's built-in versioning (intents + `.changeset/ledger.yaml`
  + `pnpm run release`), which this repo already had. No `@changesets/*` was
  added and no CI publish workflow was introduced.
- **`prepack`, not `prepublishOnly`.** `pnpm pack` does not run `prepublishOnly`
  (only `prepack`/`prepare`/`postpack`); `pnpm publish` runs `prepack` too. And
  `--declarationMap false` only stops *new* maps being emitted — `build:clean`
  (`del lib`) is what removes stale ones. Hanging the clean no-map build off
  `prepack` makes `pnpm pack` and `pnpm publish -r` produce identical tarballs.
- **Peer ranges widened and decoupled from the dev catalog** — `react ^19.0.0`,
  `ink ^7.0.0` rather than the catalog's tested floors (`^19.2.8`/`^7.1.1`), so
  a compatible React 19 / Ink 7 consumer is not rejected over a patch floor.
- **All seven get a minor bump.** `engines.node >=24` raises the runtime floor
  (a consumer on older Node can no longer install) — a breaking change, hence a
  minor for pre-1.0 packages, not a patch. `cli`/`ui` also carry the peer move.
- **Per-package LICENSE copies kept despite pnpm 11 auto-copying the root
  LICENSE** — as an explicit tool-independence policy so the license ships under
  `npm pack`, `pnpm pack`, or `pnpm publish` alike.

## Verification

- `pnpm build` + `pnpm test` green (357 tests / 37 files).
- `pnpm publish -r --dry-run` confirmed `prepack` fires for all seven; zero
  `.d.ts.map` in any packed artifact; packed tarballs include `LICENSE`.
- publint clean on every exports map (only a pre-existing `repository.url`
  metadata suggestion remained). attw clean for ESM consumers.
- `pnpm change status` plans all seven at `minor`.
- Two independent whole-branch reviews (Opus + Codex), both clean.

## Out of scope (deferred)

- Per-package and expanded root READMEs (blank npm pages) — see
  `next/2026-09-02-package-readmes-and-metadata.md`.
- Hand-writing the prior `@tejika/env` / `@tejika/cli` breaking-change notes from
  the 2026-07-13 port-and-CLI-option-validation branch — a release-time task,
  handled when those packages next publish.
