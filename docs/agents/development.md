## 5. Build System

All repos use **pnpm workspaces** with **Turbo** for build orchestration.

### Package Management
- **Always use `pnpm` instead of `npm`** and **`pnpx` instead of `npx`** for all commands
- Use `workspace:^` protocol for internal package dependencies
- Add shared dependency versions to the **pnpm catalog** (defined in `pnpm-workspace.yaml`) when possible
- Each package should be buildable independently
- Avoid circular dependencies between packages

### Compilation
- Use **SWC** for JavaScript compilation (not tsc)
- TypeScript is used only for type checking and declaration generation
- Generated files go in `lib/` directories and should not be edited

### Standard Scripts

Every package should have these scripts where applicable:

| Script | Purpose |
|--------|---------|
| `build` | Full build (types + JS) |
| `build:clean` | Remove build artifacts |
| `build:js` | JavaScript compilation via SWC |
| `build:types` | TypeScript declaration generation |
| `test:types` | Type checking via tsc |
| `test:unit` | Unit tests via Vitest |

Root-level commands:

```bash
pnpm run build        # Build all packages (types then JS)
pnpm run build:types  # TypeScript declarations only
pnpm run build:js     # JavaScript compilation only
pnpm run lint         # Format and lint all packages
```

---

## 6. Testing

All repos use **Vitest** as the test runner.

### Commands
```bash
pnpm test             # Run all tests (type checks + unit tests)
pnpm run test:types   # TypeScript type checking only
pnpm run test:unit    # Unit tests only
```

### Conventions
- Use **`test`** (not `it`) for test cases
- Import from vitest: `import { describe, expect, test } from 'vitest'`
- Use descriptive test names that explain behavior
- Test files use `.test.ts` suffix
- Place tests in `test/` or `__tests__/` directories (follow repo convention)
- Use async/await for asynchronous tests
- Test both success and failure cases

```typescript
import { describe, expect, test } from 'vitest'

describe('TokenValidator', () => {
  test('rejects expired tokens', async () => {
    const token = createToken({ exp: pastDate })
    await expect(validate(token)).rejects.toThrow('Token expired')
  })
})
```

---

## 7. Dependency Stack

Core tools shared across all repos:

| Tool | Purpose |
|------|---------|
| **Biome** | Linting and formatting |
| **Vitest** | Testing |
| **pnpm** | Package management (use catalog for shared deps) |
| **Turbo** | Build orchestration |
| **SWC** | JavaScript compilation |
| **TypeScript** | Type checking and declaration generation (strict mode, ES2025) |

---

## 8. Planning and Documentation

All repos use `docs/agents/plans/` for persistent plan artifacts and `docs/superpowers/` for ephemeral working documents.

### Directory Structure

#### Ephemeral (branch/feature lifetime)

```
docs/superpowers/
  specs/          # Brainstorming design specs
  plans/          # Implementation plans
```

These files live on feature branches and are cleaned up when work is completed.

#### Persistent (cross-feature, on main)

```
docs/agents/plans/
  next/             # Immediate priorities -- concrete work to pick up soon
  backlog/          # Low-priority improvements -- no committed timeline
  completed/        # Recently finished -- individual summaries, still referenced by active work
  archive/          # Long-term -- monthly summaries of plans no longer actively referenced
  milestones/       # Detailed design docs for current focus areas (e.g., mvp-desktop-app.md)
  roadmap.md        # Project roadmap -- repo-local, references milestones for detail
  project-loop-state.md  # Project-loop activity timestamps -- repo-local
```

### Discovery

- Working on something now? Check `docs/superpowers/plans/` and `docs/superpowers/specs/`
- What's next? Check `docs/agents/plans/next/`
- What could we do someday? Check `docs/agents/plans/backlog/`
- What did we already do? Check `docs/agents/plans/archive/`

### Workflow

1. **Brainstorm**: Design spec written to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
2. **Plan**: Implementation plan written to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`
3. **Execute**: Implement the plan on a feature branch
4. **Review**: Code review pass
5. **QA**: Human testing
6. **Complete**: Summarise finished work to `docs/agents/plans/completed/`, clean up ephemeral files (use `/complete` skill)
7. **Finish**: Merge branch or create PR
8. **Archive**: Periodically consolidate unreferenced completed plans into monthly summaries (use `/archive` skill)

### Skills

Four shared skills manage the plan and project lifecycle:

| Skill | Purpose |
|-------|---------|
| `/dev-loop` | Orchestrate the full development cycle with session resumption |
| `/project-loop` | Manage project priorities, roadmap, architecture review, and triage |
| `/complete` | Summarise finished plan, move to `completed/`, clean up ephemeral files |
| `/archive` | Consolidate unreferenced completed plans into monthly summaries |

Skills live in the `agents` repo under `skills/` and are manually propagated to `.claude/skills/` in each consuming repo.

### Archive Statuses

| Status | Meaning |
|--------|---------|
| **complete** | Fully implemented as planned |
| **partial** | Some items implemented, remaining work moved to next/ or backlog/ |
| **cancelled** | Work was not done, plan is no longer relevant |
| **superseded** | Replaced by a newer plan (link to the replacement) |

Format: Filename suffix (e.g., `YYYY-MM-DD-feature-name.complete.md`) and `**Status:** complete` near the top of the document.

---

## 9. Agent Conduct

How an agent should behave when writing or editing code in this repo. These apply to every change, not just feature work. For trivial tasks, use judgment -- they bias toward caution over speed.

### Think Before Coding
- State assumptions explicitly. If uncertain, ask before implementing.
- If multiple interpretations exist, surface them -- do not pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop and name what is confusing.

### Simplicity First
Write the minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that was not requested.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite it.

This is the same ethos as the Placeholder Values rule (section 1): do not add structure to satisfy an imagined requirement any more than you add fake values to satisfy the type checker.

### Surgical Changes
Touch only what the request requires. Every changed line should trace directly to the user's request.

- Do not "improve" adjacent code, comments, or formatting.
- Do not refactor things that are not broken.
- Match existing style, even if you would do it differently.
- Remove imports/variables/functions that **your** changes made unused. Do not delete pre-existing dead code -- flag it instead.

This is the documented form of the constraint the surgical-edit subagent enforces by refusing 3+ file scope.

### Goal-Driven Execution
Turn tasks into verifiable goals, then loop until verified.

- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

Strong success criteria let the agent loop independently; weak criteria ("make it work") force constant clarification. This complements the TDD and verification-before-completion workflows, and the multi-stage `/dev-loop` lifecycle (section 8).
