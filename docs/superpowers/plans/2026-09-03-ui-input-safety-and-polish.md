# `@tejika/ui` Input Safety and Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks

**Goal:** Fix `@tejika/ui`'s global key-handler collisions (finding H8) and land the associated medium/low findings, with interaction tests that prove the isolation.

**Architecture:** Add an `isActive` gate to both interactive cards — for `SelectCard` the gate must cover the nested `@inkjs/ui` `Select` (via `isDisabled`), not only the card's own `useInput`. Add a mount-scoped fire-once latch and a crash-safety net to `ConfirmCard`. Make `SelectCard` generic over its value type. Apply presentational polish and drop default exports. Cover it all with `stdin.write`-driven interaction tests.

**Tech Stack:** TypeScript, React, Ink, `@inkjs/ui`, Vitest, `ink-testing-library`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-03-ui-input-safety-and-polish-design.md`

## Global Constraints

Copied from the spec and AGENTS.md; every task's requirements include these:

- **Types, not interfaces.** Use `type`, never `interface`. Use `Array<T>`, never `T[]`. No `any` — use `unknown` or a specific type.
- **ES private fields** (`#field`) + getters, never TS `private`/`readonly`. (No classes appear in this plan, but the rule stands.)
- **Names:** `ID` not `Id`, `HTTP` not `Http`. No lowercase abbreviations.
- **`isActive` is a mechanism, not a policy.** It defaults to `true`. The kit only provides the gate; single-card use is safe by default and concurrent-card consumers own the "exactly one active" invariant. No consumer repo is edited in this plan.
- **Callback errors are a crash-safety net, not error reporting.** A thrown error or rejected promise from a `ConfirmCard` callback is swallowed only so it cannot crash the render; the callback owns user-facing error reporting.
- **Color props** are typed as Ink's `TextProps['color']`. This adds editor completion and one convention across the kit; it does **not** narrow (`TextProps['color']` is `LiteralUnion<…, string>`, so arbitrary strings still compile). Do not claim otherwise in JSDoc.
- **Do not use `pnpm run <script>` directly** on this machine (an `rtk` shim may redirect it). Invoke tools directly: `pnpm exec vitest …`, `pnpm exec biome …`, `pnpm exec tsc …`. Lint the repo with `rtk lint biome` (Biome, not eslint).
- **Do not edit generated files** (`lib/`).

### Commands (exact)

Run from `packages/ui/` unless noted:

