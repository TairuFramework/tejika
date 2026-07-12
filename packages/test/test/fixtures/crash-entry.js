// A daemon entry that dies during boot, before binding its socket. Mirrors
// packages/process/test/fixtures/crash-entry.ts for the cross-process suite.
console.error('boom: could not initialise')
process.exit(3)
