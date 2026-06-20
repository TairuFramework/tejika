import { Command } from 'commander'

export type BuildProgramOptions = {
  name: string
  version: string
  commands: Array<Command>
}

/**
 * Build a commander program: sets name/version, enables positional options, and
 * prints full help after a usage error. Each added subcommand inherits the
 * error-help behaviour explicitly (`addCommand` does not copy it).
 */
export function buildProgram(opts: BuildProgramOptions): Command {
  const program = new Command()
    .name(opts.name)
    .version(opts.version, '-v, --version')
    .enablePositionalOptions()
    .showHelpAfterError()

  for (const command of opts.commands) {
    program.addCommand(command)
    command.showHelpAfterError()
  }

  return program
}
