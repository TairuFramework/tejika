# Publishing Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** qa
**Mode:** tasks

**Goal:** Make the published `@tejika/*` tarballs publish-correct — LICENSE, `engines`, conditional exports, no dangling declaration maps, and `react`/`ink` as peer dependencies of the React-rendering packages.

**Architecture:** Six mechanical, independently-reviewable changes across the seven publishable packages (`env`, `log`, `process`, `server`, `cli`, `ui`, `test`). Each task applies one concern to all affected manifests, then verifies with a concrete command (`pnpm build`, `pnpm test`, `pnpm dlx publint`, `pnpm pack`). No changesets tooling is added — the repo already uses pnpm built-in versioning.

**Tech Stack:** pnpm 11 workspaces + catalog, swc + tsc build, biome, vitest, `@kigu/dev`.

**Spec:** `docs/superpowers/specs/2026-09-02-publishing-readiness-design.md`

## Global Constraints

- **Seven publishable packages** (apply every cross-package concern to all): `packages/{env,log,process,server,cli,ui,test}`. The repo root (`tejika-repo`) is `private: true` and is NOT one of them.
- **Node floor:** `"engines": { "node": ">=24" }` — exact string.
- **LICENSE:** MIT, copyright holder `Paul Le Cam`, year `2026`.
- **Peer ranges (published):** `"react": "^19.0.0"`, `"ink": "^7.0.0"` — widened, decoupled from the dev catalog. Dev copies use `catalog:`.
- **Do NOT add changesets tooling.** Release stays manual (`pnpm run release`, `kigu:releasing`).
- **Conventions:** `type` not `interface`; `Array<T>` not `T[]`; no `any`; ES private fields not `private`/`readonly`; `ID`/`HTTP` casing. (Little code here, but honor them.)
- **Lint/build commands:** invoke tools directly, NOT `pnpm run lint`/`pnpm lint` — the machine's `rtk` shim redirects `pnpm run` scripts. Use `pnpm exec biome check --write ./packages` for lint and the `pnpm` top-level commands (`pnpm build`, `pnpm test`) which are fine. `publint` runs as `pnpm dlx publint` from a package directory.
- **Never edit generated `lib/`.**

---

### Task 1: LICENSE files

**Files:**
- Create: `LICENSE` (repo root)
- Create: `packages/env/LICENSE`, `packages/log/LICENSE`, `packages/process/LICENSE`, `packages/server/LICENSE`, `packages/cli/LICENSE`, `packages/ui/LICENSE`, `packages/test/LICENSE` (identical copies)
- Modify: each `packages/*/package.json` — append `"LICENSE"` to the `files` array

**Interfaces:**
- Consumes: nothing.
- Produces: a `LICENSE` in every package directory, listed in `files`, so every tarball carries it independent of publisher.

- [ ] **Step 1: Write the root LICENSE**

Create `LICENSE` (repo root) with the standard MIT text:

