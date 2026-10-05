import { describe, expect, test, vi } from 'vitest'

import { CLITimeoutError, runCLI, spawnCLI } from '../src/run.js'

describe('runCLI', () => {
  test('collects stdout, stderr, and the exit code', async () => {
    const result = await runCLI(['-e', 'console.log("out"); console.error("err"); process.exit(2)'])
    expect(result.stdout).toBe('out\n')
    expect(result.stderr).toBe('err\n')
    expect(result.code).toBe(2)
  })

  test('resolves instead of rejecting when the command cannot spawn', async () => {
    const result = await runCLI(['--version'], { command: 'definitely-not-a-command-xyz' })
    expect(result.code).toBeNull()
    expect(result.stderr).toContain('ENOENT')
  })

  test('passes env to the child', async () => {
    const result = await runCLI(['-e', 'console.log(process.env.TEJIKA_TEST_MARKER)'], {
      env: { ...process.env, TEJIKA_TEST_MARKER: 'marked' },
    })
    expect(result.stdout).toBe('marked\n')
  })

  test('pipes input to stdin and closes it', async () => {
    const result = await runCLI(['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'echoed',
    })
    expect(result.stdout).toBe('echoed')
    expect(result.code).toBe(0)
  })

  test('does not crash when the child exits before draining a large stdin', async () => {
    const result = await runCLI(['-e', 'process.exit(0)'], { input: 'x'.repeat(5 * 1024 * 1024) })
    expect(result.code).toBe(0)
  })

  test('timeoutMs kills the child and rejects with the output so far', async () => {
    const started = Date.now()
    const error = await runCLI(['-e', 'console.log("started"); setInterval(() => {}, 1000)'], {
      timeoutMs: 500,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CLITimeoutError)
    expect((error as CLITimeoutError).stdout).toContain('started')
    expect((error as CLITimeoutError).message).toContain('timed out after 500ms')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('timeoutMs does not fire for a run that finishes in time', async () => {
    const result = await runCLI(['-e', 'console.log("ok")'], { timeoutMs: 10_000 })
    expect(result.stdout).toBe('ok\n')
  })
})

describe('spawnCLI', () => {
  test('exposes output while running, accepts a signal, and settles on exit', async () => {
    const spawned = spawnCLI([
      '-e',
      'console.log("ready"); process.on("SIGTERM", () => { console.log("bye"); process.exit(3) }); setInterval(() => {}, 1000)',
    ])
    await vi.waitFor(() => expect(spawned.stdout()).toContain('ready'), { timeout: 5_000 })
    spawned.child.kill('SIGTERM')
    const result = await spawned.done
    expect(result.stdout).toBe('ready\nbye\n')
    expect(result.code).toBe(3)
  })

  test('a timeout does not raise an unhandled rejection when done is never awaited', async () => {
    const spawned = spawnCLI(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 })
    await new Promise((r) => setTimeout(r, 600))
    expect(spawned.child.killed).toBe(true)
  })
})
