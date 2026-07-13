import { Command } from 'commander'
import { afterEach, describe, expect, test } from 'vitest'
import { DEFAULT_LOG_LEVELS, withLogLevel, withPort, withSocketPath } from '../src/options.js'

afterEach(() => {
  delete process.env.MYAPP_PORT
  delete process.env.MYAPP_SOCKET_PATH
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

/**
 * Build `parent [-p <port>] sub`, exposing the `program` and `sub` `Command`
 * objects themselves so a test can assert on each command's own `opts()`
 * rather than the ancestor-merged `optsWithGlobals()` view.
 */
function programAndSubCommand(register: (cmd: Command) => void): {
  program: Command
  sub: Command
} {
  const sub = new Command('sub').action(() => {})
  const program = new Command('parent').exitOverride()
  register(program)
  program.addCommand(sub)
  return { program, sub }
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

  test("writes the default to the option's own command, not the leaf action", async () => {
    process.env.MYAPP_PORT = '7777'
    const { program, sub } = programAndSubCommand((cmd) => withPort(cmd, 'myapp'))
    await program.parseAsync(['sub'], { from: 'user' })
    expect(program.opts().port).toBe(7777)
    expect(sub.opts().port).toBeUndefined()
  })

  test("exact mode writes the default to the option's own command, not the leaf action", () => {
    const { program, sub } = programAndSubCommand((cmd) =>
      withPort(cmd, 'myapp', { default: 4000, exact: true }),
    )
    program.parse(['sub'], { from: 'user' })
    expect(program.opts().port).toBe(4000)
    expect(sub.opts().port).toBeUndefined()
  })
})

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

  test("writes the default to the option's own command, not the leaf action", async () => {
    process.env.MYAPP_SOCKET_PATH = '/tmp/from-env.sock'
    const { program, sub } = programAndSubCommand((cmd) => withSocketPath(cmd, 'myapp'))
    await program.parseAsync(['sub'], { from: 'user' })
    expect(program.opts().socketPath).toBe('/tmp/from-env.sock')
    expect(sub.opts().socketPath).toBeUndefined()
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

  test('a default outside the level set throws at registration', () => {
    expect(() =>
      withLogLevel(new Command(), { levels: ['quiet', 'loud'], default: 'nope' }),
    ).toThrow(/`nope`.*quiet, loud/)
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
