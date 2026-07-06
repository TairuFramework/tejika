import { assertBuilt } from '../src/setup.js'

// src/daemon.ts and the daemon integration fixture import these packages'
// built lib/ — fail fast with a clear message instead of a resolve error.
export default function setup(): void {
  assertBuilt(['@tejika/env', '@tejika/process'], import.meta.url)
}
