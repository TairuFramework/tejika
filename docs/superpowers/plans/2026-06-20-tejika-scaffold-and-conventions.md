# Tejika Scaffold & Conventions Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `tejika` monorepo with the Yulsi stack's exact tooling and agent conventions, plus one real proving package (`@tejika/env` first util) that validates the full build/types/test/lint pipeline.

**Architecture:** A pnpm workspace mirroring Mokei/Kubun: `catalog:` dependency pinning, swc for JS build, tsc for type declarations, turbo to orchestrate, biome for lint/format, vitest for tests. Agent conventions are propagated (manually) from the sibling `agents/` canonical repo into `docs/agents/`.

**Tech Stack:** pnpm 11.8.0, TypeScript 6, swc, turbo, biome, vitest, env-paths, get-port.

## Global Constraints

- Package manager: **pnpm only** (`pnpm`/`pnpx`), never `npm`/`npx`. `packageManager: pnpm@11.8.0`.
- TypeScript: `type` not `interface`; `Array<T>` not `T[]`; never `any` (use `unknown`/`Record<string, unknown>`/specific).
- Classes: ES private fields (`#field`), never TS `private`/`readonly`; single `ClassNameParams` constructor object.
- Names: capitalized abbreviations (`ID`, `HTTP`, `JWT`), not `Id`/`Http`/`Jwt`.
- Every package: `type: module`, `main: lib/index.js`, `types: lib/index.d.ts`, `exports`, `files: ["lib/*"]`, `sideEffects: false`.
- All shared dep versions live in the workspace `catalog:`; packages reference `catalog:` / `workspace:^`, never raw version ranges.
- Enkaku version floor: `@enkaku/* ^0.17`. Catalog `minimumReleaseAgeExclude: ['@enkaku/*']`.
- Repo path assumption: `tejika`, `enkaku`, `mokei`, `kubun`, `sakui`, `agents` are sibling folders under one parent. No absolute paths in committed files.

---

### Task 1: Root workspace + tooling

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.build.json`
- Create: `tsconfig.json`
- Create: `swc.json`
- Create: `turbo.json`
- Create: `biome.json`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a workspace where `pnpm install`, `pnpm lint`, `pnpm build`, `pnpm test` resolve. Catalog keys later tasks reference: `typescript`, `@swc/cli`, `@swc/core`, `@types/node`, `@biomejs/biome`, `turbo`, `vitest`, `del-cli`, `tsx`, `env-paths`, `get-port`.

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - packages/*

catalog:
  '@biomejs/biome': ^2.5.0
  '@enkaku/client': ^0.17.0
  '@enkaku/http-server-transport': ^0.17.0
  '@enkaku/server': ^0.17.0
  '@enkaku/socket-transport': ^0.17.0
  '@hono/node-server': ^2.0.5
  '@inkjs/ui': ^2.0.0
  '@swc/cli': ^0.8.1
  '@swc/core': ^1.15.41
  '@types/node': ^25.9.3
  '@types/react': ^19.2.17
  '@vitest/ui': ^4.1.9
  commander: ^15.0.0
  del-cli: ^7.0.0
  env-paths: ^3.0.0
  get-port: ^7.2.0
  hono: ^4.12.26
  ink: ^7.1.0
  ink-testing-library: ^4.0.0
  nano-spawn: ^2.1.0
  react: ^19.2.7
  strip-ansi: ^7.2.0
  tsx: ^4.22.4
  turbo: ^2.9.18
  typescript: ^6.0.3
  vitest: ^4.1.9

catalogMode: manual

minimumReleaseAgeExclude:
  - '@enkaku/*'

supportedArchitectures:
  cpu: [ current ]
  os: [ current ]

allowBuilds:
  '@biomejs/biome': true
  '@swc/core': true
  esbuild: true
  node-pty: true
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "tejika-repo",
  "version": "0.0.0",
  "author": "Paul Le Cam",
  "type": "module",
  "private": true,
  "packageManager": "pnpm@11.8.0",
  "scripts": {
    "lint": "biome check --write ./packages",
    "test": "pnpm run --filter './packages/**' test",
    "build:js": "turbo run build:js",
    "build:types": "pnpm run -r build:types",
    "build:types:ci": "pnpm run -r build:types:ci",
    "build": "pnpm run build:types && pnpm run build:js",
    "build:ci": "pnpm run build:types:ci && pnpm run build:js"
  },
  "devDependencies": {
    "@biomejs/biome": "catalog:",
    "@swc/cli": "catalog:",
    "@swc/core": "catalog:",
    "@types/node": "catalog:",
    "@vitest/ui": "catalog:",
    "del-cli": "catalog:",
    "tsx": "catalog:",
    "turbo": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 3: Create `tsconfig.build.json`, `tsconfig.json`, `swc.json`, `turbo.json`, `biome.json`, `.gitignore`**

`tsconfig.build.json`:
```json
{
  "compilerOptions": {
    "allowSyntheticDefaultImports": true,
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "lib": ["es2025"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "target": "es2025"
  }
}
```

`tsconfig.json`:
```json
{
  "extends": "./tsconfig.build.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@tejika/*": ["packages/*"]
    },
    "noEmit": true
  }
}
```

`swc.json`:
```json
{
  "jsc": {
    "parser": { "syntax": "typescript", "tsx": true },
    "target": "es2022",
    "transform": {
      "react": { "runtime": "automatic" },
      "optimizer": { "globals": { "vars": { "process.env.NODE_ENV": "production" } } }
    }
  }
}
```

`turbo.json`:
```json
{
  "$schema": "./node_modules/turbo/schema.json",
  "tasks": {
    "clean": {},
    "build:js": {
      "dependsOn": ["^clean"],
      "outputs": ["lib/**"]
    }
  }
}
```

`biome.json`:
```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "files": { "includes": ["**", "!**/lib"] },
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "formatter": {
    "enabled": true,
    "formatWithErrors": false,
    "includes": ["**"],
    "attributePosition": "auto",
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "arrowParentheses": "always",
      "bracketSameLine": true,
      "bracketSpacing": true,
      "jsxQuoteStyle": "double",
      "quoteProperties": "asNeeded",
      "quoteStyle": "single",
      "semicolons": "asNeeded",
      "trailingCommas": "all"
    }
  },
  "linter": {
    "enabled": true,
    "includes": ["**"],
    "rules": {
      "recommended": true,
      "style": {
        "noParameterAssign": "error",
        "useAsConstAssertion": "error",
        "useDefaultParameterLast": "error",
        "useEnumInitializers": "error",
        "useSelfClosingElements": "error",
        "useSingleVarDeclarator": "error",
        "noUnusedTemplateLiteral": "error",
        "useNumberNamespace": "error",
        "noInferrableTypes": "error",
        "noUselessElse": "error"
      }
    }
  },
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true }
}
```

`.gitignore`:
```
coverage
lib
node_modules

