import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertBuilt, rebuild } from '../src/setup.js'

describe('assertBuilt', () => {
  test('passes for resolvable packages', () => {
    expect(() => assertBuilt(['vitest'], import.meta.url)).not.toThrow()
  })

  test('throws listing every missing package', () => {
    expect(() =>
      assertBuilt(['@tejika/definitely-missing', 'also-missing-xyz'], import.meta.url),
    ).toThrow(/@tejika\/definitely-missing, also-missing-xyz.*pnpm build/s)
  })
})

describe('rebuild', () => {
  test('runs the package build script in the given dir', () => {
    const dir = join(tmpdir(), `tejika-rebuild-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'rebuild-fixture',
        private: true,
        scripts: { 'build:js': "node -e \"require('node:fs').writeFileSync('out.txt', 'ok')\"" },
      }),
    )
    rebuild(dir)
    expect(existsSync(join(dir, 'out.txt'))).toBe(true)
  })
})
