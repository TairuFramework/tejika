# `@tejika/log`: test the reserved-name boundary for `console` file targets

**Priority:** backlog
**Origin:** deferred test-coverage item from
`docs/agents/plans/completed/2026-08-08-log-dir-and-file-sink.complete.md`.

## Gap

`createFileLogConfig` reserves the sink name `console` for its optional console sink. One boundary
of that rule is untested: a file target *named* `console` while the `console` option is **off**
should be allowed (no console sink exists to collide with), but nothing exercises this branch today.

## Scope

- Add a `@tejika/log` test: build a config with a file target named `console` and `console: false`,
  assert it configures without error and routes that target to its file sink.
- Confirm the complementary case stays guarded: the same file-target name with `console: true`
  should still be rejected as a collision.

## Notes

- Test-only; no production change expected unless the reserved-name check turns out to reject the
  allowed case, in which case fix the guard to key on whether the console sink is actually present.
