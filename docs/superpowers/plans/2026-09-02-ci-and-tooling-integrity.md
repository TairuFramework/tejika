# CI and Tooling Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks

**Goal:** Close the genuinely-open build/test/lint tooling gaps so CI and the
local-commit gate are trustworthy, and fix documentation that no longer matches
the code.

**Architecture:** Independent config/doc edits across `turbo.json`,
`.githooks/pre-commit`, root `package.json`, `.gitignore`, and `docs/`, plus one
decoupled edit to the shared `@kigu/dev` tsconfig preset in the separate kigu
repo. No package source changes; no runtime behaviour changes.

**Tech Stack:** pnpm workspace, Turbo 2.10.8, Biome 2.5.x (`@kigu/dev` preset),
SWC, Vitest, TypeScript (NodeNext).

**Spec:** `docs/superpowers/specs/2026-09-02-ci-and-tooling-integrity-design.md`

## Global Constraints

- Use `pnpm`/`pnpx`, never `npm`/`npx`. Do not edit generated `lib/`.
- **Verify lint with native Biome** (`pnpm exec biome ci .` / `pnpm biome
  check`), **never** the `rtk` wrapper — `rtk lint biome` has reported real
  violations as clean.
- Run scripts via top-level binaries or `pnpm exec <tool>`; if invoking a repo
  script, be aware the `rtk` shim may hijack `pnpm run <script>` in this session
  (use `pnpm exec` directly where possible).
- Seven publishable packages: `env`, `log`, `process`, `server`, `cli`, `ui`,
  `test`.
- TypeScript style guardrails (already enforced by the preset): `type` not
  `interface`, `Array<T>` not `T[]`, no `any`, ES private fields.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QV56127oh5rTjhqJ9ZUB1w
  ```
- Biome's `useSortedPackageJson`/`organizeImports` assist runs in the pre-commit
  hook; write JSON keys in sorted order so the hook does not reformat after a
  commit.

## File Structure

- `turbo.json` — task graph: drop dead `clean`, narrow `build:js` inputs, add
  cacheable `build:types` and a `test:types` gate (Task 1).
- `.githooks/pre-commit` — non-mutating, fail-loud lint + non-emitting
  type-check (Task 2).
- `package.json` (root), `.gitignore` — `lint:ci` script + ignore gaps (Task 3).
- `docs/agents/architecture.md`, `docs/agents/development.md`,
  `packages/test/README.md` — doc drift + node-pty note + phantom-dep contract
  (Task 4).
- `/Users/paul/dev/yulsi/kigu/packages/dev/tsconfig.json` — shared preset
  hardening, committed in the kigu repo, unpublished (Task 5).

---

### Task 1: turbo.json task graph

**Files:**
- Modify: `turbo.json`

**Interfaces:**
- Consumes: package scripts `build:js` (swc → `lib/**/*.js`), `build:types`
  (`tsc --emitDeclarationOnly` → `lib/**/*.d.ts` + `.d.ts.map`), `test:types`
  (`tsc --noEmit -p tsconfig.test.json`), `test`.
- Produces: a `test:types` turbo task other tooling/CI can call as the
  repo-wide type gate.

**Context:** SWC emits only `.js` (no source maps — `swc.json` sets none); `tsc`
emits `.d.ts` + `.d.ts.map`. Package `tsconfig.test.json` extends the package
tsconfig (NodeNext), so `test:types` resolves `@tejika/*` cross-imports via the
imported package's built `lib/*.d.ts` — hence `test:types` and `build:types`
depend on upstream `^build:types`. The current `clean` task is defined-but-empty
and no package has a `clean` script, so `^clean` is a no-op. Disjoint task
outputs (`*.js` vs `*.d.ts`) avoid cache-restore overlap.

- [ ] **Step 1: Replace `turbo.json` with the new graph**

```json
{
  "$schema": "./node_modules/turbo/schema.json",
  "tasks": {
    "build:js": {
      "inputs": ["src/**", "package.json", "tsconfig*.json", "$TURBO_ROOT$/tsconfig.build.json"],
      "outputs": ["lib/**/*.js"]
    },
    "build:types": {
      "dependsOn": ["^build:types"],
      "inputs": ["src/**", "package.json", "tsconfig*.json", "$TURBO_ROOT$/tsconfig.build.json"],
      "outputs": ["lib/**/*.d.ts", "lib/**/*.d.ts.map"]
    },
    "test:types": {
      "dependsOn": ["^build:types"],
      "cache": false
    },
    "test": {
      "dependsOn": ["^build:js"],
      "cache": false
    }
  }
}
```

- [ ] **Step 2: Verify the input set with a dry run**

Run: `pnpm exec turbo run build:js --dry=json`
Expected: valid JSON; each package task's `inputs` reflect the narrowed globs
(no `README.md` etc. in the hashed input list); no `clean` task appears in the
graph.

- [ ] **Step 3: Verify the type gate is self-sufficient**

Run: `pnpm exec turbo run test:types` (on a tree where `lib/` may be stale or
absent).
Expected: PASS — upstream `build:types` runs first, all seven packages
type-check.

- [ ] **Step 4: Verify build + full test still green**

Run: `pnpm build && pnpm test`
Expected: PASS (10 turbo tasks, all package tests).

- [ ] **Step 5: Lint clean (native Biome)**

Run: `pnpm exec biome ci turbo.json`
Expected: no diagnostics.

- [ ] **Step 6: Commit**

```bash
git add turbo.json
git commit -m "$(cat <<'EOF'
build: fix turbo task graph (drop dead clean, narrow inputs, add type gate)