**/.claude/settings.local.json
.swc
.turbo
.vscode
```

- [ ] **Step 4: Install and verify tooling resolves**

Run: `pnpm install`
Expected: completes, writes `pnpm-lock.yaml`, no catalog resolution errors.

Run: `pnpm lint`
Expected: biome runs, reports no files to fix / exits 0 (no `packages/` source yet).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.build.json tsconfig.json swc.json turbo.json biome.json .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold tejika workspace and tooling"
```

---

### Task 2: `@tejika/env` package + first util (`appEnvVar`)

This proves the swc build + tsc declarations + vitest pipeline end to end with one real, tested utility. The rest of `@tejika/env` is built in the extraction plan.

**Files:**
- Create: `packages/env/package.json`
- Create: `packages/env/tsconfig.json`
- Create: `packages/env/src/index.ts`
- Create: `packages/env/src/env-var.ts`
- Test: `packages/env/test/env-var.test.ts`

**Interfaces:**
- Consumes: workspace catalog from Task 1.
- Produces: `appEnvVar(app: string, key: string): string` — the helper every `@tejika/env` resolver uses to compute the override env-var name. Extraction-plan tasks consume this.

- [ ] **Step 1: Create `packages/env/package.json`**

```json
{
  "name": "@tejika/env",
  "version": "0.0.0",
  "license": "MIT",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": { ".": "./lib/index.js" },
  "files": ["lib/*"],
  "sideEffects": false,
  "scripts": {
    "build:clean": "del lib",
    "build:js": "swc src -d ./lib --config-file ../../swc.json --strip-leading-paths",
    "build:types": "tsc --emitDeclarationOnly --skipLibCheck",
    "build:types:ci": "tsc --emitDeclarationOnly --skipLibCheck --declarationMap false",
    "build": "pnpm run build:clean && pnpm run build:js && pnpm run build:types",
    "test:types": "tsc --noEmit --skipLibCheck",
    "test:unit": "vitest run",
    "test": "pnpm run test:types && pnpm run test:unit"
  },
  "dependencies": {
    "env-paths": "catalog:",
    "get-port": "catalog:"
  },
  "devDependencies": {
    "@types/node": "catalog:"
  }
}
```

- [ ] **Step 2: Create `packages/env/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.build.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./lib",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["./src/**/*"]
}
```

- [ ] **Step 3: Write the failing test**

`packages/env/test/env-var.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { appEnvVar } from '../src/env-var.js'

describe('appEnvVar', () => {
  test('uppercases the app slug and joins the key', () => {
    expect(appEnvVar('mokei', 'PORT')).toBe('MOKEI_PORT')
  })

  test('normalizes non-alphanumeric characters in the app slug to underscores', () => {
    expect(appEnvVar('my-app', 'SOCKET_PATH')).toBe('MY_APP_SOCKET_PATH')
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @tejika/env exec vitest run`
Expected: FAIL — cannot resolve `../src/env-var.js` (module not found).

