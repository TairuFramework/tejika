import { spawn } from 'node:child_process'

export type RunCLIOptions = {
  command?: string
  env?: Record<string, string | undefined>
  cwd?: string
  input?: string
  signal?: AbortSignal
}

export type CLIResult = { stdout: string; stderr: string; code: number | null }

/**
 * Run a non-interactive CLI command to completion and collect its output.
 * Never rejects: a spawn failure (e.g. ENOENT) resolves immediately with the
 * error message appended to `stderr` and `code: null`, instead of hanging
 * until the test timeout.
 */
export function runCLI(args: Array<string>, options: RunCLIOptions = {}): Promise<CLIResult> {
  return new Promise((resolve) => {
    const child = spawn(options.command ?? 'node', args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    child.on('error', (err) => resolve({ stdout, stderr: stderr + err.message, code: null }))
    child.on('close', (code) => resolve({ stdout, stderr, code }))
    if (options.input != null) {
      child.stdin?.end(options.input)
    }
  })
}
