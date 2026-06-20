# Tejika — Local-Side Foundation for the Yulsi Stack

**Status:** Design approved, ready for implementation planning
**Date:** 2026-06-20
**Author:** Paul Le Cam (with Claude)

## Summary

`tejika` (手近, "near at hand / handy") is a new monorepo providing the shared
**local-machine foundation** for CLI tools across the Yulsi stack
(Enkaku / Mokei / Kubun / Sakui). It collects four concerns that are currently
reinvented or copy-pasted across consumers:

1. **CLI construction** — commander + Ink wiring
2. **Process management** — local daemon spawn / lifecycle / client reconnect
3. **Local HTTP server** — loopback-private by default, with access control
4. **Env / paths / ports** — deterministic local paths with env-var overrides

### Architectural framing

Tejika is the conceptual counterpart to Enkaku:

- **Enkaku 遠隔** = remote / control at a distance (transport foundation)
- **Tejika 手近** = at hand / local (CLI, local process, local socket/port, local HTTP)

Same axis (distance of control), opposite ends. Tejika sits **above Enkaku,
below Mokei / Kubun / Sakui** in the dependency graph, and depends on Enkaku
transports directly.

### Drivers

- Kill real duplication (daemon controller + HTTP hardening reinvented in 3 places)
- Standardize CLI UX and daemon/security behavior across the stack
- Enable new consumers to get CLI + daemon + local server "for free"
- Cut maintenance load, especially on the security-sensitive HTTP access-control code
- **Converge all consumers on commander + Ink**, migrating Kubun off oclif/ora and
  Sakui off its custom argv router (Mokei is already commander + Ink — the reference)

## Decisions log

These were settled during brainstorming:

| Decision | Choice | Rationale |
|---|---|---|
| Repo / npm org | `tejika` / `@tejika` | "Near at hand", matches local-side scope; pairs with Enkaku |
| Enkaku coupling | **Depend on Enkaku directly** | Simplest; matches all 3 real consumers; no non-Enkaku consumer exists |
| CLI vs UI | **Split** into `@tejika/cli` + `@tejika/ui` | Cleanest boundary; UI kit is opt-in |
| Server scope | **Loopback default + opt-in network** | Covers Mokei monitor (loopback) and Kubun serve (network) |
| Spawning | Standardize on **nano-spawn** | Mokei already uses it; drop Sakui's raw `child_process` |
| Env package name | `@tejika/env` | Covers paths + ports + env-var overrides (not just paths) |
| `cli` ↔ `ui` dependency | `@tejika/cli` independent of `@tejika/ui` | Apps compose both; neither forces the other |
| Donor / seed | **Mokei** | Most mature impl; becomes first consumer and depends back |

## Packages

Five packages. Dependency graph:

```
@tejika/env       no @tejika deps (foundational)
@tejika/ui        ink, @inkjs/ui, react
@tejika/cli       commander, ink, react; env (defaults)
@tejika/process   env + @enkaku/{socket-transport,client,server} + nano-spawn
@tejika/server    env + @enkaku/http-server-transport + hono + @hono/node-server + get-port
```

`@tejika/cli` and `@tejika/ui` are independent; consuming apps compose both.

### 1. `@tejika/env`

Deterministic local paths, ports, and env-var overrides. The 4th concern.

**Seed:** Sakui `apps/cli/src/paths.ts`.

**Public API (sketch):**

```ts
getDataDir(app: string): string          // XDG/env-paths data dir
getStateDir(app: string): string         // XDG/env-paths state dir
getSocketPath(app: string, name?: string): string
getPidPath(app: string): string
getPort(app: string, opts?: { default?: number }): Promise<number>
```

- Deterministic default via `env-paths`/XDG conventions.
- Env override per key, derived from the app slug, uppercased:
  `MYAPP_SOCKET_PATH`, `MYAPP_PORT`, `MYAPP_DATA_DIR`, etc.
- `getPort` wraps `get-port` for auto-assignment, honoring the env override first.

