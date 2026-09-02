import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { PTYDriver } from '../src/pty.js'

const fixture = fileURLToPath(new URL('./fixtures/pty-app.js', import.meta.url))

const createDriver = () => new PTYDriver({ args: [fixture] })

describe('PTYDriver', () => {
  test('waitFor sees output with ANSI stripped', async () => {
    using driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    expect(driver.screen()).toContain('ready')
    expect(driver.screen()).not.toContain('\u001b')
  })

  test('type + enter round-trips through the fixture', async () => {
    using driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    await driver.type('abc')
    driver.enter()
    expect(await driver.waitFor('submitted:abc')).toBe(true)
  })

  test('windowed reads only match output after the mark', async () => {
    using driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    const since = driver.mark()
    expect(driver.screenSince(since)).not.toContain('ready')
    driver.down()
    expect(await driver.waitForSince('down-arrow', since)).toBe(true)
  })

  test('screenAfterLast isolates the window from the last marker', async () => {
    using driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    await driver.type('one')
    driver.enter()
    expect(await driver.waitFor('submitted:one')).toBe(true)
    await driver.type('two')
    driver.enter()
    expect(await driver.waitForAfterLast('submitted:', 'two')).toBe(true)
    expect(driver.screenAfterLast('submitted:')).not.toContain('one')
  })

  test('ctrlC interrupts without killing; q exits cleanly', async () => {
    using driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    driver.ctrlC()
    expect(await driver.waitFor('interrupted')).toBe(true)
    expect(await driver.waitForExit(300)).toBeNull()
    driver.write('q')
    const exit = await driver.waitForExit(8_000)
    expect(exit?.exitCode).toBe(0)
  })

  test('kill after exit is tolerated', async () => {
    const driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    driver.write('q')
    expect(await driver.waitForExit(8_000)).not.toBeNull()
    expect(() => driver.kill()).not.toThrow()
  })
})
