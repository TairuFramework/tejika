# Publishing readiness: LICENSE, metadata, peer deps, exports, release automation

**Priority:** next (step 2 of the 2026-07-02 audit's order of attack — packages are live on npm)
**Origin:** repo audit 2026-07-02 (findings H4, H5 + publishing-related repo items).
**Where:** all five `packages/*/package.json`, repo root, `.github/workflows/`.

## High severity

### H4 — `react`/`ink` as regular dependencies (`@tejika/cli`, `@tejika/ui`)

`packages/ui/package.json:25-29` and `packages/cli/package.json:26-30` put
`react` and `ink` in `dependencies`. For libraries that render the consumer's
React elements, a version-mismatched app gets two React instances — "invalid
hook call" / broken Ink instance identity.

**Fix:** move to `peerDependencies` (catalog range) + `devDependencies` for
local dev. `@inkjs/ui` stays a regular dep (or peer alongside ink).

### H5 — Publishing gaps

- No LICENSE file anywhere despite `"license": "MIT"` in every package —
  published tarballs ship no license text. Add LICENSE at root, include in each
  package's `files`.
- No `repository`, `description`, `author`, `keywords`, `homepage` in any
  package; `repository` is required for npm provenance.
- No `publishConfig` (`access: "public"`, provenance) — scoped publish 402s
  without it.

## Medium severity

- **`engines.node` missing** everywhere — CI tests Node 24/26 but published
  packages declare no floor. Add `"engines": { "node": ">=24" }`.
- **No release automation** — no changesets, no publish workflow, no
  provenance; publishing is manual. Set up changesets + a publish workflow per
  the kigu:development release conventions.

## Low severity

- **exports maps** — bare-string form with no `types` condition in all five
  packages; works today via sibling `.d.ts` lookup under NodeNext but publint/
  attw flag it. Use
  `{".": {"types": "./lib/index.d.ts", "default": "./lib/index.js"}}`.
- **`declarationMap` in published tarballs** references unshipped `../src` —
  dangling `.d.ts.map`s (the `build:types:ci` no-map variant exists but plain
  `build` is what a manual publish runs). Ensure the publish path uses the
  no-map build or ships sources.
- **README** — 8 lines for a published package family; no per-package READMEs
  (blank npm pages). Expand root README with the package table + install/usage;
  add per-package READMEs.

## Breaking changes to record in release notes

The 2026-07-13 port-and-CLI-option-validation branch shipped these breaking
changes to `@tejika/env` and `@tejika/cli`. There is no changesets
infrastructure in this repo (see H5 above) — do not add any — so these must be
written into the release notes by hand when these packages are next published:

- `@tejika/env`: `getPort` (and `resolvePort`) now throw on `<APP>_PORT`
  override values they previously accepted via a loose `parseInt`: `'80abc'`,
  `'80.5'`, `'0x50'`, `0`, `-1`, `70000`.
- `@tejika/cli`: `--port` is now parsed into a `number` by an argParser;
  previously it was passed through as a raw `string` when supplied on the
  command line.
- `@tejika/cli`: a leaf action can no longer read an ancestor command's
  `--port`/`--socket-path` via `opts()` (or its `action` handler's `options`
  argument) — the resolved default now lands on the option's owning command,
  not the leaf. Callers must use `optsWithGlobals()` instead.
- `@tejika/cli`: `runInk` no longer suppresses Ctrl+C (it forced
  `exitOnCtrlC: false`, inverting Ink's own default). An app that wants to
  intercept Ctrl+C itself must now pass `{ exitOnCtrlC: false }` explicitly.

## Acceptance

- A consumer app with its own `react`/`ink` gets a single React instance
  (peer-dep resolution); `pnpm build && pnpm test` green with the dep moves.
- Every published tarball contains LICENSE; `package.json` has `repository`,
  `description`, `publishConfig`, `engines`.
- `pnpm exec publint` (or attw) passes on each package's exports map.
- A changesets-driven publish workflow exists and is documented.
