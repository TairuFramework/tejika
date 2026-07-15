# Upstream: opt-in `maxHoldTime` on `@sozai/lock`'s `FileLockOptions`

**Priority:** backlog (rare failure, documented, not a blocker)
**Repo:** `@sozai/lock` (sibling repo — not tejika). Consumed by `@tejika/process`.
**Origin:** follow-up from the sozai-lock daemon locking migration — see
`docs/agents/plans/completed/2026-07-15-sozai-lock-migration.complete.md`.

## The residual failure this closes

After the migration, `@tejika/process` has one accepted wedge: a booter SIGKILLed
mid-critical-section whose pid is *then reused by a live process* reads as `'alive'`
forever, so the lock is never classified stale. Nothing unwedges it short of a reboot or an
`rm` of the lockfile. The old `bootGraceMs` unwedged it after ten seconds — but that grace
was itself a bug on the boot path (it could steal the socket from a live-but-slow booter),
which is why the migration deleted it.

The wedge is accepted because it requires a SIGKILL **and** a same-boot pid collision, and
its consequence is a *wedged boot* (loud, fixed by deleting one file) rather than a *split
brain* (silent, corrupts data). Sozai chose the availability failure over the exclusion
failure deliberately.

## Why a hold bound is normally wrong — and why it is safe here

`@sozai/lock`'s `liveness.ts` warns: *"Do not add a `maxHoldTime` to 'fix' the wedge — it
trades the safe failure for the unsafe one."* For sozai's general case that is right: a
critical section can legitimately block for minutes on an OS keychain prompt, so a hold
bound would hand a second process the same section — a split brain.

Tejika's boot critical section is roughly 100ms. For a caller that can *prove* its section
is short, a hold bound is safe and closes the wedge.

## The proposal

Add an opt-in `maxHoldTime` to `FileLockOptions`, **off by default**, with the safety
argument stated at the call site: only a caller that can bound its own section may set it.
Tejika's boot would opt in; sozai's default behaviour is unchanged.

## Why not now

Taking a dependency on unreleased upstream work to fix a wedge this rare is a bad trade. Do
it as a standalone sozai change, then let tejika opt in on its next release.
