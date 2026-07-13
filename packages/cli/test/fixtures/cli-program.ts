import { buildProgram } from '../../src/index.js'

// Minimal program built via buildProgram, used by the integration test to prove the
// built program runs end-to-end. Run with `node --import tsx`.
//
// parseAsync, not parse: the option builders register async preAction hooks, and
// commander only awaits hooks under parseAsync. Under the sync parse() the hook is
// fire-and-forget — the action runs before the awaited default is set.
const program = buildProgram({ name: 'demo', version: '9.9.9', commands: [] })
await program.parseAsync()