**Deps:** `env-paths` (or equivalent), `get-port`. No `@tejika` deps.

### 2. `@tejika/process`

Local daemon lifecycle and Enkaku client management.

**Seed:** Mokei `@mokei/host` (`daemon/controller.ts`, `daemon/process.ts`,
`server.ts`) + Sakui `apps/cli/src/daemon/`.

**Public API (sketch):**

```ts
spawnDaemon(opts): Promise<void>          // detached child + socket readiness poll
runDaemon(opts): Promise<void>            // foreground bootstrap, signal handlers, pidfile, cleanup
createDaemonClient(opts): Client          // Enkaku client + reconnect backoff (250ms–5s)
ensureDaemon(opts): Promise<Client>       // connect, else spawn + retry
getDaemonStatus(opts): { running, pid, stale }
stopDaemon(opts): Promise<void>           // SIGTERM via pidfile, reap stale
```

- Spawning via **nano-spawn**, detached, stdio → daemon log.
- Unix socket server with `chmod 0o600` (owner-only trust boundary).
- Pidfile management, split-brain guard, SIGINT/SIGTERM cleanup.
- Readiness via socket-poll; reconnect via exponential backoff.

**Deps:** `@tejika/env`, `@enkaku/socket-transport`, `@enkaku/client`,
`@enkaku/server`, `nano-spawn`.

### 3. `@tejika/server`

Local HTTP server with access control. Hono-based.

**Seed:** Mokei `@mokei/host-monitor` (`index.ts`, `auth.ts`, `html.ts`, `pipes.ts`).

**Public API (sketch):**

```ts
createLocalServer(opts: {
  app: string
  bind?: 'loopback' | 'network'   // default 'loopback'
  port?: number                   // default: getPort(app)
  auth?: AuthConfig
}): { app: Hono; url: string; token?: string; close(): Promise<void> }

attachEnkakuTransport(server, opts)  // wire @enkaku/http-server-transport
serveStaticSPA(server, opts)         // static dir + index fallback + token injection
```

**Loopback mode (default):**
- Bind `127.0.0.1`.
- Host-header allowlist (DNS-rebinding defense): loopback aliases + port.
- Origin-header allowlist (CSRF defense); non-browser clients (no Origin) allowed.
- Bearer token: random 256-bit hex, timing-safe comparison via `crypto.timingSafeEqual`.
- Optional static-SPA serving with token injected into HTML (monitor use-case).

