# AGENTS.md

Tejika (手近, "near at hand") is a local-side foundation library:
shared packages for building CLI tools, managing local processes/daemons, running
local HTTP servers, and resolving local paths/ports. It is the counterpart to
Enkaku (遠隔, "remote") — Enkaku is the transport/remote foundation, tejika is
everything at hand on the local machine. Tejika sits above Enkaku and below the
apps that consume it.

## Package Overview

```
packages/
+-- env/        # Local paths, ports, and env-var overrides (getSocketPath, getPort, ...)
+-- process/    # Local daemon spawn / lifecycle / Enkaku client reconnect
+-- server/     # Local Hono HTTP server: loopback-private (default) or network mode
+-- cli/        # commander + Ink plumbing (buildProgram, runInk, option builders)
+-- ui/         # Generic Ink component kit (StatusLine, ConfirmCard, SelectCard, ...)
```

## Quick Commands

| Command | Purpose |
|---------|---------|
| `pnpm build` | Full build (types + JS) |
| `pnpm test` | Run all tests |
| `pnpm lint` | Lint and format |

## Important Guardrails

**DO NOT:**
- Use `interface` for type definitions (use `type`)
- Use `T[]` instead of `Array<T>`
- Use `any` type -- use `unknown`, `Record<string, unknown>`, or a more specific type
- Use lowercase abbreviations in names (`ID` not `Id`, `HTTP` not `Http`, `JWT` not `Jwt`)
- Use the TS `private`/`readonly` modifiers -- use ES private fields (`#field`) + getters
- Use `npm`/`npx` -- always use `pnpm`/`pnpx`
- Edit generated files (`lib/`)
- Create new packages without checking with the user
- Write workarounds for bugs in `@enkaku/*` -- fix at the source repo

## Additional Context

| Task | Files to read |
|------|---------------|
| Planning | `docs/agents/architecture.md`, `docs/agents/enkaku.md` |
| Implementation | the `conventions` and `development` skills, `docs/agents/enkaku.md` |
| Review | the `conventions` skill, `docs/agents/architecture.md`, the `development` skill |
