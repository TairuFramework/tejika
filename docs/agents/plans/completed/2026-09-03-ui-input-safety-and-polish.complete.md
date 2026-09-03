# @tejika/ui input safety and polish — complete

**Status:** complete
**Date:** 2026-09-03
**Origin:** repo audit 2026-07-02 (finding H8 + all `@tejika/ui` mediums/lows).
**Branch:** `fix/ui-input-safety`.

## Goal

Fix `@tejika/ui`'s global key-handler collisions (audit finding H8, high
severity) and land the associated medium/low findings, with interaction tests
proving the isolation. `@tejika/ui` is the shared Ink component kit consumed by
sibling repos (mokei, kubun).

## The problem (H8)

Ink `useInput` handlers are global: every keypress is delivered to every mounted
handler. The interactive cards (`ConfirmCard`, `SelectCard`) registered
`useInput` unconditionally, so a `ConfirmCard` mounted alongside a `SelectCard`
(or a second card) fired multiple callbacks for a single `y`/`enter`/`esc`. The
package also had no interaction tests — only render-and-assert coverage — so the
exact bug surface was untested.

## Key design decisions

- **`isActive` is a mechanism, not a policy.** Cards gained an `isActive?:
  boolean` prop (default `true`). The kit provides the gate; it cannot itself
  decide which of several mounted cards is active. A lone card is safe by
  default; a consumer mounting concurrent cards owns the "exactly one active"
  invariant. Current consumers (mokei `ChatApp`, kubun) mount interactive cards
  through mutually-exclusive conditionals, so at most one is mounted at a time —
  no consumer edit was required, and default-`true` keeps them working.
- **Gate both input paths in `SelectCard`.** The card owns one `useInput` (its
  cancel handler), but the nested `@inkjs/ui` `Select` owns a *separate*
  `useInput` (registered as `isActive: !isDisabled`). Gating only the outer
  handler is insufficient — an inactive card would still process arrows/Enter and
  hold stdin in raw mode. The fix passes `isDisabled={!isActive}` to `Select` in
  addition to gating the outer handler with `{ isActive: isActive && onCancel !=
  null }`. This was the substantive part of the H8 fix for `SelectCard`, and the
  one gap an early design pass missed (caught in review against the installed
  library internals).
- **Fire-once latch, mount-scoped and shared.** `ConfirmCard` uses a single
  `useRef` latch so `onConfirm`/`onCancel` fire at most once per mount and share
  one latch (a `y` then `esc` fires only `onConfirm`). The latch is set before
  invoking the callback, closing the same-tick double-fire window. Contract:
  "once per mount" — consumers present a fresh card (conditional mount or changed
  `key`) per prompt; the latch is deliberately not reset on prop/`isActive`
  changes.
- **Callback errors are a crash-safety net, not error reporting.** Both callbacks
  are `() => void | Promise<void>`, invoked through a helper that wraps the
  synchronous call in `try`/`catch` and attaches `.catch()` to a returned
  promise. This prevents a synchronous throw from escaping Ink's input handler
  and a rejected promise from becoming an unhandled rejection. Swallowing is the
  deliberate, documented policy — the callback owns user-facing error reporting
  (as mokei's `onConfirm` already does).
- **Generic `SelectCard` via positional encoding.** `SelectItem<T = string>` and
  `SelectCardProps<T = string>` (both defaults present so each is usable when
  re-exported). Because `@inkjs/ui`'s `Select` is string-valued and keys options
  by value, items are mapped to `{ label, value: String(index) }` and the
  original `T` recovered via `items[Number(value)]` on change — positional
  strings are unique regardless of duplicate `T` values or labels. Selection is
  position-keyed for the mount; changing the list length or an item label
  remaps, but reordering identically-labelled items may not reset (the library
  resets only on deeply-unequal mapped options), so callers needing selection to
  survive list changes remount with a stable `key`.
- **Color typing without false narrowing.** Free-form color props are typed as
  Ink's `TextProps['color']`. That type is `LiteralUnion<…, string>`, so it adds
  editor completion and one convention across the kit but does **not** reject
  arbitrary strings — the docs state exactly that and claim no more.

## What was built

- **`ConfirmCard`:** `isActive` gate, mount-scoped shared fire-once latch,
  crash-safety net, `color`/`borderColor` overrides, hint line via `KeyHints`.
- **`SelectCard`:** generic value type, positional value-mapping, gate on both
  the outer handler and the nested `Select` (`isDisabled`), `titleColor`/
  `borderColor` overrides, empty-items+no-`onCancel` documented as an intentional
  terminal presentational state.
- **Presentational polish:** `KeyHints` wraps between hints (`flexWrap` +
  per-hint text with `columnGap`), `StatusLine` separates the busy spinner from
  its label, `SystemNotice` info icon `ℹ`→`i` (ambiguous-width fix), `IconLine`
  color typing + children-are-text JSDoc, `Footer` `borderColor` override.
- **Exports:** every `export default` dropped; `index.ts` re-exports named
  symbols only (all consumers already used named imports).
- **Tests:** interaction coverage via `ink-testing-library`'s `stdin.write` —
  ConfirmCard `y`/`enter`/`n`/`esc`, the shared latch (`y`-then-`esc`),
  `isActive={false}` silence for all four keys, both callbacks' rejection and
  synchronous throw; SelectCard arrow+enter/esc, generic-value round-trip,
  esc-no-op when `onCancel` absent, nested-gate; and H8 isolation with two cards
  mounted, in both activation directions. Esc paths use fake timers to flush
  Ink's ~20ms escape buffer; a top-level `afterEach` restores real timers and
  rejection-listener tests use `try`/`finally`.

## Verification

31/31 tests green, `tsc` clean, biome clean, all acceptance criteria met.
Reviewed by a whole-branch review (ready to merge) and an independent codex
review (no merge blockers; production code found defect-free, with only
test-completeness and one JSDoc-precision nit, since fixed).

## Consumer impact

None. All consumer imports are named (dropping defaults is safe), consumers pass
named colors (the color-type change is safe), and the generic defaults to
`string` (existing string call sites compile unchanged). No sibling repo was
edited.
