import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * vitest globalSetup guard: a spawned binary imports workspace deps from their
 * built `lib/` on disk — vitest's module resolution does not help a real
 * subprocess. Throws one error listing every package that does not resolve.
 * Pass `import.meta.url` as `from` to resolve from the calling file.
 */
export function assertBuilt(packages: Array<string>, from?: string): void {
  const require = createRequire(from ?? join(process.cwd(), 'noop.js'))
  const missing = packages.filter((pkg) => {
    try {
      require.resolve(pkg)
      return false
    } catch {
      return true
    }
  })
  if (missing.length > 0) {
    throw new Error(`Not built: ${missing.join(', ')} — run \`pnpm build\` first`)
  }
}

/**
 * Rebuild the package under test (fast swc `build:js` by default) so the
 * binary a test spawns is always current. For vitest globalSetup.
 */
export function rebuild(dir: string, script = 'build:js'): void {
  execSync(`pnpm run ${script}`, { cwd: dir, stdio: 'inherit' })
}
