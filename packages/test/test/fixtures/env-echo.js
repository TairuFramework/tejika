// Prints whether the spawned child sees the CI env var — used to prove
// PTYDriver's default env presents an interactive (non-CI) terminal.
process.stdout.write(`CI=[${process.env.CI ?? 'unset'}]\n`)
