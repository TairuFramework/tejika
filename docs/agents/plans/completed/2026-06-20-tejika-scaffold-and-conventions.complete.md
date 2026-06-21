# Tejika Scaffold & Conventions — Completed

**Status:** complete
**Date:** 2026-06-20

## Goal

Stand up the `tejika` monorepo with the stack's exact tooling and agent
conventions, plus one real proving package (`@tejika/env`'s first util) that
validates the full build/types/test/lint pipeline.

## What was built

- **Workspace tooling:** pnpm workspace (`packageManager pnpm@11.8.0`), `catalog:`
  dependency pinning (`catalogMode: manual`, `minimumReleaseAgeExclude: ['@enkaku/*']`),
  swc for JS build, tsc for `.d.ts`, turbo to orchestrate `build:js`, biome for
  lint/format, vitest for tests. Root configs: `package.json`, `pnpm-workspace.yaml`,
  `tsconfig.build.json`, `tsconfig.json`, `swc.json`, `turbo.json`, `biome.json`,
  `.gitignore`.
- **`@tejika/env` seed:** `appEnvVar(app, key)` — uppercases the app slug,
  normalises non-alphanumerics to `_`, joins the key (e.g. `mokei`,`PORT` →
  `MOKEI_PORT`). The helper every env resolver uses to compute its override
  var name. TDD, 2 tests; proved swc build + tsc declarations + vitest end to end.
- **Agent conventions gate (P0.5):** `AGENTS.md` (loaded by `CLAUDE.md`),
  `docs/agents/{conventions,development,enkaku,architecture}.md`, the plan
  lifecycle dirs (`backlog/`, `completed/`, `archive/`, `milestones/`) with
  `roadmap.md` + `project-loop-state.md`, and the four shared skills
  (`dev-loop`, `project-loop`, `complete`, `archive`) under `.claude/skills/`.
  conventions/development/enkaku docs were propagated verbatim from the canonical
  `../agents/` repo (SHARED.md §1-4 → conventions, §5-9 → development, ENKAKU.md
  → enkaku). The canonical `../agents/` repo was updated first (Target Repos
  table + ENKAKU preamble now include `tejika`) — committed separately there.
- **Pre-commit hooks** (added post-plan, mirroring enkaku): root `prepare`
  script wires `core.hooksPath .githooks`; `.githooks/pre-commit` runs
  `pnpm biome check --write --staged` then `pnpm run build:types`. The committed
  hook uses `pnpm biome` directly (not the `rtk` wrapper) so it is self-contained.

## Key design decisions

- **pnpm only** (`pnpm`/`pnpx`, never `npm`/`npx`).
- TypeScript house style: `type` not `interface`; `Array<T>` not `T[]`; never
  `any`; ES `#field` not TS `private`/`readonly`; capitalised abbreviations
  (`ID`/`HTTP`/`JWT`). Every package: `type: module`, `main: lib/index.js`,
  `types: lib/index.d.ts`, `exports`, `files: ["lib/*"]`, `sideEffects: false`.
- All shared dep versions live in the workspace `catalog:`; packages reference
  `catalog:` / `workspace:^`, never raw ranges. Enkaku floor `^0.17`.
- Sibling-repo layout assumption: `tejika`, `enkaku`, `mokei`, and the agent-docs
  source repo are siblings under one parent. No absolute paths in committed files.
- Agent docs are **manually propagated** from `../agents/` (no automation);
  `tejika`'s `AGENTS.md` references the `docs/agents/` sub-files and adds the
  repo-specific package overview + guardrails.

## Architecture framing

Tejika (手近, "near at hand") is a local-side foundation library —
the counterpart to Enkaku (遠隔, "remote"). It sits above Enkaku and below
the apps that consume it. Five packages: `env`, `process`, `server`, `cli`, `ui`.