Removes the no-op `^clean` dependency and empty `clean` task; narrows
`build:js` inputs to sources and TS config; adds a cacheable `build:types`
task and a repo-wide `test:types` gate resolving upstream declarations.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QV56127oh5rTjhqJ9ZUB1w
EOF
)"
```

---

### Task 2: Pre-commit hook — non-mutating, fail-loud

**Files:**
- Modify: `.githooks/pre-commit`

**Interfaces:**
- Consumes: `pnpm biome check --staged`, per-package `test:types` script.
- Produces: a hook that never edits the working tree or index.

**Context:** The current hook (a) auto-fixes staged files with `--write` but
never re-stages them, so the commit ships pre-fix content; and (b) runs
`build:types`, mutating `lib/`. A `git add -u` re-stage is rejected because it
would sweep unstaged hunks of a partially-staged file into the commit. The fix
is a non-mutating check that fails loudly (mirroring CI's `biome ci`) plus a
non-emitting type-check.

- [ ] **Step 1: Replace `.githooks/pre-commit` with the fail-loud version**

```sh
#!/bin/sh

echo "Running pre-commit checks..."

echo "Linting staged files..."
pnpm biome check --staged --no-errors-on-unmatched
if [ $? -ne 0 ]; then
  echo "Lint failed — run \`pnpm lint\` to fix, then re-stage the files."
  exit 1
fi

echo "Type checking..."
pnpm -r run test:types
if [ $? -ne 0 ]; then
  echo "Type check failed. Fix errors before committing."
  exit 1
fi

echo "Pre-commit checks passed."
```

- [ ] **Step 2: Keep it executable**

Run: `chmod +x .githooks/pre-commit && test -x .githooks/pre-commit && echo OK`
Expected: `OK`.

- [ ] **Step 3: Verify a lint violation fails the hook without mutating**

```sh
# Create a deliberately mis-formatted staged file (double-spaced, no semicolons style break)
printf 'export const x = {a:1,b:2}\n\n\n' > /tmp/hooktest.ts
cp /tmp/hooktest.ts packages/env/src/__hooktest__.ts
git add packages/env/src/__hooktest__.ts
sh .githooks/pre-commit; echo "exit=$?"
# Expected: prints "Lint failed — run `pnpm lint` ..." and exit=1
git diff --cached --name-only   # file still staged, unchanged (hook did not --write)
git diff packages/env/src/__hooktest__.ts   # no working-tree modification by the hook
git rm -f --cached packages/env/src/__hooktest__.ts && rm -f packages/env/src/__hooktest__.ts
```
Expected: hook exits 1; the temp file is unchanged on disk (no autofix applied).

- [ ] **Step 4: Verify a clean staged tree passes**

Run: `sh .githooks/pre-commit; echo "exit=$?"` with nothing problematic staged.
Expected: "Pre-commit checks passed." and `exit=0`; no files under `lib/` change
(type-check is `--noEmit`). Confirm with `git status --porcelain lib` → empty.

- [ ] **Step 5: Commit**

```bash
git add .githooks/pre-commit
git commit -m "$(cat <<'EOF'
chore: make pre-commit hook non-mutating and fail-loud

