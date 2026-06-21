import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import stripAnsi from 'strip-ansi'
import { expect, test } from 'vitest'

const run = promisify(execFile)
const entry = fileURLToPath(new URL('./fixtures/cli-program.ts', import.meta.url))

// A program built via buildProgram runs as a real process and reports its
// version. The fixture is run through tsx so no build step is needed; output is
// ANSI-stripped before asserting (strip-ansi CLI test pattern, without a
// pseudo-TTY since `--version` is non-interactive).
test('buildProgram produces a runnable program that reports --version', {
  timeout: 30_000,
}, async () => {
  const { stdout } = await run('node', ['--import', 'tsx', entry, '--version'])
  expect(stripAnsi(stdout).trim()).toBe('9.9.9')
})
