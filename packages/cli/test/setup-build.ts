import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rebuild } from '@tejika/test'

// test -> packages/cli
const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The PTY fixture imports `../../lib/index.js` — a real subprocess needs the
// built output on disk, and this keeps it current (fast swc, no tsc).
export default function setup(): void {
  rebuild(CLI_DIR)
}