- [ ] **Step 5: Write the minimal implementation**

`packages/env/src/env-var.ts`:
```ts
export function appEnvVar(app: string, key: string): string {
  const slug = app.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return `${slug}_${key}`
}
```

`packages/env/src/index.ts`:
```ts
export { appEnvVar } from './env-var.js'
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @tejika/env exec vitest run`
Expected: PASS (2 tests).

- [ ] **Step 7: Verify the full build + types pipeline**

Run: `pnpm --filter @tejika/env build`
Expected: writes `packages/env/lib/index.js`, `lib/env-var.js`, `lib/index.d.ts`, `lib/env-var.d.ts`. Exit 0.

Run: `pnpm --filter @tejika/env run test:types`
Expected: tsc exits 0.

Run: `pnpm lint`
Expected: biome exits 0 (formats the new files cleanly).

- [ ] **Step 8: Commit**

```bash
git add packages/env pnpm-lock.yaml
git commit -m "feat(env): scaffold @tejika/env with appEnvVar helper"
```

---

### Task 3: Agent docs & conventions gate (P0.5)

Propagate the shared `agents/` repo conventions into `tejika`. Source files live in the sibling `../agents/` repo. This task BLOCKS the extraction plan.

**Files:**
- Create: `AGENTS.md`
- Create: `CLAUDE.md`
- Create: `docs/agents/conventions.md`
- Create: `docs/agents/development.md`
- Create: `docs/agents/enkaku.md`
- Create: `docs/agents/architecture.md`
- Create: `docs/agents/plans/roadmap.md`
- Create: `docs/agents/plans/project-loop-state.md`
- Create: `docs/agents/plans/backlog/.gitkeep`, `completed/.gitkeep`, `archive/.gitkeep`, `milestones/.gitkeep`
- Create: `.claude/skills/dev-loop/SKILL.md`, `.claude/skills/project-loop/SKILL.md`, `.claude/skills/complete/SKILL.md`, `.claude/skills/archive/SKILL.md`
- Modify (in `../agents/`): `agents/AGENTS.md` (Target Repos table), `agents/ENKAKU.md` (preamble)

**Interfaces:**
- Consumes: the canonical `../agents/` repo (`SHARED.md`, `ENKAKU.md`, `skills/*`).
- Produces: a conventions-complete repo whose `CLAUDE.md` loads `AGENTS.md`, which references the `docs/agents/` sub-files.

- [ ] **Step 1: Propagate conventions, development, and enkaku docs from the canonical source**

Copy verbatim (these are propagation, not authored content):
- `../agents/SHARED.md` sections **1–4** → `docs/agents/conventions.md`
- `../agents/SHARED.md` sections **5–9** → `docs/agents/development.md`
- `../agents/ENKAKU.md` (whole file) → `docs/agents/enkaku.md`

Run: `cat ../agents/SHARED.md` and `cat ../agents/ENKAKU.md` and split per the section mapping documented in `../agents/AGENTS.md` ("How This Repo Is Used"). Preserve headings exactly.