```
MIT License

Copyright (c) 2026 Paul Le Cam

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Copy it into each package**

```bash
cd /Users/paul/dev/yulsi/tejika
for p in env log process server cli ui test; do cp LICENSE "packages/$p/LICENSE"; done
```

- [ ] **Step 3: Add `"LICENSE"` to each package's `files` array**

In every `packages/*/package.json`, change `"files": ["lib/*"]` to:

```json
"files": [
  "lib/*",
  "LICENSE"
]
```

- [ ] **Step 4: Verify each package would pack the LICENSE**

Run (env shown; repeat for one or two others as a spot-check):

```bash
cd /Users/paul/dev/yulsi/tejika/packages/env && pnpm pack --dry-run 2>&1 | grep -i license
```

Expected: a line listing `LICENSE` in the pack contents. (`pnpm pack --dry-run` prints the file list without writing a tarball.)

- [ ] **Step 5: Commit**

```bash
cd /Users/paul/dev/yulsi/tejika
git add LICENSE packages/*/LICENSE packages/*/package.json
git commit -m "Add LICENSE to repo root and every published package"
```

---

### Task 2: `engines.node` floor

**Files:**
- Modify: each `packages/*/package.json` — add an `engines` field

**Interfaces:**
- Consumes: nothing.
- Produces: `"engines": { "node": ">=24" }` in all seven manifests.

- [ ] **Step 1: Add the `engines` field to each package**

In every `packages/*/package.json`, add (placed after `"license"` / before `"sideEffects"`, or anywhere valid — match sibling formatting):

```json
"engines": {
  "node": ">=24"
},
```

- [ ] **Step 2: Verify all seven have it**

```bash
cd /Users/paul/dev/yulsi/tejika
grep -l '">=24"' packages/*/package.json | wc -l
```

Expected: `7`.

- [ ] **Step 3: Commit**

```bash
git add packages/*/package.json
git commit -m "Declare engines.node >=24 on every published package"
```

---

### Task 3: Conditional exports map

**Files:**
- Modify: each `packages/*/package.json` — change the `exports` field

**Interfaces:**
- Consumes: nothing.
- Produces: a `types`+`default` conditional exports map on all seven; top-level `main`/`types` retained as legacy fallback.

- [ ] **Step 1: Rewrite the `exports` field in each package**

In every `packages/*/package.json`, change:

```json
"exports": {
  ".": "./lib/index.js"
},
```

to:

```json
"exports": {
  ".": {
    "types": "./lib/index.d.ts",
    "default": "./lib/index.js"
  }
},
```

Leave the top-level `"main": "lib/index.js"` and `"types": "lib/index.d.ts"` fields unchanged.

- [ ] **Step 2: Build (publint needs the emitted `lib/`)**

```bash
cd /Users/paul/dev/yulsi/tejika && pnpm build
```

Expected: build completes, all seven packages emit `lib/index.js` + `lib/index.d.ts`.

- [ ] **Step 3: Run publint on each package**

```bash
cd /Users/paul/dev/yulsi/tejika
for p in env log process server cli ui test; do echo "== $p =="; (cd packages/$p && pnpm dlx publint); done
```

Expected: each reports `All good!` (or no errors) for the exports map. Note: publint may warn about other pre-existing items; the exports condition must be clean.

- [ ] **Step 4: Confirm cross-package type resolution still works**

```bash
cd /Users/paul/dev/yulsi/tejika && pnpm test
```

Expected: green. (`@tejika/log`, `process`, `server`, `test` import `@tejika/env` under NodeNext; the `types` condition must resolve for `test:types` to pass.)

- [ ] **Step 5: Commit**

```bash
git add packages/*/package.json
git commit -m "Use types/default conditional exports on every package"
```

---

### Task 4: No-map pack/publish build via `prepack`

**Files:**
- Modify: each `packages/*/package.json` — replace `prepublishOnly` with `prepack`
- Modify: `package.json` (root) — point `release` build at `build:ci`

**Interfaces:**
- Consumes: the existing `build:clean`, `build:js`, `build:types:ci` scripts in each package.
- Produces: a clean, declaration-map-free tarball from both `pnpm pack` and `pnpm publish -r`.

- [ ] **Step 1: Replace `prepublishOnly` with `prepack` in each package**

In every `packages/*/package.json`, replace the line:

```json
"prepublishOnly": "pnpm run build",
```

with:

```json
"prepack": "pnpm run build:clean && pnpm run build:js && pnpm run build:types:ci",
```

Rationale (from the spec): `pnpm pack` does not run `prepublishOnly` (only `prepack`/`prepare`/`postpack`); `pnpm publish` runs `prepack` too; and `build:clean` (`del lib`) is what removes any stale `.d.ts.map` — `--declarationMap false` only stops new ones being emitted.

- [ ] **Step 2: Update the root `release` script**

In root `package.json`, change:

```json
"release": "pnpm run build && pnpm publish -r",
```

to:

```json
"release": "pnpm run build:ci && pnpm publish -r",
```

- [ ] **Step 3: Verify a packed tarball has no `.d.ts.map` and includes `LICENSE`**

```bash
cd /Users/paul/dev/yulsi/tejika/packages/env
pnpm pack 2>/dev/null
tar tzf tejika-env-*.tgz | grep -E 'LICENSE|\.d\.ts(\.map)?$'
```

Expected: lists `package/LICENSE` and `package/lib/index.d.ts`, and NO `.d.ts.map` line. (`prepack` fires on `pnpm pack`, producing the no-map build.)

- [ ] **Step 4: Clean up the throwaway tarball**

```bash
rm -f /Users/paul/dev/yulsi/tejika/packages/env/tejika-env-*.tgz
```

- [ ] **Step 5: Confirm a normal dev build still emits maps (unchanged dev flow)**

```bash
cd /Users/paul/dev/yulsi/tejika && pnpm build
ls packages/env/lib/index.d.ts.map
```

Expected: the map file exists — the plain `pnpm build` (dev) path is untouched; only pack/publish drop maps.

- [ ] **Step 6: Commit**

```bash
git add packages/*/package.json package.json
git commit -m "Emit clean no-map tarballs via prepack; root release uses build:ci"
```

---

### Task 5: `react`/`ink` as peer dependencies (`cli`, `ui`)

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `packages/ui/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `cli` and `ui` declare `react`/`ink` as `peerDependencies` (widened ranges) + keep them as `devDependencies` (`catalog:`); a consumer app resolves a single React instance.

- [ ] **Step 1: Edit `packages/cli/package.json`**

Remove `"react": "catalog:"` and `"ink": "catalog:"` from `dependencies` (leave `@tejika/env` and `commander`). Add a `peerDependencies` block and add react/ink to `devDependencies`:

```json
"dependencies": {
  "@tejika/env": "workspace:^",
  "commander": "catalog:"
},
"peerDependencies": {
  "ink": "^7.0.0",
  "react": "^19.0.0"
},
"devDependencies": {
  "@tejika/test": "workspace:^",
  "@types/node": "catalog:",
  "@types/react": "catalog:",
  "ink": "catalog:",
  "react": "catalog:",
  "strip-ansi": "catalog:"
},
```

- [ ] **Step 2: Edit `packages/ui/package.json`**

Remove `"react": "catalog:"` and `"ink": "catalog:"` from `dependencies` (leave `@inkjs/ui`). Add `peerDependencies` and add react/ink to `devDependencies`:

```json
"dependencies": {
  "@inkjs/ui": "catalog:"
},
"peerDependencies": {
  "ink": "^7.0.0",
  "react": "^19.0.0"
},
"devDependencies": {
  "@types/react": "catalog:",
  "ink": "catalog:",
  "ink-testing-library": "catalog:",
  "react": "catalog:"
},
```

- [ ] **Step 3: Reinstall to update the lockfile and dev links**

```bash
cd /Users/paul/dev/yulsi/tejika && pnpm install
```

Expected: install succeeds; `pnpm-lock.yaml` updates react/ink from prod to dev+peer for cli/ui. No peer-dependency-missing warning for cli/ui (the devDependency satisfies the peer in-workspace).

- [ ] **Step 4: Build and test**

```bash
pnpm build && pnpm test
```

Expected: green. cli/ui still compile and their vitest suites pass — the devDependency provides react/ink for the local build.

- [ ] **Step 5: Verify the published shape**

```bash
cd /Users/paul/dev/yulsi/tejika
node -e "for (const p of ['cli','ui']) { const j=require('./packages/'+p+'/package.json'); console.log(p, 'peer:', j.peerDependencies, 'dep.react:', j.dependencies.react, 'dep.ink:', j.dependencies.ink); }"
```

Expected: for both, `peer: { ink: '^7.0.0', react: '^19.0.0' }`, and `dep.react`/`dep.ink` are `undefined`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json packages/ui/package.json pnpm-lock.yaml
git commit -m "Move react/ink to peerDependencies for @tejika/cli and @tejika/ui"
```

---

### Task 6: Record release intents

**Files:**
- Create: `.changeset/publishing-readiness.md`

**Interfaces:**
- Consumes: the completed manifest changes from Tasks 1–5.
- Produces: a pnpm-readable minor-bump intent for all seven packages, so the next `pnpm version -r` captures this work.

- [ ] **Step 1: Write the intent file**

pnpm reads changeset-format `.changeset/*.md` files (the repo already keeps `.changeset/ledger.yaml`). Create `.changeset/publishing-readiness.md`:

```markdown
---
"@tejika/env": minor
"@tejika/log": minor
"@tejika/process": minor
"@tejika/server": minor
"@tejika/cli": minor
"@tejika/ui": minor
"@tejika/test": minor
---

Publishing readiness. Every package now ships a LICENSE, declares
`engines.node >=24`, and exposes a `types`/`default` conditional exports map;
tarballs no longer ship dangling declaration maps. `@tejika/cli` and
`@tejika/ui` now declare `react` and `ink` as peer dependencies (`react ^19`,
`ink ^7`) instead of regular dependencies, so a consumer app resolves a single
React instance.

The `engines.node >=24` floor is why every package takes a minor bump: it
raises the supported-runtime floor for pre-1.0 packages.
```

- [ ] **Step 2: Verify pnpm reads the intent and plans all seven**

```bash
cd /Users/paul/dev/yulsi/tejika && pnpm change status
```

Expected: a release plan listing all seven `@tejika/*` packages with a `minor` bump. (If `pnpm change status` errors, the intent file's front-matter package names or YAML are malformed — fix and re-run.)

- [ ] **Step 3: Commit**

```bash
git add .changeset/publishing-readiness.md
git commit -m "Record minor-bump release intents for publishing readiness"
```

---

## Final verification (after all tasks)

- [ ] `pnpm build && pnpm test` green from a clean state.
- [ ] `pnpm exec biome check ./packages` reports no new issues (manifests are JSON; biome may format-check them).
- [ ] `pnpm change status` shows seven minor bumps.
- [ ] A spot-check `pnpm pack` on `packages/cli` shows `LICENSE`, `lib/index.d.ts`, no `.d.ts.map`, and the packed `package.json` has `react`/`ink` under `peerDependencies` only.
