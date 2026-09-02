# Publishing readiness — design

**Date:** 2026-09-02
**Origin:** `docs/agents/plans/next/2026-07-06-publishing-readiness.md` (repo audit 2026-07-02, findings H4/H5 + publishing items).
**Branch:** `publishing-readiness`

## Context

The `@tejika/*` packages are live on npm, so publish correctness ranks above
CI/UI polish (roadmap "Now" phase, step 2). Since the 2026-07-06 audit was
written, much of it has already landed: every package manifest now carries
`repository`, `description`, `keywords`, `publishConfig.access: public`, and
`sideEffects: false`, and the repo already uses pnpm's built-in versioning
(`.changeset/ledger.yaml`, `versioning.changelog.storage: repository`,
`publishBranch: main`, a root `release` script, no stray root `version` script).

The audit's "set up changesets" recommendation is therefore **superseded** — the
stack standard is pnpm built-in versioning (see `kigu:releasing`), and this repo
already has it. No changesets tooling is added.

What remains is the genuinely-open subset below. Scope covers all seven
publishable packages: `env`, `log`, `process`, `server`, `cli`, `ui`, `test`.

## Decisions

- **Release stays manual.** Keep `pnpm run release`; no GitHub publish workflow
  is added. This branch only makes the manual publish path correct.
- **READMEs are deferred** to a separate backlog item (blank npm pages are not a
  publish-correctness blocker).
- **Publish uses the no-map build** so tarballs never ship dangling
  `.d.ts.map` files; source is not shipped.

## Work items

### 1. `react` / `ink` → `peerDependencies` (`cli`, `ui`) — H4

A library that renders the consumer's React elements must not pin its own
`react`/`ink`, or a version-mismatched app gets two React instances ("invalid
hook call", broken Ink instance identity).

- `packages/cli/package.json`: move `react` and `ink` out of `dependencies`
  into `peerDependencies` (`catalog:`), and add both to `devDependencies`
  (`catalog:`) so local build and tests still resolve.
- `packages/ui/package.json`: same move for `react` and `ink`. `@inkjs/ui`
  stays a regular `dependency`.

`catalog:` in `peerDependencies` is already proven in this repo —
`packages/log/package.json` declares `@logtape/logtape` as a `catalog:` peer.
The catalog ranges (`react: ^19.2.8`, `ink: ^7.1.1`) become the published peer
ranges.

### 2. LICENSE — H5

No LICENSE file exists anywhere, yet every manifest declares `"license": "MIT"`;
published tarballs currently ship no license text.

- Add a canonical `LICENSE` at the repo root: MIT, copyright holder
  "Paul Le Cam", year 2026.
- Commit a copy of that `LICENSE` into each of the seven package directories.
  npm/pnpm only pack a license file that lives in the package's own directory,
  not one at the workspace root.
- Append `"LICENSE"` to each package's `files` array (currently `["lib/*"]`).

The seven copies are static MIT text; drift is not a practical concern.

### 3. `engines.node` — Medium

CI tests Node 24 and 26 but no package declares a floor. Add
`"engines": { "node": ">=24" }` to all seven publishable manifests.

### 4. exports map + `types` condition — Low

All packages use the bare-string exports form (`".": "./lib/index.js"`) with a
separate top-level `types`. This resolves today under NodeNext via sibling
`.d.ts` lookup but publint/attw flag it. Change each to:

```json
"exports": {
  ".": {
    "types": "./lib/index.d.ts",
    "default": "./lib/index.js"
  }
}
```

Keep the top-level `main` and `types` fields as a legacy-resolver fallback.
Verify each package with `pnpm dlx publint`.

### 5. No-map publish build — Low

Plain `build` runs `build:types` (with `declarationMap`), so `files: ["lib/*"]`
ships `.d.ts.map` files that reference `../src`, which is not published — dangling
maps. The `build:types:ci` variant (`--declarationMap false`) already exists.

- In each package's `prepublishOnly`, run the no-map types step instead of the
  mapped one, so the final pre-pack build carries no `.d.ts.map`.
- Point the root `release` script's build at `build:ci`.

`prepublishOnly` runs during `pnpm publish -r`, so it is the authoritative build
before packing; fixing it there is sufficient.

### 6. Record release intents — release prep

Record `pnpm change` intents so the next release captures this work:

- minor bump for `@tejika/cli` and `@tejika/ui` (the peer-dependency move),
- patch bump for `env`, `log`, `process`, `server`, `test` (metadata/LICENSE/
  engines only).

Performing the actual release stays out of scope (manual, `kigu:releasing`).

## Out of scope

- Per-package and expanded root READMEs — separate backlog item.
- Hand-writing the prior `@tejika/env` / `@tejika/cli` breaking-change notes
  from the 2026-07-13 branch — a release-time task, handled when those packages
  next publish.
- Any GitHub publish workflow / CI-driven release.

## Acceptance

- `pnpm build && pnpm test` green after the dependency moves.
- `pnpm dlx publint` passes on each package's exports map.
- `pnpm pack` on a package produces a tarball that contains `LICENSE` and no
  `.d.ts.map` file.
- Each published manifest has `engines`, and `cli`/`ui` declare `react`/`ink` as
  `peerDependencies` (a consumer app supplies a single React instance).
- `pnpm change` intents recorded for the seven packages.
