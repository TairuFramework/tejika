# @tejika/log

Local log files for CLI tools and daemons: rotating file sinks and a logtape
`Config` builder. The host application supplies `@logtape/logtape` (a peer
dependency) and applies the config with logtape's `configure()` (or a host wrapper such as `@sozai/log`'s `setup()`).

```sh
pnpm add @tejika/log @logtape/logtape
```

- `createFileSink` — a rotating log-file `Sink` for an app, written under
  `getLogDir(app)` by default. Daily or hourly rotation, `text` (`.log`) or
  `jsonLines` (`.jsonl`) format, and retention-based pruning.
- `createFileLogConfig` — build a whole logtape `Config` from a list of file
  targets (each with its own category and level), plus an optional console sink.
  The builder is pure: it never touches logtape's process-global state.

```ts
import { configure } from '@logtape/logtape'
import { createFileLogConfig } from '@tejika/log'

await configure(
  createFileLogConfig({
    app: 'myapp',
    files: [{ name: 'app', category: ['myapp'], level: 'info' }],
    console: 'error',
  }),
)
```

Building a config is not free — every file target creates its directory and
opens a descriptor — so build one only when it is going to be used.