- [ ] **Step 2: Author `AGENTS.md` (repo-specific, modeled on Mokei's)**

```markdown
# AGENTS.md

Tejika (手近, "near at hand") is the local-side foundation for the Yulsi stack:
shared packages for building CLI tools, managing local processes/daemons, running
local HTTP servers, and resolving local paths/ports. It is the counterpart to
Enkaku (遠隔, "remote") — Enkaku is the transport/remote foundation, tejika is
everything at hand on the local machine. Tejika sits above Enkaku and below
Mokei / Kubun / Sakui.

## Package Overview

\`\`\`
packages/
+-- env/        # Local paths, ports, and env-var overrides (getSocketPath, getPort, ...)
+-- process/    # Local daemon spawn / lifecycle / Enkaku client reconnect
+-- server/     # Local Hono HTTP server: loopback-private (default) or network mode
+-- cli/        # commander + Ink plumbing (buildProgram, runInk, option builders)
+-- ui/         # Generic Ink component kit (StatusLine, ConfirmCard, SelectCard, ...)
\`\`\`

## Quick Commands

| Command | Purpose |
|---------|---------|
| \`pnpm build\` | Full build (types + JS) |
| \`pnpm test\` | Run all tests |
| \`pnpm lint\` | Lint and format |

## Important Guardrails

**DO NOT:**
- Use \`interface\` for type definitions (use \`type\`)
- Use \`T[]\` instead of \`Array<T>\`
- Use \`any\` type -- use \`unknown\`, \`Record<string, unknown>\`, or a more specific type
- Use lowercase abbreviations in names (\`ID\` not \`Id\`, \`HTTP\` not \`Http\`, \`JWT\` not \`Jwt\`)
- Use the TS \`private\`/\`readonly\` modifiers -- use ES private fields (\`#field\`) + getters
- Use \`npm\`/\`npx\` -- always use \`pnpm\`/\`pnpx\`
- Edit generated files (\`lib/\`)
- Create new packages without checking with the user
- Write workarounds for bugs in \`@enkaku/*\` -- fix at the source repo

## Additional Context

| Task | Files to read |
|------|---------------|
| Planning | \`docs/agents/architecture.md\`, \`docs/agents/enkaku.md\` |
| Implementation | \`docs/agents/conventions.md\`, \`docs/agents/development.md\`, \`docs/agents/enkaku.md\` |
| Review | \`docs/agents/conventions.md\`, \`docs/agents/architecture.md\`, \`docs/agents/development.md\` |
```

- [ ] **Step 3: Author `CLAUDE.md`**

```markdown
@AGENTS.md
```

- [ ] **Step 4: Author `docs/agents/architecture.md` (repo-specific lightweight overview)**

Content: the local↔remote framing, the 5 packages and their one-line responsibilities, the dependency graph (env → process/server; cli/ui independent), and the "depends on Enkaku directly" decision. Source the package summaries from the design spec at `docs/superpowers/specs/2026-06-20-tejika-foundation-design.md` (Packages section). Keep to ~40 lines.

- [ ] **Step 5: Seed the plan lifecycle dirs and files**

`docs/agents/plans/roadmap.md`:
```markdown
# Tejika Roadmap

## Phase 1 — Foundation packages (P1)
- `@tejika/env`, `@tejika/process`, `@tejika/server` extracted from Mokei. Mokei consumes them.

## Phase 2 — CLI packages (P2)
- `@tejika/cli`, `@tejika/ui` extracted from Mokei. Mokei fully migrated.

## Later (separate repos / specs)
- P3 Sakui migration. P4 Kubun migration.
```

`docs/agents/plans/project-loop-state.md`:
```markdown
# Project Loop State

Current focus: P1 foundation packages (see `roadmap.md`).
```

Create empty dirs with `.gitkeep`: `backlog/`, `completed/`, `archive/`, `milestones/`.

- [ ] **Step 6: Copy the four shared skills**

Run:
```bash
mkdir -p .claude/skills
cp -r ../agents/skills/dev-loop .claude/skills/dev-loop
cp -r ../agents/skills/project-loop .claude/skills/project-loop
cp -r ../agents/skills/complete .claude/skills/complete
cp -r ../agents/skills/archive .claude/skills/archive
```
Expected: each `.claude/skills/<name>/SKILL.md` exists.

- [ ] **Step 7: Update the canonical `agents/` repo (rule 1: source first)**

In `../agents/AGENTS.md`, add a `tejika` row to the **Target Repos** table:
```
| tejika | yes | yes | yes | yes |
```

In `../agents/ENKAKU.md`, change the preamble "When building features in sakui, kubun, or mokei" to include `tejika` (e.g. "in sakui, kubun, mokei, or tejika").

(Do not commit the `agents/` repo as part of tejika; note the change for the user to commit there separately.)

- [ ] **Step 8: Verify the gate**

Run: `ls AGENTS.md CLAUDE.md docs/agents/conventions.md docs/agents/development.md docs/agents/enkaku.md docs/agents/architecture.md`
Expected: all present.

Run: `ls .claude/skills/dev-loop/SKILL.md .claude/skills/project-loop/SKILL.md .claude/skills/complete/SKILL.md .claude/skills/archive/SKILL.md`
Expected: all present.

Confirm `AGENTS.md` references resolve (every path in its "Additional Context" table exists).

- [ ] **Step 9: Commit**

```bash
git add AGENTS.md CLAUDE.md docs/agents .claude/skills
git commit -m "docs: adopt Yulsi agent conventions and plan lifecycle"
```

---

## Self-Review

- **Spec coverage:** Task 1 covers tooling/conventions (spec "Tooling & conventions"). Task 2 starts `@tejika/env` (spec package 1). Task 3 covers the P0.5 gate (spec "Agent docs & conventions gate"), including the `agents/` source update. Packages process/server/cli/ui are intentionally deferred to the extraction plan (`2026-06-20-tejika-packages-extraction.md`).
- **Gate enforcement:** Task 3 is the documented blocker for P1; the extraction plan's first task restates the precondition.
- **Placeholders:** none — all config and the `appEnvVar` util are shown in full. Doc-propagation steps reference exact canonical source files (legitimate; content is not authored here).
- **Type consistency:** `appEnvVar(app, key)` signature is identical in Task 2's test, implementation, and Interfaces block, and is the symbol the extraction plan consumes.
