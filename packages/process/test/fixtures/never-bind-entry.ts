// Bound the fixture lifetime even if the parent fails before receiving the handle.
setTimeout(() => process.exit(0), 10_000)
