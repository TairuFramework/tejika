import { fileURLToPath } from 'node:url'
import { PTYDriver } from '@tejika/test'
import { test as baseTest, expect } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/ink-app.js', import.meta.url))
const staticFixture = fileURLToPath(new URL('./fixtures/ink-static.js', import.meta.url))

// Skipped on Windows: node-pty's conpty backend spawns a `conpty_console_list`
// helper that throws an uncaught "AttachConsole failed" on the Windows Server
// 2025 runner, crashing the whole vitest worker (an upstream node-pty/conpty
// bug, not our code). The PTY path stays covered on macOS and Linux.
const test = baseTest.skipIf(process.platform === 'win32')

// runInk needs a real TTY (Ink calls setRawMode); PTYDriver provides one.
test('runInk renders and handles input under a real PTY', { timeout: 30_000 }, async () => {
  using driver = new PTYDriver({ args: [fixture] })
  expect(await driver.waitFor('last:none')).toBe(true)
  driver.write('a')
  expect(await driver.waitFor('last:a')).toBe(true)
  driver.enter()
  expect(await driver.waitFor('last:enter')).toBe(true)
  driver.write('q')
  const exit = await driver.waitForExit()
  expect(exit?.exitCode).toBe(0)
})

test('runInk exits on Ctrl+C by default', { timeout: 30_000 }, async () => {
  using driver = new PTYDriver({ args: [fixture] })
  expect(await driver.waitFor('last:none')).toBe(true)
  driver.ctrlC()
  const exit = await driver.waitForExit()
  expect(exit?.exitCode).toBe(0)
})

test('renderStatic prints one frame and exits', { timeout: 30_000 }, async () => {
  using driver = new PTYDriver({ args: [staticFixture] })
  expect(await driver.waitFor('static:done')).toBe(true)
  const exit = await driver.waitForExit()
  expect(exit?.exitCode).toBe(0)
})
