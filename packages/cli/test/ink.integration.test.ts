import { fileURLToPath } from 'node:url'
import { PTYDriver } from '@tejika/test'
import { expect, test } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/ink-app.js', import.meta.url))
const staticFixture = fileURLToPath(new URL('./fixtures/ink-static.js', import.meta.url))

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
