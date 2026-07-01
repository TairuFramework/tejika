# Development

Shared build, test, and release workflow lives in the kigu `development` skill,
auto-loaded via the kigu plugin. See it for the pnpm / Turbo / SWC / Biome / Vitest
workflow and the `docs/agents/plans/` lifecycle.

## Repo-specific

Local-side foundation (env, process, server, cli, ui). Consumes `@enkaku` 0.18 (client,
protocol, server, socket, http-serve). Integration tests at `tests/integration/`.
