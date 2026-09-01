# Migrate Mokei to consume `@tejika/*` — done

**Completed:** 2026-09-01 (confirmed applied during project-loop triage; the work itself landed in
the `../mokei` repo over the preceding weeks). **Status:** complete.
**Origin:** deferred Task 6 of the tejika packages extraction — Mokei was always the intended first
consumer, to prove the extracted APIs and delete Mokei's duplicated implementations.

## Goal

Make Mokei the first real consumer of the `@tejika/*` packages, proving the extracted APIs and
removing Mokei's now-duplicated local paths / daemon / server / CLI / UI code.

## What was verified

Mokei consumes all six runtime packages via the workspace catalog (`catalog:`), spread across three
of its packages — not a token adoption:

- **`@mokei/host-node`** → `@tejika/process` + `@tejika/env`. `daemon.ts` is now a ~1 KB wrapper
  over `@tejika/process`; the bespoke controller/process/socket daemon code is gone.
- **`@mokei/host-monitor`** → `@tejika/server` + `@tejika/env` (`createLocalServer` + the loopback
  defenses, monitor stream wiring kept local).
- **`@mokei/cli`** → `@tejika/cli` + `@tejika/ui`. Program/options plumbing and the generic chat
  components come from tejika; chat-domain components (AssistantMessage, ToolApprovalCard, …) stay
  local as planned.

The one remaining `host-node/src/spawn.ts` is **not** leftover duplication: it spawns Mokei's MCP
context servers over piped stdio, a different concern from `@tejika/process`'s detached daemon
spawn. Correctly kept local.

## Notes

- The Mokei package the plan called `@mokei/host` is now `@mokei/host-node`; the rename is Mokei's
  own and does not affect the tejika API surface.
- Cross-repo link resolved through the workspace catalog rather than `link:`.
- Verification here is by consumption evidence in the Mokei tree, not by running Mokei's own suite
  (that lives with Mokei's CI).

## Follow-on

- Sakui is the other active consumer; its migration to the current `@tejika/process` API is tracked
  in `docs/agents/plans/backlog/2026-07-09-sakui-tejika-api-migration.md`.
- Before more consumers freeze onto the API, the `@tejika/env` path renames in
  `docs/agents/plans/next/2026-07-06-env-paths-hardening.md` are cheapest to land — promoted to
  `next/` in the same triage that closed this item.