- Single test file: `pnpm exec vitest run test/components.test.tsx`
- Single test by name: `pnpm exec vitest run test/components.test.tsx -t 'name fragment'`
- Type-check tests: `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
- Full package test (types + unit): `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run`
- Lint/format (from repo root): `rtk lint biome`

### Ink key-write reference (for `ink-testing-library` `stdin.write`)

- Enter / return: `'\r'` — **wrap in `act(() => stdin.write('\r'))`** so `@inkjs/ui` `Select`'s `onChange` `useEffect` flushes.
- Down arrow: `'\x1b[B'`; up arrow: `'\x1b[A'` (full escape sequences, delivered immediately — no timer needed).
- Escape: `'\x1b'` — a **lone** esc is buffered ~20 ms by Ink, so esc tests must use `vi.useFakeTimers()` and `vi.runAllTimers()` after the write.
- Letters: `'y'`, `'n'` (delivered immediately).

Imports for tests: `import { render } from 'ink-testing-library'`, `import { act } from 'react'`, and from `vitest` `describe, expect, test, vi, beforeEach, afterEach`.

---

## File Structure

- `packages/ui/src/ConfirmCard.tsx` — add `isActive`, latch, crash-safety net, color/borderColor overrides, `KeyHints` hint line, drop default export. (Task 1)
- `packages/ui/src/SelectCard.tsx` — generic `SelectItem<T>`/`SelectCardProps<T>`, index value-mapping, gate outer handler + inner `Select` `isDisabled`, titleColor/borderColor, drop default export. (Task 2)
- `packages/ui/src/IconLine.tsx`, `KeyHints.tsx`, `StatusLine.tsx`, `SystemNotice.tsx`, `Footer.tsx` — presentational polish + color typing, drop default exports. (Task 4)
- `packages/ui/src/Spinner.tsx`, `index.ts` — Spinner: drop default export (index unchanged, already named). (Task 5)
- `packages/ui/test/components.test.tsx` — interaction coverage for ConfirmCard, SelectCard, isolation, and polish. (Tasks 1–4)

---

## Task 1: ConfirmCard — activation gate, shared latch, crash-safety net, color overrides, KeyHints

**Files:**
- Modify: `packages/ui/src/ConfirmCard.tsx`
- Test: `packages/ui/test/components.test.tsx`

**Interfaces:**
- Consumes: `KeyHints` from `./KeyHints.js` (`{ hints: Array<{ keys: string; label: string }> }`), unchanged in this task.
- Produces:
  ```ts
  export type ConfirmCardProps = {
    message: string
    onConfirm: () => void | Promise<void>
    onCancel: () => void | Promise<void>
    isActive?: boolean          // default true
    color?: TextProps['color']  // message color, default 'yellow'
    borderColor?: TextProps['color'] // default 'yellow'
  }
  export function ConfirmCard(props: ConfirmCardProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe('ConfirmCard', …)` block in `packages/ui/test/components.test.tsx` with:

```tsx
describe('ConfirmCard', () => {
  test('renders the confirmation message', () => {
    const { lastFrame } = render(
      <ConfirmCard message="proceed?" onConfirm={noop} onCancel={noop} />,
    )
    expect(lastFrame()).toContain('proceed?')
  })

  test('y confirms', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={onConfirm} onCancel={onCancel} />)
    act(() => stdin.write('y'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  test('enter confirms', () => {
    const onConfirm = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={onConfirm} onCancel={vi.fn()} />)
    act(() => stdin.write('\r'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('n cancels', () => {
    const onCancel = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={vi.fn()} onCancel={onCancel} />)
    act(() => stdin.write('n'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('esc cancels', () => {
    vi.useFakeTimers()
    const onCancel = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={vi.fn()} onCancel={onCancel} />)
    stdin.write('\x1b')
    vi.runAllTimers()
    expect(onCancel).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('shared latch: y then y confirms once', () => {
    const onConfirm = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={onConfirm} onCancel={vi.fn()} />)
    act(() => stdin.write('y'))
    act(() => stdin.write('y'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('shared latch: y then esc confirms once, never cancels', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={onConfirm} onCancel={onCancel} />)
    act(() => stdin.write('y'))
    stdin.write('\x1b')
    vi.runAllTimers()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  test('isActive={false} ignores all keys', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(
      <ConfirmCard message="?" isActive={false} onConfirm={onConfirm} onCancel={onCancel} />,
    )
    act(() => stdin.write('y'))
    act(() => stdin.write('n'))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  test('a rejecting onConfirm does not raise an unhandled rejection', async () => {
    const onRejection = vi.fn()
    process.on('unhandledRejection', onRejection)
    const { stdin } = render(
      <ConfirmCard message="?" onConfirm={() => Promise.reject(new Error('boom'))} onCancel={vi.fn()} />,
    )
    act(() => stdin.write('y'))
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', onRejection)
    expect(onRejection).not.toHaveBeenCalled()
  })

  test('a synchronous throw from onCancel does not escape the handler', () => {
    const { stdin, lastFrame } = render(
      <ConfirmCard message="alive" onConfirm={vi.fn()} onCancel={() => { throw new Error('boom') }} />,
    )
    expect(() => act(() => stdin.write('n'))).not.toThrow()
    expect(lastFrame()).toContain('alive')
  })
})
```

Ensure the file's imports at the top include `act` from `react` and `vi` (plus existing `describe, expect, test`) from `vitest`, and `noop` is defined (`const noop = (): void => {}`). Add them if missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/components.test.tsx -t ConfirmCard`
Expected: FAIL — the latch/isActive/error tests fail against the current unconditional `useInput` with no latch.

- [ ] **Step 3: Rewrite `ConfirmCard.tsx`**

Replace the whole file with:

```tsx
import { Box, Text, type TextProps, useInput } from 'ink'
import { useRef } from 'react'

import { KeyHints } from './KeyHints.js'

export type ConfirmCardProps = {
  message: string
  /**
   * Fired at most once per mount. The callback owns its own user-facing error
   * reporting; a synchronous throw or a rejected promise is swallowed only as a
   * crash-safety net so it cannot break the render.
   */
  onConfirm: () => void | Promise<void>
  onCancel: () => void | Promise<void>
  /** When false, the card ignores all key input. Defaults to true. */
  isActive?: boolean
  /** Message text color. */
  color?: TextProps['color']
  /** Border color. */
  borderColor?: TextProps['color']
}

/** A yes/no confirmation card: y/enter confirms, n/esc cancels. */
export function ConfirmCard({
  message,
  onConfirm,
  onCancel,
  isActive = true,
  color = 'yellow',
  borderColor = 'yellow',
}: ConfirmCardProps) {
  const fired = useRef(false)
  const run = (callback: () => void | Promise<void>) => {
    if (fired.current) return
    fired.current = true
    try {
      const result = callback()
      if (result != null && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).catch(() => {})
      }
    } catch {
      // crash-safety net: the callback owns user-facing error reporting.
    }
  }

  useInput(
    (input, key) => {
      if (key.escape) {
        run(onCancel)
        return
      }
      const ch = input.toLowerCase()
      if (ch === 'y' || key.return) run(onConfirm)
      else if (ch === 'n') run(onCancel)
    },
    { isActive },
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor}>
      <Text color={color}>{message}</Text>
      <KeyHints
        hints={[
          { keys: 'y / enter', label: 'confirm' },
          { keys: 'n / esc', label: 'cancel' },
        ]}
      />
    </Box>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/components.test.tsx -t ConfirmCard`
Expected: PASS (all ConfirmCard cases).

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/ConfirmCard.tsx packages/ui/test/components.test.tsx
git commit -m "fix(ui): gate ConfirmCard input, add fire-once latch and crash-safety net"
```

---

## Task 2: SelectCard — generic value type, activation gate on card + nested Select

**Files:**
- Modify: `packages/ui/src/SelectCard.tsx`
- Modify: `packages/ui/src/index.ts` (only if the re-export line needs no change — verify; `SelectItem`/`SelectCardProps` names are unchanged, so it should not)
- Test: `packages/ui/test/components.test.tsx`

**Interfaces:**
- Consumes: `@inkjs/ui` `Select` — `options: Array<{ label: string; value: string }>`, `onChange: (value: string) => void`, `isDisabled?: boolean`.
- Produces:
  ```ts
  export type SelectItem<T = string> = { label: string; value: T }
  export type SelectCardProps<T = string> = {
    title?: string
    items: Array<SelectItem<T>>
    onSelect: (value: T) => void
    onCancel?: () => void
    emptyMessage?: string
    isActive?: boolean               // default true
    titleColor?: TextProps['color']  // default 'cyan'
    borderColor?: TextProps['color'] // default 'cyan'
  }
  export function SelectCard<T = string>(props: SelectCardProps<T>): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe('SelectCard', …)` block with:

```tsx
describe('SelectCard', () => {
  test('renders item labels', () => {
    const { lastFrame } = render(
      <SelectCard
        title="pick one"
        items={[
          { label: 'alpha', value: 'a' },
          { label: 'beta', value: 'b' },
        ]}
        onSelect={noop}
      />,
    )
    expect(lastFrame()).toContain('pick one')
    expect(lastFrame()).toContain('alpha')
  })

  test('renders the empty message when there are no items', () => {
    const { lastFrame } = render(
      <SelectCard items={[]} onSelect={noop} emptyMessage="nothing here" />,
    )
    expect(lastFrame()).toContain('nothing here')
  })

  test('enter selects the highlighted item', () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      <SelectCard
        items={[
          { label: 'alpha', value: 'a' },
          { label: 'beta', value: 'b' },
        ]}
        onSelect={onSelect}
      />,
    )
    act(() => stdin.write('\r'))
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  test('arrow-down then enter selects the second item', () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      <SelectCard
        items={[
          { label: 'alpha', value: 'a' },
          { label: 'beta', value: 'b' },
        ]}
        onSelect={onSelect}
      />,
    )
    act(() => stdin.write('\x1b[B'))
    act(() => stdin.write('\r'))
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  test('a non-string generic value round-trips through onSelect', () => {
    const onSelect = vi.fn<(value: number) => void>()
    const { stdin } = render(
      <SelectCard
        items={[
          { label: 'one', value: 1 },
          { label: 'two', value: 2 },
        ]}
        onSelect={onSelect}
      />,
    )
    act(() => stdin.write('\x1b[B'))
    act(() => stdin.write('\r'))
    expect(onSelect).toHaveBeenCalledWith(2)
  })

  test('esc cancels when onCancel is provided', () => {
    vi.useFakeTimers()
    const onCancel = vi.fn()
    const { stdin } = render(
      <SelectCard items={[{ label: 'a', value: 'a' }]} onSelect={noop} onCancel={onCancel} />,
    )
    stdin.write('\x1b')
    vi.runAllTimers()
    expect(onCancel).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('isActive={false} does not select on enter', () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      <SelectCard
        isActive={false}
        items={[{ label: 'a', value: 'a' }]}
        onSelect={onSelect}
      />,
    )
    act(() => stdin.write('\r'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/components.test.tsx -t SelectCard`
Expected: FAIL — the generic-number test fails to type/behave, and `isActive={false}` still selects because the nested `Select` is not gated.

- [ ] **Step 3: Rewrite `SelectCard.tsx`**

Replace the whole file with:

```tsx
import { Select } from '@inkjs/ui'
import { Box, Text, type TextProps, useInput } from 'ink'

export type SelectItem<T = string> = { label: string; value: T }

export type SelectCardProps<T = string> = {
  title?: string
  items: Array<SelectItem<T>>
  onSelect: (value: T) => void
  onCancel?: () => void
  /** Message shown when `items` is empty. */
  emptyMessage?: string
  /** When false, the card and its list ignore all key input. Defaults to true. */
  isActive?: boolean
  /** Title text color. */
  titleColor?: TextProps['color']
  /** Border color. */
  borderColor?: TextProps['color']
}

/**
 * A bordered single-choice list. Esc cancels (when `onCancel` is provided).
 *
 * `items` is treated as a stable list for the card's mount: selection is keyed
 * by position, so changing `items` (insert/remove/reorder) resets selection,
 * matching `@inkjs/ui`'s own behavior. An empty list with no `onCancel` is an
 * intentionally terminal presentational state; the caller controls unmounting.
 */
export function SelectCard<T = string>({
  title,
  items,
  onSelect,
  onCancel,
  emptyMessage,
  isActive = true,
  titleColor = 'cyan',
  borderColor = 'cyan',
}: SelectCardProps<T>) {
  useInput(
    (_input, key) => {
      if (key.escape) onCancel?.()
    },
    { isActive: isActive && onCancel != null },
  )

  const options = items.map((item, index) => ({ label: item.label, value: String(index) }))

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor}>
      {title != null ? <Text color={titleColor}>{title}</Text> : null}
      {items.length === 0 ? (
        <Text dimColor>{emptyMessage ?? 'no items'}</Text>
      ) : (
        <Select
          isDisabled={!isActive}
          options={options}
          onChange={(value) => onSelect(items[Number(value)].value)}
        />
      )}
      {onCancel != null ? <Text dimColor>[esc] cancel</Text> : null}
    </Box>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/components.test.tsx -t SelectCard`
Expected: PASS.

- [ ] **Step 5: Verify `index.ts` re-export is unchanged and type-checks**

The export line `export { SelectCard, type SelectCardProps, type SelectItem } from './SelectCard.js'` needs no change (names are the same). Confirm, then run:
`pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/SelectCard.tsx packages/ui/test/components.test.tsx
git commit -m "fix(ui): gate SelectCard and its nested Select; make item value generic"
```

---

## Task 3: Isolation test (H8) — two cards, both activation directions

**Files:**
- Test: `packages/ui/test/components.test.tsx`

**Interfaces:**
- Consumes: `ConfirmCard` (Task 1) and `SelectCard` (Task 2) with `isActive`.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block:

```tsx
describe('input isolation (H8)', () => {
  test('active ConfirmCard + inactive SelectCard: enter confirms only', () => {
    const onConfirm = vi.fn()
    const onSelect = vi.fn()
    const { stdin } = render(
      <>
        <ConfirmCard message="?" isActive onConfirm={onConfirm} onCancel={noop} />
        <SelectCard isActive={false} items={[{ label: 'a', value: 'a' }]} onSelect={onSelect} />
      </>,
    )
    act(() => stdin.write('\r'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('inactive ConfirmCard + active SelectCard: enter selects only', () => {
    const onConfirm = vi.fn()
    const onSelect = vi.fn()
    const { stdin } = render(
      <>
        <ConfirmCard message="?" isActive={false} onConfirm={onConfirm} onCancel={noop} />
        <SelectCard isActive items={[{ label: 'a', value: 'a' }]} onSelect={onSelect} />
      </>,
    )
    act(() => stdin.write('\r'))
    expect(onSelect).toHaveBeenCalledWith('a')
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it passes** (Tasks 1 & 2 already implement the behavior)

Run: `pnpm exec vitest run test/components.test.tsx -t 'input isolation'`
Expected: PASS. If either case fails, the gate is incomplete — fix the relevant component before continuing.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/test/components.test.tsx
git commit -m "test(ui): prove key isolation between active and inactive cards (H8)"
```

---

## Task 4: Presentational polish — IconLine, KeyHints, StatusLine, SystemNotice, Footer

**Files:**
- Modify: `packages/ui/src/IconLine.tsx`, `packages/ui/src/KeyHints.tsx`, `packages/ui/src/StatusLine.tsx`, `packages/ui/src/SystemNotice.tsx`, `packages/ui/src/Footer.tsx`
- Test: `packages/ui/test/components.test.tsx`

**Interfaces:**
- Produces (signature changes only):
  - `IconLine`: `color?: TextProps['color']` (was `string`).
  - `KeyHints`: unchanged props; internal layout change.
  - `StatusLine`: `color?: TextProps['color']`.
  - `SystemNotice`: unchanged props; info icon becomes `i`.
  - `Footer`: adds `borderColor?: TextProps['color']` (default `'gray'`).

- [ ] **Step 1: Write the failing/covering tests**

Add or update in `packages/ui/test/components.test.tsx`:

```tsx
describe('SystemNotice icon', () => {
  test('info notice uses an ascii "i", not the ambiguous-width glyph', () => {
    const { lastFrame } = render(<SystemNotice variant="info" text="heads up" />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('heads up')
    expect(frame).not.toContain('ℹ')
    expect(frame).toContain('i')
  })
})

describe('KeyHints layout', () => {
  test('renders each hint even when width is tight', () => {
    const { lastFrame } = render(
      <Box width={12}>
        <KeyHints
          hints={[
            { keys: 'esc', label: 'cancel' },
            { keys: 'enter', label: 'confirm' },
          ]}
        />
      </Box>,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[esc] cancel')
    expect(frame).toContain('[enter] confirm')
  })
})

describe('Footer borderColor', () => {
  test('accepts a borderColor override without error', () => {
    const { lastFrame } = render(
      <Footer borderColor="magenta">
        <KeyHints hints={[{ keys: 'q', label: 'quit' }]} />
      </Footer>,
    )
    expect(lastFrame()).toContain('[q] quit')
  })
})
```

Add `import { Box } from 'ink'` to the test file's imports if not already present (the KeyHints layout test wraps in a `Box`).

- [ ] **Step 2: Run to verify the SystemNotice test fails**

Run: `pnpm exec vitest run test/components.test.tsx -t 'SystemNotice icon'`
Expected: FAIL — current icon is `ℹ`, so `not.toContain('ℹ')` fails.

- [ ] **Step 3a: Edit `IconLine.tsx`**

Change the import to `import { Box, Text, type TextProps } from 'ink'`, change `color?: string` to `color?: TextProps['color']`, and update the JSDoc to note children are text content:

```tsx
export type IconLineProps = {
  icon: string
  color?: TextProps['color']
  dim?: boolean
  /** Text content rendered inside a single `<Text>`; a `<Box>` child is unsupported (Ink crashes). */
  children: ReactNode
}
```

- [ ] **Step 3b: Rewrite `KeyHints.tsx`**

```tsx
import { Box, Text } from 'ink'

export type KeyHint = { keys: string; label: string }

export type KeyHintsProps = {
  hints: Array<KeyHint>
}

/** A dimmed, wrapping row of `[keys] label` hints; wraps between hints, not mid-hint. */
export function KeyHints({ hints }: KeyHintsProps) {
  return (
    <Box flexWrap="wrap">
      {hints.map((hint) => (
        <Box key={`${hint.keys}:${hint.label}`} marginRight={2}>
          <Text dimColor>{`[${hint.keys}] ${hint.label}`}</Text>
        </Box>
      ))}
    </Box>
  )
}
```

- [ ] **Step 3c: Edit `StatusLine.tsx`**

Change the import to `import { Box, Text, type TextProps } from 'ink'`, change `color?: string` to `color?: TextProps['color']`, and add a separator space after the busy spinner so it is not flush with the icon/label:

```tsx
  return (
    <Box>
      {busy ? <Spinner /> : null}
      {busy ? <Text> </Text> : null}
      {icon != null ? <Text color={color}>{icon} </Text> : null}
      <Text color={color}>{label}</Text>
    </Box>
  )
```

(Keep the existing `import { Spinner } from '@inkjs/ui'`.)

- [ ] **Step 3d: Edit `SystemNotice.tsx`**

Change the info icon and type the color map. Add `import type { TextProps } from 'ink'` and:

```tsx
const COLOR: Record<SystemNoticeVariant, TextProps['color']> = {
  info: 'blue',
  warning: 'yellow',
  error: 'red',
  success: 'green',
}

const ICON: Record<SystemNoticeVariant, string> = {
  info: 'i',
  warning: '!',
  error: '✗',
  success: '✓',
}
```

- [ ] **Step 3e: Edit `Footer.tsx`**

Add a `borderColor` override:

```tsx
import { Box, type TextProps } from 'ink'
import type { ReactNode } from 'react'

export type FooterProps = {
  children: ReactNode
  /** Border color, default 'gray'. */
  borderColor?: TextProps['color']
}

/** A bordered bottom container for status lines, hints, or an input row. */
export function Footer({ children, borderColor = 'gray' }: FooterProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1}>
      {children}
    </Box>
  )
}
```

- [ ] **Step 4: Run the polish tests and the full unit suite**

Run: `pnpm exec vitest run test/components.test.tsx`
Expected: PASS (all blocks, including the updated KeyHints/SystemNotice/Footer and the existing IconLine/Spinner tests).

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/IconLine.tsx packages/ui/src/KeyHints.tsx packages/ui/src/StatusLine.tsx packages/ui/src/SystemNotice.tsx packages/ui/src/Footer.tsx packages/ui/test/components.test.tsx
git commit -m "fix(ui): polish IconLine/KeyHints/StatusLine/SystemNotice/Footer; type colors"
```

---

## Task 5: Drop default exports across the kit

**Files:**
- Modify: `packages/ui/src/ConfirmCard.tsx`, `SelectCard.tsx`, `IconLine.tsx`, `KeyHints.tsx`, `StatusLine.tsx`, `SystemNotice.tsx`, `Footer.tsx`, `Spinner.tsx`
- (No change to `index.ts` — it already re-exports named symbols only.)

**Interfaces:**
- Produces: named exports only. `index.ts` is unchanged, so consumers (all named imports) are unaffected.

- [ ] **Step 1: Remove every `export default` line**

Delete the trailing `export default <Name>` line from each of the eight `src/*.tsx` files listed above. (Tasks 1 and 2 already removed it from `ConfirmCard.tsx` and `SelectCard.tsx` by rewriting them — confirm none remains.)

Verify none remain:

```bash
grep -rn "export default" packages/ui/src
```
Expected: no output.

- [ ] **Step 2: Type-check and run the full package test**

Run: `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src
git commit -m "refactor(ui): drop default exports, keep named exports only"
```

---

## Task 6: Full verification and lint

**Files:** none (verification only)

- [ ] **Step 1: Lint and format the repo**

From repo root: `rtk lint biome`
Expected: clean (or auto-fixes applied — re-stage and amend the last commit if it rewrites files).

- [ ] **Step 2: Run the package build to confirm the public surface compiles**

From `packages/ui/`: `pnpm exec tsc --emitDeclarationOnly --skipLibCheck`
Expected: emits declarations with no errors. (Do not commit `lib/`.)

- [ ] **Step 3: Full package test**

From `packages/ui/`: `pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run`
Expected: green.

- [ ] **Step 4: Confirm acceptance criteria**

Re-read the spec's Acceptance section and check each item against the passing tests and the diff. If any is unmet, return to the owning task.

---

## Self-Review

**Spec coverage:**
- H8 fix (both cards, nested Select) → Tasks 1, 2; proven → Task 3. ✓
- Fire-once shared latch, mount-scoped → Task 1 (`y`/`y`, `y`/`esc` tests). ✓
- Crash-safety net (sync throw + promise rejection, both callbacks) → Task 1. ✓
- SelectCard generic `T`, both defaults, value round-trip, static-items doc → Task 2. ✓
- Color typing across IconLine/StatusLine/SystemNotice/ConfirmCard/SelectCard/Footer → Tasks 1, 2, 4. ✓
- KeyHints wrap-between-hints → Task 4. ✓
- StatusLine spinner separator → Task 4. ✓
- SystemNotice `ℹ`→`i` → Task 4. ✓
- IconLine children JSDoc → Task 4. ✓
- Footer borderColor → Task 4. ✓
- Empty-items terminal state documented → Task 2 (JSDoc). ✓
- Drop default exports → Task 5. ✓
- `pnpm test` + lint green → Task 6. ✓
- No consumer-repo edits → held throughout (Global Constraints). ✓

**Placeholder scan:** No TBD/TODO; every code step has literal code. ✓

**Type consistency:** `run(callback)`, `SelectItem<T = string>`, `SelectCardProps<T = string>`, `onSelect: (value: T) => void`, `TextProps['color']` used consistently across tasks. `index.ts` re-export names unchanged. ✓
