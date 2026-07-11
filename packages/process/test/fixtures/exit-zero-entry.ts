// A daemon entry that exits CLEANLY during boot, without ever binding a socket.
// nano-spawn resolves on a zero exit, so this drives `spawnDaemon`'s fulfilled
// branch — the one a crashing entry (exit 3) never reaches.
console.error('exiting cleanly without binding')
process.exit(0)
