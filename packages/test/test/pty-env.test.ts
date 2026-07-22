import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { PTYDriver } from '../src/pty.js'

const echo = fileURLToPath(new URL('./fixtures/env-echo.js', import.meta.url))

let previousCI: string | undefined
beforeEach(() => {
  previousCI = process.env.CI
  process.env.CI = 'true'
})
afterEach(() => {
  if (previousCI === undefined) delete process.env.CI
  else process.env.CI = previousCI
})

// Regression: a PTY presents a real interactive terminal, so the child must not
// look like CI. ci-info-based tools (Ink, etc.) switch to buffered
// non-interactive rendering when CI is set and never flush frames to the PTY —
// which silently timed out the cli Ink integration test under GitHub Actions.
test('default env strips CI so ci-info tools stay interactive', async () => {
  using driver = new PTYDriver({ args: [echo] })
  await driver.waitForExit()
  expect(driver.screen()).toContain('CI=[unset]')
})

test('an explicit env is forwarded verbatim (caller controls CI)', async () => {
  using driver = new PTYDriver({
    args: [echo],
    env: { ...process.env, CI: 'true' } as Record<string, string>,
  })
  await driver.waitForExit()
  expect(driver.screen()).toContain('CI=[true]')
})
