# Port and CLI Option Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** completing
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-13-port-and-cli-option-validation-design.md`

**Goal:** Make port values validated everywhere they enter the system (env override and `--port` flag), give `@tejika/env` a non-probing `resolvePort` for client commands, and fix the `@tejika/cli` option builders (wrong hook target, missing passthroughs, silent Ink Ctrl+C inversion).

**Architecture:** One validator, `parsePort`, lives in `@tejika/env` and is the single source of truth for "what is a port". `getPort` (async, probes for a free port — server side) and `resolvePort` (sync, no I/O — client side) both run env overrides through it. `@tejika/cli`'s `withPort` reuses the same validator as a commander argParser and mirrors the two env functions: no `exact` → async hook + `getPort`; `exact: true` → sync hook + `resolvePort`. All option-builder preAction hooks are fixed to read/write the *hooked* command (the one owning the option) rather than the leaf action command.

**Tech Stack:** TypeScript (ESM, NodeNext), commander v15, ink v7, get-port v7, vitest, biome, pnpm workspaces.

## Global Constraints

Copied from `AGENTS.md` and the repo conventions — every task must respect these:

- Use `type`, never `interface`.
- Use `Array<T>`, never `T[]`.
- Never use `any` — use `unknown`, `Record<string, unknown>`, or a specific type.
- Uppercase well-known abbreviations in names (`ID`, `HTTP`, `PID`), never `Id`/`Http`.
- No TS `private`/`readonly` modifiers — ES private fields (`#field`) + getters.
- `pnpm`/`pnpx` only, never `npm`/`npx`.
- Never edit generated files (`lib/`).
- Test files import source through `../src/*.js` (ESM `.js` extension on TS sources).
- Lint with `pnpm exec biome check .` (an `rtk` shim may hijack `pnpm run lint`).
- Ports are integers in `1..65535` inclusive. `0` is invalid (it means "any port" to the OS and silently defeats an operator's pin).
- Default log levels are LogTape's set: `trace debug info warning error fatal`. Do not add a `@sozai/*` or `@logtape/*` dependency to tejika — inline the list.

---

### Task 1: `parsePort` validator in `@tejika/env`

**Files:**
- Modify: `packages/env/src/ports.ts`
- Modify: `packages/env/src/index.ts:3`
- Test: `packages/env/test/ports.test.ts`

**Interfaces:**
- Consumes: `appEnvVar` from `./env-var.js` (already exists).
- Produces:
  - `parsePort(value: string, label?: string): number` — trims, requires `/^\d+$/` and `1 <= n <= 65535`, else throws `Error`. When `label` is given the message is `` `${label} is not a valid port number: "${value}"` ``; otherwise `` `Invalid port number: "${value}"` ``.
  - `assertPort(port: number, label?: string, raw?: string | number): number` — module-private (NOT exported from the package), same range check for a value that is already a number. `raw` is the original text to quote in the error message, defaulting to `port`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/env/test/ports.test.ts`, above the existing `describe('getPort')` block, and add `parsePort` to the import on line 2:

```ts
import { afterEach, describe, expect, test } from 'vitest'
import { getPort, parsePort } from '../src/ports.js'

describe('parsePort', () => {
  test('accepts valid ports', () => {
    expect(parsePort('1')).toBe(1)
    expect(parsePort('8080')).toBe(8080)
    expect(parsePort('65535')).toBe(65535)
  })
  test('accepts a padded value', () => {
    expect(parsePort(' 8080 ')).toBe(8080)
  })
  test.each(['80abc', '80.5', '0x50', '-1', '', '   ', 'abc'])(
    'rejects the malformed value %j',
    (value) => {
      expect(() => parsePort(value)).toThrow(/not a valid port number|Invalid port number/)
    },
  )
  test.each(['0', '70000', '65536'])('rejects the out-of-range value %j', (value) => {
    expect(() => parsePort(value)).toThrow(/Invalid port number/)
  })
  test('names the source in the message when a label is given', () => {
    expect(() => parsePort('0', 'MYAPP_PORT')).toThrow(
      'MYAPP_PORT is not a valid port number: "0"',
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/env && pnpm exec vitest run test/ports.test.ts`
Expected: FAIL — `parsePort` is not exported by `../src/ports.js`.

- [ ] **Step 3: Implement `parsePort`**

Replace the top of `packages/env/src/ports.ts` (keep the existing `getPort` below it untouched for now — Task 2 rewrites it):

```ts
import getAvailablePort from 'get-port'
import { appEnvVar, getAppEnvVar } from './env-var.js'

const MIN_PORT = 1
const MAX_PORT = 65535

function invalidPort(value: string | number, label?: string): Error {
  return new Error(
    label == null
      ? `Invalid port number: "${value}"`
      : `${label} is not a valid port number: "${value}"`,
  )
}

/**
 * Parse a port from a string, rejecting anything that is not an integer in
 * 1..65535. `Number.parseInt` is deliberately not used: it accepts `'80abc'`,
 * `'80.5'` and `'0x50'`. Port `0` is rejected too — it means "any port" to the
 * OS, so accepting it would silently defeat a pinned port.
 */
export function parsePort(value: string, label?: string): number {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw invalidPort(value, label)
  }
  return assertPort(Number(trimmed), label, value)
}

/** Range-check a port that is already a number. Module-private. */
function assertPort(port: number, label?: string, raw: string | number = port): number {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw invalidPort(raw, label)
  }
  return port
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/env && pnpm exec vitest run test/ports.test.ts`
Expected: PASS — the new `parsePort` block is green. The existing `getPort` tests must still pass.

- [ ] **Step 5: Export it from the package**

`packages/env/src/index.ts` line 3 becomes:

```ts
export { getPort, parsePort } from './ports.js'
```

- [ ] **Step 6: Verify the package is green**

Run: `cd packages/env && pnpm test`
Expected: PASS (types + unit).

- [ ] **Step 7: Commit**

```bash
git add packages/env/src/ports.ts packages/env/src/index.ts packages/env/test/ports.test.ts
git commit -m "feat(env): add parsePort, a strict port validator"
```

---

### Task 2: `getPort` validation + `resolvePort` in `@tejika/env`

**Files:**
- Modify: `packages/env/src/ports.ts`
- Modify: `packages/env/src/index.ts:3`
- Test: `packages/env/test/ports.test.ts`

**Interfaces:**
- Consumes: `parsePort` / `assertPort` from Task 1.
- Produces:
  - `getPort(app: string, opts?: { default?: number; host?: string }): Promise<number>` — env override (validated) wins; otherwise get-port finds a free port, preferring `opts.default`. May return a port other than `opts.default` if that one is taken.
  - `resolvePort(app: string, defaultPort: number): number` — sync, no I/O. Env override (validated) wins; otherwise `defaultPort` verbatim. Throws if `defaultPort` is not a valid port.
  - `type GetPortOptions = { default?: number; host?: string }`

- [ ] **Step 1: Write the failing tests**

In `packages/env/test/ports.test.ts`, import `resolvePort` alongside the others, replace the existing `throws on a non-numeric override` test with the block below, and add the `resolvePort` describe:

```ts
import { getPort, parsePort, resolvePort } from '../src/ports.js'

// ...inside describe('getPort'), replacing the old single non-numeric test:
  test.each(['abc', '80abc', '80.5', '0x50', '0', '-1', '70000'])(
    'throws on the invalid override %j',
    async (value) => {
      process.env.MYAPP_PORT = value
      await expect(getPort('myapp')).rejects.toThrow(/MYAPP_PORT is not a valid port number/)
    },
  )
  test('throws on an invalid default', async () => {
    await expect(getPort('myapp', { default: 0 })).rejects.toThrow(/Invalid port number/)
  })

describe('resolvePort', () => {
  test('returns the default verbatim without probing', () => {
    expect(resolvePort('myapp', 4000)).toBe(4000)
  })
  test('returns the default even when the port is in use', async () => {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address != null ? address.port : 0
    try {
      expect(resolvePort('myapp', port)).toBe(port)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
  test('returns the env override when set', () => {
    process.env.MYAPP_PORT = '7777'
    expect(resolvePort('myapp', 4000)).toBe(7777)
  })
  test('throws on an invalid env override', () => {
    process.env.MYAPP_PORT = '0'
    expect(() => resolvePort('myapp', 4000)).toThrow(/MYAPP_PORT is not a valid port number/)
  })
  test('throws on an invalid default', () => {
    expect(() => resolvePort('myapp', 70000)).toThrow(/Invalid port number/)
  })
})
```

The `afterEach` at the top of the file already deletes `process.env.MYAPP_PORT`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/env && pnpm exec vitest run test/ports.test.ts`
Expected: FAIL — `resolvePort` is not exported; `getPort` accepts `'80abc'` and `'0'` instead of throwing.

- [ ] **Step 3: Rewrite `getPort` and add `resolvePort`**

Replace everything below the `assertPort` helper in `packages/env/src/ports.ts`:

```ts
export type GetPortOptions = {
  /** Preferred port. If it is taken, a different free port is returned. */
  default?: number
  /** Host to probe for availability. */
  host?: string
}

/**
 * Resolve a port for a server to listen on. The env override wins; otherwise a
 * free port is found, preferring `opts.default`.
 *
 * NOTE: when `opts.default` is already taken this returns a DIFFERENT port. Use
 * `resolvePort` for a client that must dial a known port — probing would see the
 * server holding it and hand back a port nothing is listening on.
 */
export async function getPort(app: string, opts: GetPortOptions = {}): Promise<number> {
  const override = getAppEnvVar(app, 'PORT')
  if (override != null) {
    return parsePort(override, appEnvVar(app, 'PORT'))
  }
  if (opts.default != null) {
    assertPort(opts.default)
  }
  return getAvailablePort({ port: opts.default, host: opts.host })
}

/**
 * Resolve a known port without probing: the env override if set, otherwise
 * `defaultPort` verbatim. Synchronous and I/O-free — this is the client-side
 * counterpart of `getPort`.
 */
export function resolvePort(app: string, defaultPort: number): number {
  const override = getAppEnvVar(app, 'PORT')
  if (override != null) {
    return parsePort(override, appEnvVar(app, 'PORT'))
  }
  return assertPort(defaultPort)
}
```

`getAvailablePort({ port: undefined, host: undefined })` is equivalent to calling it with no options, so the previous `opts.default == null ? undefined : {...}` dance is gone.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/env && pnpm exec vitest run test/ports.test.ts`
Expected: PASS — all `parsePort`, `getPort` and `resolvePort` tests green.

- [ ] **Step 5: Export from the package**

`packages/env/src/index.ts` line 3 becomes:

```ts
export { type GetPortOptions, getPort, parsePort, resolvePort } from './ports.js'
```

- [ ] **Step 6: Verify the whole package**

Run: `cd packages/env && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/env/src/ports.ts packages/env/src/index.ts packages/env/test/ports.test.ts
git commit -m "feat(env)!: validate port overrides and add resolvePort

getPort now rejects malformed and out-of-range overrides (80abc, 0, 70000)
instead of parseInt-ing them, and takes a host passthrough. resolvePort is
the sync, non-probing counterpart for clients dialing a known server."
```

---

### Task 3: `withPort` — argParser, hook target, exact mode

**Files:**
- Modify: `packages/cli/src/options.ts:20-37`
- Test: `packages/cli/test/options.test.ts`

**Interfaces:**
- Consumes: `getPort`, `resolvePort`, `parsePort` from `@tejika/env` (Tasks 1–2).
- Produces:
  - `type WithPortOptions = { default?: number; exact?: boolean; host?: string }`
  - `withPort(cmd: Command, app: string, opts?: WithPortOptions): Command` — registers `-p, --port <port>` with an argParser that yields a `number`. Without `exact`, an **async** preAction hook fills the default from `getPort` (requires `program.parseAsync()`). With `exact: true` (which requires `default`), a **sync** preAction hook fills it from `resolvePort`, so plain `parse()` works. `exact` without `default` throws at registration.

**Background the implementer needs:**

Commander stores an option's value on the command where the option was *declared*. The current hook reads and writes `actionCmd` — the leaf command being actioned — so when `withPort` is applied to a parent command with subcommands, a user-supplied `-p` on the parent is ignored and the default is written to the wrong command. The hook callback signature is `(thisCommand, actionCommand)`; `thisCommand` is the command the hook was registered on, which is exactly the option's owner. Use it.

A leaf action then reads an ancestor's option with `optsWithGlobals()`, not `opts()`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `packages/cli/test/options.test.ts` with:

```ts
import { Command } from 'commander'
import { afterEach, describe, expect, test } from 'vitest'
import { withLogLevel, withPort } from '../src/options.js'

afterEach(() => {
  delete process.env.MYAPP_PORT
})

/** Build `parent [-p <port>] sub`, capturing what the subcommand action sees. */
function programWithSubcommand(register: (cmd: Command) => void): {
  program: Command
  seen: () => Record<string, unknown>
} {
  let captured: Record<string, unknown> = {}
  const sub = new Command('sub').action(function (this: Command) {
    captured = this.optsWithGlobals()
  })
  const program = new Command('parent').exitOverride()
  register(program)
  program.addCommand(sub)
  return { program, seen: () => captured }
}

describe('withPort', () => {
  test('injects the env-resolved default when no flag is given', async () => {
    process.env.MYAPP_PORT = '7777'
    const { program, seen } = programWithSubcommand((cmd) => withPort(cmd, 'myapp'))
    await program.parseAsync(['sub'], { from: 'user' })
    expect(seen().port).toBe(7777)
  })

  test('an explicit flag on the parent beats the default', async () => {
    process.env.MYAPP_PORT = '7777'
    const { program, seen } = programWithSubcommand((cmd) => withPort(cmd, 'myapp'))
    await program.parseAsync(['-p', '8080', 'sub'], { from: 'user' })
    expect(seen().port).toBe(8080)
  })

  test('parses the flag to a number', async () => {
    const { program, seen } = programWithSubcommand((cmd) => withPort(cmd, 'myapp'))
    await program.parseAsync(['-p', '8080', 'sub'], { from: 'user' })
    expect(seen().port).toBe(8080)
    expect(typeof seen().port).toBe('number')
  })

  test.each(['-1', '0', '80abc', '70000'])('rejects the invalid flag value %j', async (value) => {
    const { program } = programWithSubcommand((cmd) => withPort(cmd, 'myapp'))
    await expect(program.parseAsync(['-p', value, 'sub'], { from: 'user' })).rejects.toThrow(
      /between 1 and 65535/,
    )
  })

  test('honours an env override set after the program is built', async () => {
    const { program, seen } = programWithSubcommand((cmd) => withPort(cmd, 'myapp'))
    process.env.MYAPP_PORT = '7777'
    await program.parseAsync(['sub'], { from: 'user' })
    expect(seen().port).toBe(7777)
  })

  test('exact mode resolves the default under synchronous parse()', () => {
    const { program, seen } = programWithSubcommand((cmd) =>
      withPort(cmd, 'myapp', { default: 4000, exact: true }),
    )
    program.parse(['sub'], { from: 'user' })
    expect(seen().port).toBe(4000)
  })

  test('exact mode still honours the env override', () => {
    process.env.MYAPP_PORT = '7777'
    const { program, seen } = programWithSubcommand((cmd) =>
      withPort(cmd, 'myapp', { default: 4000, exact: true }),
    )
    program.parse(['sub'], { from: 'user' })
    expect(seen().port).toBe(7777)
  })

  test('exact without a default throws at registration', () => {
    expect(() => withPort(new Command(), 'myapp', { exact: true })).toThrow(/requires a `default`/)
  })
})

describe('withLogLevel', () => {
  test('registers a --log-level option with a default', () => {
    const cmd = withLogLevel(new Command())
    const opt = cmd.options.find((o) => o.long === '--log-level')
    expect(opt).toBeDefined()
    expect(opt?.defaultValue).toBe('warning')
  })
})
```

`exitOverride()` makes commander throw on a usage error instead of calling `process.exit`, so the invalid-value cases are assertable.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/cli && pnpm exec vitest run test/options.test.ts`
Expected: FAIL — the parent-flag and exact-mode cases fail (`port` is `undefined` or a string), and `withPort` takes no third argument.

- [ ] **Step 3: Implement `withPort`**

In `packages/cli/src/options.ts`, extend the imports and replace the whole `withPort` block (lines 20-37):

```ts
import { getPort, getSocketPath, parsePort, resolvePort } from '@tejika/env'
import { type Command, InvalidArgumentError } from 'commander'

function parsePortArg(value: string): number {
  try {
    return parsePort(value)
  } catch {
    throw new InvalidArgumentError('Expected an integer between 1 and 65535.')
  }
}

export type WithPortOptions = {
  /** Preferred port when there is no env override. */
  default?: number
  /** Use `default` verbatim instead of probing for a free port. Requires `default`. */
  exact?: boolean
  /** Host to probe when finding a free port. Ignored in exact mode. */
  host?: string
}

/**
 * Add `-p, --port <port>`, parsed and range-checked into a `number`.
 *
 * The default is resolved lazily at action time (via a preAction hook), not at
 * registration, so an env override set after the program is built is honored and
 * registration stays synchronous. The hook reads and writes the command the option
 * is registered on — commander stores an option's value there — so a leaf action
 * reads an ancestor's `--port` with `optsWithGlobals()`, not `opts()`.
 *
 * Without `exact`, the hook is async (it awaits `getPort`, which probes for a free
 * port). Commander only awaits hooks under `parseAsync()`; under the synchronous
 * `parse()` the hook is fire-and-forget, so its result lands after the action has
 * already run and `port` is undefined at action time. Such a program MUST call
 * `parseAsync()`.
 *
 * With `exact: true` the hook is synchronous (`resolvePort` does no I/O), so plain
 * `parse()` works.
 */
export function withPort(cmd: Command, app: string, opts: WithPortOptions = {}): Command {
  const { default: defaultPort, exact, host } = opts
  if (exact && defaultPort == null) {
    throw new Error('withPort requires a `default` port when `exact` is set')
  }
  cmd.option('-p, --port <port>', 'port number', parsePortArg)
  if (exact && defaultPort != null) {
    cmd.hook('preAction', (thisCmd) => {
      if (thisCmd.opts().port == null) {
        thisCmd.setOptionValue('port', resolvePort(app, defaultPort))
      }
    })
  } else {
    cmd.hook('preAction', async (thisCmd) => {
      if (thisCmd.opts().port == null) {
        thisCmd.setOptionValue('port', await getPort(app, { default: defaultPort, host }))
      }
    })
  }
  return cmd
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/cli && pnpm exec vitest run test/options.test.ts`
Expected: PASS.

- [ ] **Step 5: Export the new type**

`packages/cli/src/index.ts` line 2 becomes:

```ts
export { type WithPortOptions, withLogLevel, withPort, withSocketPath } from './options.js'
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/options.ts packages/cli/src/index.ts packages/cli/test/options.test.ts
git commit -m "fix(cli)!: validate --port and target the option's own command

The preAction hook read and wrote the leaf action command while the option is
registered on the hooked command, so a parent -p was ignored with subcommands.
--port now parses through @tejika/env's parsePort, and an exact mode resolves a
pinned port synchronously for client commands."
```

---

### Task 4: `withSocketPath` name passthrough + `withLogLevel` choices

**Files:**
- Modify: `packages/cli/src/options.ts:10-18`, `packages/cli/src/options.ts:39-42`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/options.test.ts`

**Interfaces:**
- Consumes: `getSocketPath` from `@tejika/env`; the `programWithSubcommand` test helper from Task 3.
- Produces:
  - `type WithSocketPathOptions = { name?: string }`
  - `withSocketPath(cmd: Command, app: string, opts?: WithSocketPathOptions): Command` — same hooked-command fix as `withPort`; passes `opts.name` to `getSocketPath(app, name)`.
  - `type WithLogLevelOptions = { levels?: Array<string>; default?: string }`
  - `withLogLevel(cmd: Command, opts?: WithLogLevelOptions): Command`
  - `DEFAULT_LOG_LEVELS: Array<string>` = `['trace', 'debug', 'info', 'warning', 'error', 'fatal']`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/options.test.ts` (and add `DEFAULT_LOG_LEVELS`, `withSocketPath` to the import from `../src/options.js`; add `delete process.env.MYAPP_SOCKET_PATH` to the existing `afterEach`):

```ts
describe('withSocketPath', () => {
  test('injects the env-resolved default when no flag is given', async () => {
    process.env.MYAPP_SOCKET_PATH = '/tmp/from-env.sock'
    const { program, seen } = programWithSubcommand((cmd) => withSocketPath(cmd, 'myapp'))
    await program.parseAsync(['sub'], { from: 'user' })
    expect(seen().socketPath).toBe('/tmp/from-env.sock')
  })

  test('an explicit flag on the parent beats the default', async () => {
    process.env.MYAPP_SOCKET_PATH = '/tmp/from-env.sock'
    const { program, seen } = programWithSubcommand((cmd) => withSocketPath(cmd, 'myapp'))
    await program.parseAsync(['-s', '/tmp/flag.sock', 'sub'], { from: 'user' })
    expect(seen().socketPath).toBe('/tmp/flag.sock')
  })

  test('a named socket resolves under the data dir, ignoring the path override', async () => {
    process.env.MYAPP_SOCKET_PATH = '/tmp/from-env.sock'
    process.env.MYAPP_DATA_DIR = '/tmp/data'
    const { program, seen } = programWithSubcommand((cmd) =>
      withSocketPath(cmd, 'myapp', { name: 'worker' }),
    )
    await program.parseAsync(['sub'], { from: 'user' })
    expect(seen().socketPath).toBe('/tmp/data/worker.sock')
    delete process.env.MYAPP_DATA_DIR
  })
})

describe('withLogLevel choices', () => {
  test('accepts a listed level', async () => {
    const { program, seen } = programWithSubcommand((cmd) => withLogLevel(cmd))
    await program.parseAsync(['-l', 'debug', 'sub'], { from: 'user' })
    expect(seen().logLevel).toBe('debug')
  })

  test('rejects an unlisted level', async () => {
    const { program } = programWithSubcommand((cmd) => withLogLevel(cmd))
    await expect(program.parseAsync(['-l', 'verbose', 'sub'], { from: 'user' })).rejects.toThrow(
      /Allowed choices are/,
    )
  })

  test('accepts a caller-supplied level set and default', async () => {
    const { program, seen } = programWithSubcommand((cmd) =>
      withLogLevel(cmd, { levels: ['quiet', 'loud'], default: 'loud' }),
    )
    await program.parseAsync(['sub'], { from: 'user' })
    expect(seen().logLevel).toBe('loud')
  })

  test('exposes the LogTape level set', () => {
    expect(DEFAULT_LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warning', 'error', 'fatal'])
  })
})
```

Note: `getSocketPath(app, name)` ignores the `MYAPP_SOCKET_PATH` override when a `name` is given (see `packages/env/src/paths.ts:14`) — the third test asserts that existing behaviour, it is not a new rule.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/cli && pnpm exec vitest run test/options.test.ts`
Expected: FAIL — `DEFAULT_LOG_LEVELS` is not exported, `withSocketPath` takes no third argument, the parent `-s` case sees `undefined`, and `-l verbose` is accepted.

- [ ] **Step 3: Implement both builders**

In `packages/cli/src/options.ts`, add `Option` to the commander import (`import { type Command, InvalidArgumentError, Option } from 'commander'`), then replace `withSocketPath` and `withLogLevel`:

```ts
export type WithSocketPathOptions = {
  /** Resolve a named socket (`<name>.sock`) under the app data dir. */
  name?: string
}

/**
 * Add `-s, --socket-path <path>`. The default is resolved lazily from `@tejika/env`
 * at action time (via a preAction hook), not at registration, so an env override set
 * after the program is built is still honored and option registration stays
 * synchronous. The hook targets the command the option is registered on; a leaf
 * action reads an ancestor's value with `optsWithGlobals()`.
 */
export function withSocketPath(
  cmd: Command,
  app: string,
  opts: WithSocketPathOptions = {},
): Command {
  cmd.option('-s, --socket-path <path>', 'unix socket path')
  cmd.hook('preAction', (thisCmd) => {
    if (thisCmd.opts().socketPath == null) {
      thisCmd.setOptionValue('socketPath', getSocketPath(app, opts.name))
    }
  })
  return cmd
}

/** LogTape's level set, which `@sozai/log` re-exports. */
export const DEFAULT_LOG_LEVELS: Array<string> = [
  'trace',
  'debug',
  'info',
  'warning',
  'error',
  'fatal',
]

export type WithLogLevelOptions = {
  /** Accepted levels. Defaults to `DEFAULT_LOG_LEVELS`. */
  levels?: Array<string>
  /** Default level. Defaults to `warning`. */
  default?: string
}

/** Add `-l, --log-level <level>`, restricted to `levels` and defaulting to `warning`. */
export function withLogLevel(cmd: Command, opts: WithLogLevelOptions = {}): Command {
  const option = new Option('-l, --log-level <level>', 'log level')
    .choices(opts.levels ?? DEFAULT_LOG_LEVELS)
    .default(opts.default ?? 'warning')
  return cmd.addOption(option)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/cli && pnpm exec vitest run test/options.test.ts`
Expected: PASS.

- [ ] **Step 5: Export the new symbols**

`packages/cli/src/index.ts` line 2 becomes:

```ts
export {
  DEFAULT_LOG_LEVELS,
  type WithLogLevelOptions,
  type WithPortOptions,
  type WithSocketPathOptions,
  withLogLevel,
  withPort,
  withSocketPath,
} from './options.js'
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/options.ts packages/cli/src/index.ts packages/cli/test/options.test.ts
git commit -m "feat(cli)!: named sockets and constrained log levels

withSocketPath forwards a name to getSocketPath and its hook targets the
option's own command; withLogLevel restricts values to LogTape's level set
(overridable) instead of accepting any string."
```

---

### Task 5: `runInk` stops swallowing Ctrl+C

**Files:**
- Modify: `packages/cli/src/ink.ts:5-8`
- Modify: `packages/cli/test/ink.integration.test.ts`
- Modify: `packages/cli/package.json` (drop the unused `ink-testing-library` dev dep)
- Create: `packages/cli/test/fixtures/ink-static.js`
- Test: `packages/cli/test/ink.integration.test.ts`

**Interfaces:**
- Consumes: `PTYDriver` from `@tejika/test` (already used by this test file; it has a `ctrlC()` method).
- Produces: `runInk(element: ReactElement, options?: RenderOptions): Promise<void>` — unchanged signature, but no longer overrides `exitOnCtrlC`.

**Why:** `render(element, { exitOnCtrlC: false, ...options })` inverts Ink's default. Ink's raw mode swallows SIGINT, so an app that does not implement its own Ctrl+C handling cannot be quit at all. Ink's default (`exitOnCtrlC: true`) makes every app quittable; an app that wants to intercept Ctrl+C passes `{ exitOnCtrlC: false }` itself.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/ink.integration.test.ts`:

```ts
test('runInk exits on Ctrl+C by default', { timeout: 30_000 }, async () => {
  using driver = new PTYDriver({ args: [fixture] })
  expect(await driver.waitFor('last:none')).toBe(true)
  driver.ctrlC()
  const exit = await driver.waitForExit()
  expect(exit?.exitCode).toBe(0)
})
```

Also add a `renderStatic` fixture, `packages/cli/test/fixtures/ink-static.js` — this replaces the unused `ink-testing-library` dev dep with a test that exercises the real stdout path:

```js
import { Text } from 'ink'
import { createElement } from 'react'
import { renderStatic } from '../../lib/index.js'

renderStatic(createElement(Text, null, 'static:done'))
```

and its test, in the same test file (add `const staticFixture = fileURLToPath(new URL('./fixtures/ink-static.js', import.meta.url))` next to the existing `fixture` constant):

```ts
test('renderStatic prints one frame and exits', { timeout: 30_000 }, async () => {
  using driver = new PTYDriver({ args: [staticFixture] })
  expect(await driver.waitFor('static:done')).toBe(true)
  const exit = await driver.waitForExit()
  expect(exit?.exitCode).toBe(0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/cli && pnpm exec vitest run test/ink.integration.test.ts`
Expected: the Ctrl+C test FAILS (times out waiting for exit — the fixture's `useInput` never sees SIGINT and Ink does not exit). The `renderStatic` test may already pass; that is fine, it is coverage for an untested export.

- [ ] **Step 3: Drop the override**

`packages/cli/src/ink.ts`:

```ts
/**
 * Render an interactive Ink app and resolve when it exits.
 *
 * Ink's defaults apply, including `exitOnCtrlC: true` — an app that wants to
 * intercept Ctrl+C must pass `{ exitOnCtrlC: false }` and then take on the duty of
 * exiting, because Ink's raw mode swallows SIGINT.
 */
export async function runInk(element: ReactElement, options: RenderOptions = {}): Promise<void> {
  const app = render(element, options)
  await app.waitUntilExit()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/cli && pnpm exec vitest run test/ink.integration.test.ts`
Expected: PASS — all three tests, including the pre-existing keyboard-input one.

- [ ] **Step 5: Drop the unused dev dep**

Remove the `"ink-testing-library": "catalog:"` line from `packages/cli/package.json` `devDependencies` (it is imported nowhere in this package; `@tejika/ui` keeps its own copy). Then run `pnpm install` from the repo root.

- [ ] **Step 6: Verify the package is green**

Run: `cd packages/cli && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/ink.ts packages/cli/test packages/cli/package.json pnpm-lock.yaml
git commit -m "fix(cli)!: let Ctrl+C quit Ink apps

runInk forced exitOnCtrlC:false, inverting Ink's default: an app that did not
handle Ctrl+C itself was unquittable, because raw mode swallows SIGINT. Apps
that want to intercept it now opt out explicitly."
```

---

### Task 6: Fix the misleading fixture, backlog the deferred work, verify the repo

**Files:**
- Modify: `packages/cli/test/fixtures/cli-program.ts`
- Modify: `packages/cli/test/program.integration.test.ts` (only if the fixture change breaks it)
- Create: `docs/agents/plans/backlog/2026-07-13-runink-exit-codes-and-non-tty-guard.md`

**Interfaces:** none — cleanup and verification.

**Why:** the CLI fixture calls `program.parse()`, modelling the very footgun the old `withPort` doc comment described wrongly. With `withPort`'s async hook, `parse()` is fire-and-forget: the awaited default lands after the action has already run. Making the fixture use `parseAsync()` keeps the example honest.

- [ ] **Step 1: Fix the fixture**

`packages/cli/test/fixtures/cli-program.ts`:

```ts
import { buildProgram } from '../../src/index.js'

// Minimal program built via buildProgram, used by the integration test to prove the
// built program runs end-to-end. Run with `node --import tsx`.
//
// parseAsync, not parse: the option builders register async preAction hooks, and
// commander only awaits hooks under parseAsync. Under the sync parse() the hook is
// fire-and-forget — the action runs before the awaited default is set.
const program = buildProgram({ name: 'demo', version: '9.9.9', commands: [] })
await program.parseAsync()
```

- [ ] **Step 2: Run the CLI test suite**

Run: `cd packages/cli && pnpm test`
Expected: PASS, including `test/program.integration.test.ts`.

- [ ] **Step 3: Write the backlog item**

Create `docs/agents/plans/backlog/2026-07-13-runink-exit-codes-and-non-tty-guard.md`:

```markdown
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
```

- [ ] **Step 4: Verify the whole repo**

Run from the repo root:

```bash
pnpm build && pnpm test && pnpm exec biome check .
```

Expected: all green. (`pnpm run lint` may be hijacked by the `rtk` shim — call biome directly.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/fixtures/cli-program.ts docs/agents/plans/backlog/
git commit -m "docs(cli): fix the parse() fixture and backlog runInk exit codes"
```

---

## Notes for the reviewer

- Tasks 2, 3, 4 and 5 each contain a breaking change to a published (pre-1.0) package. They are marked `!` in their commit subjects. A changeset covering `@tejika/env` and `@tejika/cli` belongs with the release, not with these tasks.
- In-repo consumers were checked: the only caller of any changed API is `packages/server/src/server.ts:59` (`getPort(opts.app)`), whose signature is unchanged. Nothing in-repo calls `withPort`, `withSocketPath` or `runInk` — the breaking changes land on downstream apps (mokei, sakui) at their next bump.
- The one behaviour worth eyeballing by hand: with `withPort` on a parent command, a leaf action must read `optsWithGlobals()`, not `opts()`. This is a **silent breaking change**, not a pre-existing requirement: the OLD hook wrote the resolved default onto the LEAF (`actionCmd`), so a leaf action handler's `options` argument — which commander populates from the leaf's own `opts()` — DID carry `port`/`socketPath`. After the fix the value lives on the option's owner (the parent), so a downstream `sub.action((options) => connectTo(options.port))` now silently receives `undefined` instead of the resolved port. Any consumer whose leaf action reads `opts()` (or the action handler's `options` argument) for a `--port`/`--socket-path` registered on an ancestor must switch to `optsWithGlobals()`.
