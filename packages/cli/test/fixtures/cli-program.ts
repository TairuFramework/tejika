import { buildProgram } from '../../src/index.js'

// Minimal program built via buildProgram, used by the integration test to prove the
// built program runs end-to-end. Run with `node --import tsx`.
//
// parseAsync, not parse: the option builders register async preAction hooks. Commander
// chains the action after the hook's promise under parse() and parseAsync() alike, so
// the action sees the resolved default either way. The hazard is parse() itself: it is
// fire-and-forget and returns before the hook and action have run, so code after it
// observes nothing yet, and a rejection surfaces as an unhandled rejection instead of
// propagating to the caller.
const program = buildProgram({ name: 'demo', version: '9.9.9', commands: [] })
await program.parseAsync()