Replace the `biome check --write` (which left fixes unstaged) with a
non-mutating `biome check --staged` that fails and points at `pnpm lint`,
and swap the emitting `build:types` type-check for non-emitting `test:types`
so the hook never touches lib/ or the index.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QV56127oh5rTjhqJ9ZUB1w
EOF
)"
```

Note: this commit itself exercises the new hook (which now runs `test:types`,
not `build:types`) — a clean pass confirms the change end to end.

---

### Task 3: `lint:ci` script + `.gitignore` gaps

**Files:**
- Modify: `package.json` (root)
- Modify: `.gitignore`

**Interfaces:**
- Produces: `pnpm lint:ci` — a non-mutating local mirror of the CI lint gate.

**Context:** The root `lint` script mutates (`biome check --write`); there is no
non-mutating local equivalent. CI runs `pnpm exec biome ci .` inline (unchanged).
`.gitignore` is missing common ignores; `.env*` would wrongly ignore
`.env.example`, so use explicit patterns with a negation.

- [ ] **Step 1: Add the `lint:ci` script (sorted position, after `lint`)**

In root `package.json` `scripts`, add:
```json
"lint:ci": "biome ci .",
```
Place it immediately after `"lint": "biome check --write ./packages",` so the
keys stay in Biome's sorted order (`lint` → `lint:ci` → `prepare`).

- [ ] **Step 2: Verify the script runs native Biome CI**

Run: `pnpm lint:ci`
Expected: Biome CI runs over the repo and exits 0 (clean). (This is
non-mutating; it must not modify any file.)

- [ ] **Step 3: Extend `.gitignore`**

Append these entries (keep existing lines):
```gitignore
*.log
.DS_Store
*.tsbuildinfo
.env
.env.*
!.env.example
.superpowers/
```

- [ ] **Step 4: Verify ignore behaviour**

```sh
git check-ignore -v foo.log .DS_Store x.tsbuildinfo .env .env.local .superpowers/x
git check-ignore .env.example; echo "example-ignored-exit=$?"
```
Expected: the first command reports each path as ignored; `.env.example` is NOT
ignored (`example-ignored-exit=1`).

- [ ] **Step 5: Lint clean + commit**

```bash
pnpm exec biome ci package.json
git add package.json .gitignore
git commit -m "$(cat <<'EOF'
chore: add lint:ci script and fill .gitignore gaps

