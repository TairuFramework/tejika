# `runInk`: exit-code mapping and a non-TTY guard

**Priority:** backlog
**Origin:** deferred from the 2026-07-13 port-and-CLI-option-validation spec
(audit 2026-07-02, `@tejika/cli` low-severity items).
**Where:** `packages/cli/src/ink.ts`.

`runInk` has no error-to-exit-code mapping: an Ink app that throws resolves the
same way one that quits cleanly does, so a CLI built on it always exits 0. It also
has no guard for a non-TTY stdin — Ink's raw mode needs one, and the failure mode
when piped or run under CI is a confusing crash rather than a clear message.

Both are policy calls about who owns `process.exit` in a library that apps embed,
which is why they were cut from the validation spec rather than guessed at:

- Should `runInk` rethrow, or set `process.exitCode` and resolve?
- Should a non-TTY invocation throw, fall back to `renderStatic`, or render with
  raw mode disabled?

Decide with a real consumer (mokei, sakui) in hand.