**Network mode (opt-in `bind:'network'`):**
- Bind `0.0.0.0`.
- CORS via configurable `allowedOrigin`.
- Pluggable auth hook (e.g. Kubun's DID-based access rules) instead of the
  loopback token gate.

**Deps:** `@tejika/env`, `@enkaku/http-server-transport`, `hono`,
`@hono/node-server`, `get-port`.

### 4. `@tejika/cli`

Commander + Ink plumbing. No domain components.

**Reference:** Mokei `packages/cli` (`program.ts`, `ink.ts`, `options.ts`).

**Public API (sketch):**

```ts
buildProgram(opts: { name, version, commands }): Command  // commander wrapper
runInk(element): Promise<void>            // interactive Ink app render
renderStatic(element): void               // non-interactive output
withSocketPath(cmd): Command              // option builders wired to @tejika/env defaults
withPort(cmd): Command
withLogLevel(cmd): Command
```

- commander `^15`, each subcommand a `createXCommand()` factory added via `addCommand`.
- `runInk` / `renderStatic` helpers around Ink `render`.
- Option builders default values from `@tejika/env` (peer-imported, not a hard dep
  on running — defaults computed lazily).

**Deps:** `commander`, `ink`, `react`; `@tejika/env` (for default option values).

### 5. `@tejika/ui`

Generic Ink component kit. Behavior-first, minimal styling. Domain components
(LayoutRenderer, IntentBox, chat views) stay in their respective apps.

**Seed:** Mokei `packages/cli/src/chat/components/*` (stripped of chat domain).

**Components (initial set):**
- `StatusLine`, `Footer` / `KeyHints`, `ConfirmCard`, `SelectCard`,
  `Spinner` / `WaitingStatus`, `IconLine`, `SystemNotice`.

**Deps:** `ink`, `@inkjs/ui`, `react`. No other `@tejika` deps.

## Tooling & conventions

Mirror the Mokei/Kubun stack tooling exactly:

- **pnpm** `@11.8.0`, workspace + `catalog:` (catalogMode `manual`),
  `minimumReleaseAgeExclude: ['@enkaku/*']`.
- **Build:** swc `build:js` (`src` → `lib`), tsc `build:types` (`--emitDeclarationOnly`),
  turbo to orchestrate `build:js`.
- **Lint:** biome.
- **Tests:** vitest. CLI integration via `node-pty` + `strip-ansi` (Sakui pattern);
  components via `ink-testing-library`.
- Each package: `type: module`, `main: lib/index.js`, `types: lib/index.d.ts`,
  `exports`, `files: [lib/*]`, `sideEffects: false`.
- Catalog versions (already standard in Mokei): `@enkaku/* ^0.17`, `commander ^15`,
  `ink ^7.1`, `@inkjs/ui ^2`, `hono ^4.12`, `@hono/node-server ^2`, `get-port ^7.2`,
  `nano-spawn ^2.1`, `react ^19.2`, `vitest ^4.1`, `typescript ^6`.

## Scope

### In scope for this spec (P0–P2)

- Scaffold the `tejika` repo (workspace, catalog, tooling, CI-shaped scripts).
- **Agent docs & conventions gate (P0.5)** — propagate the shared `agents/` repo
  conventions into `tejika` before any package code (see dedicated section).
- Implement the 5 packages with the APIs above.
- Seed/extract from Mokei (the donor); generalize app-specific bits behind the
  `app: string` parameter and options.
- **Mokei migrates as the first consumer** and depends back on `@tejika/*`,
  proving the APIs.

### Out of scope (follow-on specs, each in its own repo)

- **P3 — Sakui migration:** custom argv → `@tejika/cli`; `daemon/` → `@tejika/process`;
  `paths.ts` → `@tejika/env`. Sakui's domain Ink components stay in Sakui.
- **P4 — Kubun migration:** oclif → `@tejika/cli`; ora → `@tejika/ui` spinner;
  `serve` / `plugin-http` → `@tejika/server` (network mode); `mcp` command.

### Explicit non-goals (YAGNI)

- Transport-agnostic abstraction layer (no non-Enkaku consumer exists).
- Migrating domain-coupled Ink components (LayoutRenderer, IntentBox, chat views)
  into `@tejika/ui` — they are app-specific.
- Kubun's public hub-server / relay (a different beast; stays in Kubun).
- Unifying every CLI flag across consumers — only the shared plumbing is standardized.

## Migration sequencing

1. **P0** — Scaffold the `tejika` repo and empty package skeletons.
2. **P0.5** — Agent docs & conventions gate (see below). **Blocks P1.**
3. **P1** — Extract `@tejika/env`, `@tejika/process`, `@tejika/server` from Mokei
   (`@mokei/host`, `host-monitor`). Generalize behind `app`/options. Mokei depends back.
4. **P2** — Extract `@tejika/cli`, `@tejika/ui` from Mokei `cli`. Mokei migrates fully.
5. **P3** — Sakui migration (separate spec).
6. **P4** — Kubun migration (separate spec).

Each consumer migration is its own spec → plan → implementation cycle in its own repo.

## Agent docs & conventions gate (P0.5)

Before any package implementation, `tejika` must adopt the Yulsi stack's shared
agent conventions. Source of truth is the sibling **`agents/`** repo (a no-code
canonical reference); each consuming repo manually propagates sub-files into its
own `docs/agents/`. Mokei and Enkaku are the closest implementation examples
(code monorepos that depend on Enkaku).

### Files to create in `tejika`

- `AGENTS.md` — repo entry point: one-paragraph overview, package list, quick
  commands, `## Important Guardrails` (the standard DO-NOT list), and an
  `## Additional Context` task→files table. Modeled on Mokei's `AGENTS.md`.
- `CLAUDE.md` — single line: `@AGENTS.md`.
- `docs/agents/conventions.md` — sourced from `agents/SHARED.md` sections 1–4
  (TypeScript conventions, formatting).
- `docs/agents/development.md` — sourced from `agents/SHARED.md` sections 5–9
  (build system, testing, dependency stack, planning workflow, agent conduct).
- `docs/agents/enkaku.md` — sourced from `agents/ENKAKU.md` (tejika depends on
  Enkaku, so this file **is** included).
- `docs/agents/architecture.md` — repo-specific lightweight overview (the 5
  packages, the local↔remote framing). Mirrors Mokei's `architecture.md`.
- `docs/agents/plans/` — lifecycle dirs + files: `roadmap.md`,
  `project-loop-state.md`, `backlog/`, `completed/`, `archive/`, `milestones/`.
- `.claude/skills/{dev-loop,project-loop,complete,archive}/SKILL.md` — copied
  from `agents/skills/*`.
- `.gitignore`, `.claude/settings.local.json` — mirror stack conventions.

### Conventions tejika must encode (highlights from `SHARED.md` / `ENKAKU.md`)

- `type` not `interface`; `Array<T>` not `T[]`; never `any`.
- ES private fields (`#field`), never TS `private`/`readonly`; single
  `ClassNameParams` constructor object.
- Capitalized abbreviations (`ID`, `HTTP`, `JWT`).
- `pnpm`/`pnpx` only; never `npm`/`npx`.
- Prefer Enkaku packages over third-party (e.g. `@enkaku/schema` over Zod,
  `@enkaku/log` over custom logging) per `ENKAKU.md`.

### Update the `agents/` repo too (rule 1: update source first)

Per the `agents/` repo rules, update the canonical source before/with propagation:

- Add a `tejika` row to the **Target Repos** table in `agents/AGENTS.md`
  (`conventions.md` yes, `development.md` yes, `enkaku.md` yes, `skills/` yes).
- Extend `agents/ENKAKU.md`'s "When building features in sakui, kubun, or mokei"
  preamble to include `tejika`.

### Gate criterion

P1 does not start until `tejika` has `AGENTS.md` + `CLAUDE.md` +
`docs/agents/{conventions,development,enkaku,architecture}.md` + the plan
lifecycle dirs + the four skills, and the `agents/` repo reflects `tejika` as a
target.

## Security notes (`@tejika/server`)

The loopback model is security-sensitive and must preserve Mokei's existing defenses:

- **DNS-rebinding:** Host-header allowlist; reject mismatched Host.
- **CSRF:** Origin-header allowlist when an Origin is present.
- **Auth:** Bearer token, random 256-bit, timing-safe comparison only.
- **Network mode** weakens these by design (0.0.0.0 + CORS); auth becomes the
  caller's pluggable responsibility. Document the trade-off at the call site.
- Unix socket files remain `chmod 0o600` in `@tejika/process`.

## Open points (decided defaults — veto on review)

1. **Env package name** — `@tejika/env` (covers paths + ports + env-var overrides).
2. **`cli` ↔ `ui`** — `@tejika/cli` stays independent of `@tejika/ui`.
3. **Donor** — Mokei is the seed; Mokei migrates first and depends back.

## Testing strategy

- **`@tejika/env`** — unit tests for default resolution + env override precedence.
- **`@tejika/process`** — integration: spawn a real daemon, assert readiness poll,
  reconnect after kill, pidfile reap, `chmod 0o600`.
- **`@tejika/server`** — request tests for Host/Origin/token gates (accept + reject
  matrix), loopback vs network bind, timing-safe token path.
- **`@tejika/cli`** — `node-pty` + `strip-ansi` integration over a real built program.
- **`@tejika/ui`** — `ink-testing-library` snapshot/behavior tests per component.
