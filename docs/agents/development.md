# Development

Shared build, test, and release workflow lives in the kigu `development` skill,
auto-loaded via the kigu plugin. See it for the pnpm / Turbo / SWC / Biome / Vitest
workflow and the `docs/agents/plans/` lifecycle.

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
