// A daemon entry that dies during boot, before binding its socket.
console.error('boom: could not initialise')
process.exit(3)
