# Fix `@tejika/ui` global key-handler collisions and add interaction tests

**Priority:** next (finding H8 is high severity; rest of the package rides along)
**Origin:** repo audit 2026-07-02 (finding H8 + all `@tejika/ui` mediums/lows).
**Where:** `packages/ui/src/ConfirmCard.tsx`, `packages/ui/src/SelectCard.tsx`, other `packages/ui/src/*`, `packages/ui/test/components.test.tsx`.

## High severity

### H8 — Global key-handler collisions + zero interaction tests

- `packages/ui/src/ConfirmCard.tsx:11-19` — `useInput` is registered
  unconditionally with no `isActive` escape hatch. Ink input handlers are
  global: a `ConfirmCard` mounted alongside a `SelectCard` (or another
  `ConfirmCard`) receives every keypress, so one `y`/`enter`/`esc` fires
  multiple callbacks. Add `isActive?: boolean` forwarded as
  `useInput(handler, { isActive })` (same for `SelectCard`).
- `packages/ui/test/components.test.tsx` — render-only snapshots; no coverage
  of ConfirmCard `y`/`enter`/`n`/`esc` or SelectCard esc/arrow+enter — exactly
  the bug surface. Use ink-testing-library's `stdin.write`.

## Medium severity

- `src/ConfirmCard.tsx:17` — no guard against repeated firing: pressing `y`
  twice before unmount calls `onConfirm()` twice (bad for non-idempotent
  actions). Latch with a ref.
- `src/ConfirmCard.tsx:5,17` — `onConfirm: () => void | Promise<void>` but the
  promise is discarded — rejections become unhandled; `onCancel` is plain
  `() => void`, inconsistent. Narrow the type or handle the promise.
- `src/SelectCard.tsx:17-19` — `useInput` registered even when `onCancel` is
  undefined; keeps stdin in raw mode for a purely presentational use.
  `useInput(handler, { isActive: onCancel != null })`.
- Inconsistent color API: `StatusLine`/`IconLine` take free-form
  `color?: string` while `SystemNotice` takes `variant`; ConfirmCard/
  SelectCard/Footer hardcode border colors with no override. Pick one
  convention; type colors as Ink's `TextProps['color']`.

## Low severity

- `SelectCard` empty-items state with no `onCancel` is a dead end.
- `SelectItem.value` is `string`-only (consider a generic).
- Dual named+default exports invite import drift (drop defaults).
- `ℹ` is ambiguous-width (can misalign `IconLine`'s `width={2}` column — use
  `i`/`•`).
- `KeyHints` joins all hints into one `Text` (wraps mid-hint at narrow widths).
- `IconLine` accepts `ReactNode` children but renders inside `<Text>` (a
  `<Box>` child crashes).
- StatusLine busy spinner renders flush against the label (missing separator).
- ConfirmCard hand-rolls its hint line instead of using `KeyHints`.

## Acceptance

- Two cards mounted together: only the `isActive` one responds to keys.
- ConfirmCard fires `onConfirm`/`onCancel` at most once; a rejecting
  `onConfirm` promise does not become an unhandled rejection.
- Interaction tests via `stdin.write` cover ConfirmCard `y`/`enter`/`n`/`esc`
  and SelectCard arrows/enter/esc.
- `pnpm test` and `pnpm lint` green.
