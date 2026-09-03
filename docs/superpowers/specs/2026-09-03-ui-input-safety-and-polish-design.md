# `@tejika/ui` input safety and polish — design

**Date:** 2026-09-03
**Branch:** `fix/ui-input-safety`
**Origin:** repo audit 2026-07-02 (finding H8 + all `@tejika/ui` mediums/lows);
`docs/agents/plans/next/2026-07-06-ui-input-safety-and-polish.md`.
**Classification:** architectural (kit-wide public-API changes with consumers in
sibling repos).

## Problem

`@tejika/ui` is the shared Ink component kit. Its interactive cards register
`useInput` unconditionally, and Ink input handlers are global: every keypress is
delivered to every mounted handler. A `ConfirmCard` mounted alongside a
`SelectCard` (or a second `ConfirmCard`) therefore fires multiple callbacks for a
single `y`/`enter`/`esc` — the high-severity finding H8. The package also has no
interaction tests (only render-only snapshots), so the exact bug surface is
uncovered. A cluster of medium and low findings rides along: double-fire on
repeated keys, discarded `onConfirm` promise rejections, raw-mode kept for
purely presentational cards, an inconsistent/over-loose color API, and several
rendering and export-hygiene nits.

## Goals

- Fix H8: interactive cards respond to keys only when they are the active card.
- Add interaction tests that exercise the real key paths and prove the isolation.
- Land the medium and low findings in the same pass (full scope, per the
  planning decision).
- Keep sibling-repo consumers (kubun, mokei) working without edits.

## Non-goals

- No changes to `packages/ui` consumers in other repos. All consumer imports are
  named, all colors passed are named Ink colors, and the generic added here
  defaults to `string`, so no consumer edit is required.
- No new components; no restructuring of the kit's module layout.

## Consumer blast radius (verified)

`@tejika/ui` is imported by `kubun/packages/cli` and `mokei/packages/cli`. Every
import is named (`import { ConfirmCard, ... } from '@tejika/ui'`) — no default
imports exist — so dropping default exports is safe. Consumers pass named colors
(`'blue'`, `'yellow'`, …) so narrowing `color` types to Ink's `TextProps['color']`
is safe. `SelectItem` is used as a type in `ModelSelectCard`/`ProviderSelectCard`
with string values, so making it generic with `T = string` is additive.

## Design

### ConfirmCard

- Add `isActive?: boolean` (default `true`), forwarded as
  `useInput(handler, { isActive })`. Inactive cards receive no keys.
- Fire-once latch via `useRef(false)`. Both `onConfirm` and `onCancel` fire at
  most once for the life of the card, guarding non-idempotent actions against a
  double `y`/`enter` before unmount.
- Callback type symmetry: both `onConfirm` and `onCancel` are
  `() => void | Promise<void>`. Each invocation is wrapped as
  `void Promise.resolve(cb()).catch(() => {})` so a rejected promise never
  becomes an unhandled rejection. The callback owns its own error policy; this is
  documented in the prop JSDoc.
- Color overrides: `color?: TextProps['color']` (message, default `'yellow'`) and
  `borderColor?: TextProps['color']` (default `'yellow'`).
- Render the hint line with `KeyHints` instead of a hand-rolled `<Text>`.

### SelectCard

- Make the item type generic: `SelectItem<T = string> = { label: string; value: T }`
  and `SelectCardProps<T>` with `onSelect: (value: T) => void`. `@inkjs/ui`'s
  `Select` is string-valued, so the component maps each item to a stable string
  key (its index) for `Select`, and maps the selected key back to the original
  `T` before calling `onSelect`. `T = string` keeps existing call sites unchanged.
- Add `isActive?: boolean` (default `true`). Register input only when active and
  cancelable: `useInput(handler, { isActive: isActive && onCancel != null })`.
  A presentational `SelectCard` with no `onCancel` no longer holds stdin in raw
  mode.
- Color overrides: `titleColor?: TextProps['color']` (default `'cyan'`) and
  `borderColor?: TextProps['color']` (default `'cyan'`).

### IconLine

- Narrow `color?` to `TextProps['color']`.
- JSDoc clarifies `children` is text content rendered inside `<Text>`; a `<Box>`
  child is unsupported (Ink crashes). Documented rather than silently handled.

### KeyHints

- Render each hint as its own `<Text dimColor>` inside a wrapping `<Box>` so line
  wrapping breaks between hints, never mid-hint, at narrow widths.

### StatusLine

- Insert a separator space between the busy spinner and the label so they are not
  flush.
- Narrow `color?` to `TextProps['color']`.

### SystemNotice

- Replace the info icon `ℹ` (ambiguous East-Asian width, misaligns `IconLine`'s
  `width={2}` column) with `i`.
- Type the `COLOR` map values as `TextProps['color']`.

### Footer

- Add `borderColor?: TextProps['color']` override (default `'gray'`).

### Exports

- Drop every `export default` across `src/*`. `index.ts` re-exports named symbols
  only; consumers use named imports. This removes the named+default drift.

## Testing

Interaction tests use `ink-testing-library`'s `stdin.write` (already a
dependency). New and expanded coverage in `test/components.test.tsx`:

- **ConfirmCard:** `y`, `enter`, `n`, and `esc` each fire the correct callback;
  a double `y` fires `onConfirm` exactly once (latch); `isActive={false}`
  produces no callback for any key; a rejecting `onConfirm` promise does not
  surface as an unhandled rejection.
- **SelectCard:** arrow-down + `enter` selects the expected value; `esc` cancels
  when `onCancel` is provided and is a no-op otherwise; a non-string generic
  value is passed through to `onSelect` unchanged.
- **Isolation (H8):** two cards mounted together — only the one with
  `isActive` responds to a keypress; the inactive one's callbacks never fire.

Existing render-only snapshots stay. `pnpm test` and `pnpm lint` must be green.

## Acceptance

- Two cards mounted together: only the `isActive` one responds to keys.
- ConfirmCard fires `onConfirm`/`onCancel` at most once; a rejecting
  `onConfirm` promise does not become an unhandled rejection.
- Interaction tests via `stdin.write` cover ConfirmCard `y`/`enter`/`n`/`esc`
  and SelectCard arrows/enter/esc.
- No default exports remain in `packages/ui/src`.
- `SelectItem`/`SelectCard` are generic with `T = string` default; existing
  string call sites compile unchanged.
- `pnpm test` and `pnpm lint` green.
