import { buildProgram } from '../../src/index.js'

// Minimal program built via buildProgram, used by the integration test to prove
// the built program runs end-to-end. Run with `node --import tsx`.
const program = buildProgram({ name: 'demo', version: '9.9.9', commands: [] })
program.parse()
