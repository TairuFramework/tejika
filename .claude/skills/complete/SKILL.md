# Complete Plan

Summarise finished work and transition from ephemeral to persistent storage.

All writes happen on the feature branch. The persistent files in `docs/agents/plans/` land on `main` when the branch merges via the finishing stage.

## CRITICAL: no ephemeral references in persistent files

Files under `docs/superpowers/` (specs/, plans/) are **ephemeral** — step 8 deletes them. Every persistent file this skill writes (the completed summary AND any follow-on in `next/`/`backlog/`) MUST be self-contained: **never reference a `docs/superpowers/` path.** Such a link dangles the moment step 8 runs.

When carrying context from a spec/plan into a persistent file:
- **Inline the substance** (the design decision, the invariant, the rationale) directly — do not link to the source.
- **Cross-reference siblings instead:** point to the completed summary (`docs/agents/plans/completed/...`) or another `next/`/`backlog/` item, never the ephemeral origin.

Before step 8, grep the files you wrote for `docs/superpowers` — any hit is a bug, fix it first.

## Process

1. **Find the plan and spec.** Read the plan from `docs/superpowers/plans/` and spec from `docs/superpowers/specs/`. If multiple files exist, ask the user which to complete.

2. **Verify completion.** Check that all plan tasks are checked and tests are passing.

3. **Handle incomplete work.** If not complete, ask the user: proceed as `partial` (extract remaining work to `next/`/`backlog/`), or return to executing stage.

4. **Summarise.** Create a summary of the completed work:
   - **Keep:** goal, key design decisions (from spec), architecture choices, what was built, status
   - **Strip:** code samples, task checklists, implementation details
   - **Calibrate detail:** one-liner for straightforward work, short paragraph for significant changes
   - The summary deliberately preserves key design decisions from the spec so that the rationale for architectural choices survives beyond the ephemeral files.

5. **Determine status.** One of:
   - `complete` -- fully implemented as planned
   - `partial` -- some items implemented, remaining work extracted
   - `superseded` -- replaced by a different approach
   - `cancelled` -- work was not done, plan is no longer relevant

6. **Write the completed summary.** Save to `docs/agents/plans/completed/YYYY-MM-DD-feature-name.<status>.md` using the date from today and the feature name from the plan filename.

7. **Extract follow-on work.** If there is remaining or follow-on work:
   - High-priority items go to `docs/agents/plans/next/`
   - Low-priority items go to `docs/agents/plans/backlog/`
   - These are persistent: self-contained, no `docs/superpowers/` references (see CRITICAL above).

8. **Clean up ephemeral files.** First `grep -rn "docs/superpowers" docs/agents/plans/` for the files you just wrote — any hit is a dangling reference, fix it before deleting. Then delete the plan from `docs/superpowers/plans/` and the spec from `docs/superpowers/specs/`.

9. **Commit.** Stage all changes and commit with message: `docs: complete plan for <feature>`