Add a non-mutating `lint:ci` (`biome ci .`) mirroring the CI lint gate for
local use. Ignore *.log, .DS_Store, *.tsbuildinfo, env files (keeping
.env.example tracked), and .superpowers/.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QV56127oh5rTjhqJ9ZUB1w
EOF
)"
```

---

### Task 4: Documentation — dep-graph, drift, node-pty, phantom-dep contract

**Files:**
- Modify: `docs/agents/architecture.md`
- Modify: `docs/agents/development.md`
- Modify: `packages/test/README.md`

**Context:** The architecture dep-graph misplaces `get-port` and omits
`@enkaku/protocol` on the server line; development.md references a nonexistent
`tests/integration/` and a stale `@enkaku` `0.18` (catalog is `0.21`); the
node-pty troubleshooting note belongs in the already-existing test README (repo
CI already `chmod +x`es the helper — the gap is consumer-facing); the
hoisted-linker tool contract should be documented.

- [ ] **Step 1: Fix the architecture.md dependency graph**

In the fenced dependency-graph block (the lines starting `@tejika/...`):
- Change the `@tejika/env` line from
  `@tejika/env       no @tejika deps (foundational)`
  to
  `@tejika/env       no @tejika deps; env-paths + get-port (foundational)`
- Change the `@tejika/server` line from
  `@tejika/server    env + @enkaku/http-serve + hono + @hono/node-server + get-port`
  to
  `@tejika/server    env + @enkaku/{http-serve,protocol} + hono + @hono/node-server`

- [ ] **Step 2: Fix development.md drift and add the phantom-dep note**

Replace the `## Repo-specific` body:
```markdown
## Repo-specific

Local-side foundation (env, log, process, server, cli, ui, test). Consumes
`@enkaku` 0.21 (client, protocol, server, socket, http-serve).

### Tooling binary contract

Build/test tool binaries — `swc`, `tsc`, `vitest`, `tsx`, `del` — are provided
transitively by `@kigu/dev` and resolve under the repo's pinned
`nodeLinker: hoisted` (see `pnpm-workspace.yaml`). Packages deliberately do not
redeclare them. `@kigu/dev` owns this binary surface: removing a binary from it
is a breaking change for consumers. The reliance is verified transitively — a
missing binary fails `pnpm build` / `pnpm test`, which invoke every one of them.
```
(The `tests/integration/` sentence is dropped — no such directory exists and the
shared workflow's `integration-tests-dir` input is never passed.)

- [ ] **Step 3: Add a Troubleshooting section to `packages/test/README.md`**

Append at the end of the file:
```markdown

## Troubleshooting

### `posix_spawnp failed` when spawning a PTY

`node-pty` ships a prebuilt `spawn-helper` binary that must be executable. Some
installs (notably pnpm's content-addressed store hardlinks) can land it without
the executable bit, so `PTYDriver` fails with `posix_spawnp failed`. Restore it:

```sh
find node_modules -type f -name spawn-helper -exec chmod +x {} +
```

CI runners that install fresh may need the same step before running PTY-backed
tests. (This repo's own `test-platforms.yml` workflow already does this.)
```

- [ ] **Step 4: Verify the referenced facts**

```sh
grep -n "get-port\|@enkaku/{http-serve,protocol}" docs/agents/architecture.md
grep -rn "tests/integration" docs/agents/ ; echo "integration-refs-exit=$?"
grep -n "0.21" docs/agents/development.md
```
Expected: architecture.md server line no longer contains `get-port` and lists
`@enkaku/{http-serve,protocol}`; no `tests/integration` reference remains
(`integration-refs-exit=1`); development.md says `0.21`.

- [ ] **Step 5: Lint clean + commit**

```bash
pnpm exec biome ci docs/agents/architecture.md docs/agents/development.md packages/test/README.md
git add docs/agents/architecture.md docs/agents/development.md packages/test/README.md
git commit -m "$(cat <<'EOF'
docs: fix dep-graph/version drift, node-pty note, tooling contract

Correct the architecture dep graph (get-port is in env, server has
@enkaku/protocol not get-port); drop the nonexistent tests/integration
reference and bump @enkaku 0.18 -> 0.21 in development.md; document the
@kigu/dev hoisted tool-binary contract; add a node-pty spawn-helper
troubleshooting note to the @tejika/test README.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QV56127oh5rTjhqJ9ZUB1w
EOF
)"
```

---

### Task 5: Harden the `@kigu/dev` tsconfig preset (kigu repo, unpublished)

**Files:**
- Modify: `/Users/paul/dev/yulsi/kigu/packages/dev/tsconfig.json`

**Context:** This is a **separate git repo** (`/Users/paul/dev/yulsi/kigu`). The
edit is committed there, **not** on the tejika branch, and **not published** —
tejika keeps consuming the lockfile-pinned `@kigu/dev@0.2.1`, so this branch is
unaffected. SWC transpiles per file, so `verbatimModuleSyntax` is needed to force
`import type` on type-only imports (the primary runtime-safety motivation);
`noUncheckedIndexedAccess` is a separate, user-requested strictness change with a
broader per-repo blast radius. `@kigu/dev` is a config/asset package with no
compile step, so there is no in-repo type-check to run — validation happens per
consumer at adoption time.

- [ ] **Step 1: Add both options to the preset**

In `/Users/paul/dev/yulsi/kigu/packages/dev/tsconfig.json`, add to
`compilerOptions` (after `noUncheckedSideEffectImports`):
```json
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true
```
Resulting `compilerOptions` (order per Biome's package.json sort does not apply
to tsconfig; keep logical grouping):
```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "strict": true,
    "target": "es2025",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2025"],
    "types": [],
    "declaration": true,
    "jsx": "react-jsx",
    "noUncheckedSideEffectImports": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 2: Verify valid JSON and lint clean in the kigu repo**

```sh
cd /Users/paul/dev/yulsi/kigu
node -e "JSON.parse(require('fs').readFileSync('packages/dev/tsconfig.json','utf8')); console.log('valid JSON')"
pnpm exec biome ci packages/dev/tsconfig.json
```
Expected: `valid JSON`; no Biome diagnostics.

- [ ] **Step 3: Commit in the kigu repo (do NOT publish)**

```bash
cd /Users/paul/dev/yulsi/kigu
git add packages/dev/tsconfig.json
git commit -m "$(cat <<'EOF'
feat(dev): enable verbatimModuleSyntax and noUncheckedIndexedAccess in tsconfig preset

verbatimModuleSyntax closes an SWC per-file transpile gap where an
un-annotated type-only import can emit a runtime import tsc would not flag.
noUncheckedIndexedAccess adds indexed-access undefined-safety. Unpublished;
consumers adopt on their next @kigu/dev update and fix any new errors then.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QV56127oh5rTjhqJ9ZUB1w
EOF
)"
```

- [ ] **Step 4: Confirm no tejika change**

Run: `cd /Users/paul/dev/yulsi/tejika && git status --porcelain`
Expected: empty — Task 5 leaves the tejika worktree untouched. Confirm the
kigu commit is **not** pushed/published.

---

## Self-Review

- **Spec coverage:** Task 1 → turbo (spec item 2); Task 2 → pre-commit (item 1);
  Task 3 → lint:ci + .gitignore (items 3, 4); Task 4 → docs drift + node-pty +
  phantom-dep (items 5, 6, 7); Task 5 → tsconfig cross-repo. Verify-only items
  (CI lint, biome guardrails, build-order) need no task. All covered.
- **No placeholders:** every step has concrete content and a runnable verify.
- **Consistency:** turbo task/output names match package scripts; disjoint
  outputs (`*.js` vs `*.d.ts`) verified against swc/tsc emission; `test:types`/
  `build:types` deps match the NodeNext cross-package resolution finding.
