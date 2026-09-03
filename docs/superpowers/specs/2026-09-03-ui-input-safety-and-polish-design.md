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
interaction tests — existing tests only render a card and assert substrings
(`toContain`), never sending keys — so the exact bug surface is uncovered. A
cluster of medium and low findings rides along: double-fire on
repeated keys, discarded `onConfirm` promise rejections, raw-mode kept for
purely presentational cards, an inconsistent/over-loose color API, and several
rendering and export-hygiene nits.

## Goals

- Give interactive cards an activation gate so a card responds to keys only when
  it is the active card — covering **both** the card's own `useInput` and the
  nested `@inkjs/ui` `Select`'s internal `useInput`.
- Add interaction tests that exercise the real key paths and prove the isolation
  in both activation directions.
- Land the medium and low findings in the same pass (full scope, per the
  planning decision).
- Keep sibling-repo consumers (kubun, mokei) working without edits.

### What "fixing H8" means (scope)

`isActive` is a *mechanism*, not a *policy*. The kit provides the gate; it cannot
itself decide which of several mounted cards is active. Concretely:

- **Single active card (the default case).** With `isActive` defaulting to
  `true`, a lone card works unchanged and is safe — there is no other handler to
  collide with.
- **Concurrent cards.** A consumer that mounts two interactive cards at once must
  drive `isActive` so exactly one is `true`. Owning that invariant is the
  consumer's responsibility; the kit exposes the prop to make it possible.
- **Current consumers are already safe.** mokei's `ChatApp` mounts its cards
  through mutually-exclusive conditionals (`modal === 'model'`,
  `confirmRemove != null`, …), so at most one interactive card is mounted at a
  time; kubun likewise. No consumer edit is required, and default-`true` keeps
  them working. Should a consumer later mount cards concurrently, gating them is
  a follow-up in that repo, not this one.

## Non-goals

- No changes to `packages/ui` consumers in other repos. All consumer imports are
  named, all colors passed are named Ink colors, and the generic added here
  defaults to `string`, so no consumer edit is required.
- No new components; no restructuring of the kit's module layout.

## Consumer blast radius (verified)

`@tejika/ui` is imported by `kubun/packages/cli` and `mokei/packages/cli`. Every
import is named (`import { ConfirmCard, ... } from '@tejika/ui'`) — no default
imports exist — so dropping default exports is safe. Consumers pass named colors
(`'blue'`, `'yellow'`, …) so aligning `color` types with Ink's `TextProps['color']`
is safe. `SelectItem` is used as a type only in `ProviderSelectCard`
(`const PROVIDERS: Array<SelectItem>`) with string values — `ModelSelectCard` does
not import it — so making it generic with `T = string` is additive. `ChatApp`
uses mokei's own `ModelSelectCard`/`ToolSelectCard` wrappers plus `ConfirmCard`;
`onConfirm` there is already an `async` function with its own `try`/`catch`, which
sets the callback-error expectation this design follows.

## Design

### ConfirmCard

- Add `isActive?: boolean` (default `true`), forwarded as
  `useInput(handler, { isActive })`. Inactive cards receive no keys.
- **Fire-once latch, mount-scoped.** A `useRef(false)` latch makes `onConfirm`
  and `onCancel` fire at most once **per mount** (the two share one latch, so
  `y` then `esc` fires only `onConfirm`). "Once per mount" is the explicit
  contract: a `ConfirmCard` represents a single confirmation, and consumers
  present a fresh card (a new React element — conditional mount, or a changed
  `key`) for each new prompt. The latch is deliberately **not** reset on prop or
  `isActive` changes; reuse across prompts is out of scope and documented as such
  in the prop JSDoc.
- **Callback invocation and errors.** Both `onConfirm` and `onCancel` are
  `() => void | Promise<void>`. Each is invoked inside a helper that (a) wraps the
  synchronous call in `try`/`catch` so a synchronous throw cannot escape Ink's
  input handler, and (b) attaches `.catch(() => {})` to a returned promise so a
  rejection cannot become an unhandled rejection. This is a **crash-safety net**,
  not an error-reporting policy: a callback that needs to surface failures must do
  so itself (as mokei's `ConfirmCard` `onConfirm` already does with an internal
  `try`/`catch`). The prop JSDoc states this explicitly — the net exists so a
  careless callback cannot crash the render, and callers own user-facing error
  reporting.
- Color overrides: `color?: TextProps['color']` (message, default `'yellow'`) and
  `borderColor?: TextProps['color']` (default `'yellow'`). See
  [Color typing](#color-typing) for what this type does and does not guarantee.
- Render the hint line with `KeyHints` instead of a hand-rolled `<Text>`.

### SelectCard

- Make the item type generic. **Both** the item type and the props type carry the
  `= string` default so each is directly usable when re-exported:
  `SelectItem<T = string> = { label: string; value: T }` and
  `SelectCardProps<T = string>` with `onSelect: (value: T) => void`.
- **Value mapping.** `@inkjs/ui`'s `Select` is string-valued and keys its options
  by `option.value`, so the component maps each item to its **positional index**
  as the `Select` option value (`String(i)`), keeping a parallel lookup back to
  the original `T`. On change it parses the index and calls
  `onSelect(items[i].value)`. Positional strings are unique regardless of
  duplicate `T` values or duplicate labels. **Item-identity constraint:** the
  index identifies an item only by position, so `items` is treated as a stable
  list for the card's mount. If `items` changes (insert/remove/reorder),
  selection resets — this matches `@inkjs/ui`'s own behavior (it resets select
  state when the mapped options change) and is documented in the prop JSDoc.
  Callers needing selection to survive list changes remount with a stable `key`.
