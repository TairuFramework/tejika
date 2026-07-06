import { describe, expect, test } from 'vitest'
import { runCLI } from '../src/run.js'

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
})
