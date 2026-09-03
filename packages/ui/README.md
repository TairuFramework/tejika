# @tejika/ui

A generic Ink component kit for terminal user interfaces: status lines, cards,
key hints, and notices. `ink` and `react` are peer dependencies supplied by the
host.

```sh
pnpm add @tejika/ui ink react
```

- `StatusLine` — an optional spinner/icon followed by a coloured label.
- `ConfirmCard` — a yes/no confirmation prompt.
- `SelectCard` — a single-choice list from `SelectItem`s.
- `KeyHints` / `Footer` — a row of `KeyHint` key/label pairs, and a footer wrapper.
- `IconLine` — an icon-prefixed line of text.
- `Spinner` — a standalone spinner.
- `SystemNotice` — a variant-styled notice block (`SystemNoticeVariant`).

```tsx
import { StatusLine, KeyHints } from '@tejika/ui'

<StatusLine label="Starting daemon…" busy color="cyan" />
<KeyHints hints={[{ keys: 'q', label: 'quit' }, { keys: '↵', label: 'select' }]} />
```

Each component exports its props type (`StatusLineProps`, `ConfirmCardProps`, …)
for composing app-specific views.