- **Activation gates both handlers.** Add `isActive?: boolean` (default `true`).
  The card gates its own cancel handler *and* the nested `Select`:
  - Cancel handler: `useInput(handler, { isActive: isActive && onCancel != null })`
    — a presentational `SelectCard` with no `onCancel` never holds stdin in raw
    mode, and an inactive card never cancels.
  - Nested list: pass `isDisabled={!isActive}` to `@inkjs/ui`'s `Select`. `Select`
    registers its own `useInput` with `isActive: !isDisabled`, so without this an
    inactive card would still process arrows/Enter, fire `onSelect`, and hold raw
    mode. This is the substantive part of the H8 fix for `SelectCard`.
- Color overrides: `titleColor?: TextProps['color']` (default `'cyan'`) and
  `borderColor?: TextProps['color']` (default `'cyan'`). See
  [Color typing](#color-typing).
- **Empty items with no `onCancel`.** This is an intentionally terminal
  presentational state: the card shows `emptyMessage` and has no card-level
  interaction, and the caller controls unmounting it (e.g. a timeout or a state
  change). Documented in the prop JSDoc so it is a deliberate contract, not an
  oversight. When `onCancel` *is* provided, `esc` cancels as usual.

### Color typing

Every free-form `color?`/`borderColor?`/`titleColor?` prop is typed as Ink's
`TextProps['color']`. Note what this does **not** do: Ink defines that type as
`LiteralUnion<ForegroundColorName, string>`, which retains the full `string` base
type, so arbitrary strings are still accepted at compile time. The benefit is
editor autocompletion of the named colors and alignment with Ink's own signature
(one convention across the kit), **not** rejection of invalid color strings. The
spec claims only that; it does not claim the API is narrowed. `SystemNotice` keeps
its semantic `variant` prop (it maps intent to a fixed color); only its internal
`COLOR` map values are typed as `TextProps['color']`.

### IconLine

- Type `color?` as `TextProps['color']` (see [Color typing](#color-typing)).
- JSDoc clarifies `children` is text content rendered inside `<Text>`; a `<Box>`
  child is unsupported (Ink crashes). Documented rather than silently handled.

### KeyHints

- Render each hint as its own `<Text dimColor>` child inside a `<Box flexWrap="wrap">`,
  with the two-space gap between hints carried by the layout (a `marginRight` on
  each hint, or a spacer), not baked into a single joined string. This lets Ink
  wrap **between** hints. The guarantee is scoped honestly: wrapping breaks at hint
  boundaries whenever width allows; an individual hint wider than the available
  width still wraps internally (Ink's `<Text>` wraps its own content) — that case
  is unchanged and not something this design can prevent.

### StatusLine

- Insert a separator space between the busy spinner and the label so they are not
  flush.
- Type `color?` as `TextProps['color']` (see [Color typing](#color-typing)).

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
dependency). **Escape timing:** Ink buffers a lone `esc` for ~20 ms before
delivering it (to disambiguate escape sequences), so every test that sends `esc`
uses fake timers (`vi.useFakeTimers()` and advance past the flush) — the existing
mokei `ProviderSelectCard` test does the same. New and expanded coverage in
`test/components.test.tsx`:

- **ConfirmCard:** `y`, `enter`, `n`, and `esc` each fire the correct callback;
  `isActive={false}` produces no callback for any key.
- **ConfirmCard latch (one shared latch):** `y` then `y` fires `onConfirm`
  exactly once; **`y` then `esc` fires `onConfirm` once and `onCancel` never**
  (proves both callbacks share one latch, not one latch each).
- **ConfirmCard errors:** a rejecting `onConfirm` **and** a rejecting `onCancel`
  each leave no unhandled rejection; a synchronous throw from either callback does
  not escape the input handler (the render survives).
- **SelectCard:** arrow-down + `enter` selects the expected value; `esc` cancels
  when `onCancel` is provided and is a no-op when it is absent; a non-string
  generic value (e.g. a number) is passed through to `onSelect` unchanged.
- **SelectCard nested-gate:** an `isActive={false}` `SelectCard` does not fire
  `onSelect` on arrow+`enter` (proves `isDisabled` reaches the inner `Select`,
  not just the outer cancel handler).
- **Isolation (H8), both directions:** (a) active `ConfirmCard` + inactive
  `SelectCard` — `enter` fires only the ConfirmCard; (b) active `SelectCard` +
  inactive `ConfirmCard` — `enter` selects only in the SelectCard. Each direction
  asserts the inactive card's callbacks never fire.

Existing render-and-assert tests stay. `pnpm test` and `pnpm lint` must be green.

## Acceptance

- Two cards mounted together: only the `isActive` one responds to keys, proven in
  **both** activation directions (active ConfirmCard + inactive SelectCard, and
  the inverse).
- An inactive `SelectCard` fires no `onSelect` on arrow+`enter` (the nested
  `Select` is gated via `isDisabled`, not only the outer cancel handler).
- ConfirmCard fires `onConfirm`/`onCancel` at most once per mount, sharing a
  single latch (`y`-then-`esc` fires only `onConfirm`); a rejecting `onConfirm`
  **or** `onCancel` promise does not become an unhandled rejection, and a
  synchronous throw from either does not escape the input handler.
- Interaction tests via `stdin.write` cover ConfirmCard `y`/`enter`/`n`/`esc`
  and SelectCard arrows/enter/esc, with fake timers for every `esc` path.
- No `export default` remains in `packages/ui/src`.
- Both `SelectItem<T = string>` and `SelectCardProps<T = string>` carry the
  default; existing string call sites compile unchanged, and a non-string `T`
  round-trips through `onSelect`.
- `pnpm test` and `pnpm lint` green.
