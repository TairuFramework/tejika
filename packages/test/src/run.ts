import { type ChildProcess, spawn } from 'node:child_process'

export type RunCLIOptions = {
  command?: string
  env?: Record<string, string | undefined>
  cwd?: string
  input?: string
  signal?: AbortSignal
  /** Kill the child with `SIGKILL` and fail with a `CLITimeoutError` after this many ms. */
  timeoutMs?: number
}

export type SpawnCLIOptions = RunCLIOptions

export type CLIResult = { stdout: string; stderr: string; code: number | null }

export type SpawnedCLI = {
  child: ChildProcess
  /** Output collected so far; read it while the process runs. */
  stdout: () => string
  stderr: () => string
  /**
   * Settles when the child closes. Resolves like `runCLI`; rejects with a `CLITimeoutError`
   * when `timeoutMs` fires first.
   */
  done: Promise<CLIResult>
}

/** Thrown by `done` / `runCLI` on timeout, carrying the output collected so far. */
export class CLITimeoutError extends Error {
  #stdout: string
  #stderr: string

  constructor(command: string, args: Array<string>, timeoutMs: number, output: CLIResult) {
    super(
      `${[command, ...args].join(' ')} timed out after ${timeoutMs}ms\n` +
        `--- stdout ---\n${output.stdout}\n--- stderr ---\n${output.stderr}`,
    )
    this.name = 'CLITimeoutError'
    this.#stdout = output.stdout
    this.#stderr = output.stderr
  }

  get stdout(): string {
    return this.#stdout
  }

  get stderr(): string {
    return this.#stderr
  }
}

/**
 * Spawn a CLI and expose its output while it runs, e.g. to wait for a line before sending
 * input or a signal. A spawn failure (e.g. ENOENT) resolves `done` with the error message
 * appended to `stderr` and `code: null`, instead of hanging until the test timeout.
 */
export function spawnCLI(args: Array<string>, options: SpawnCLIOptions = {}): SpawnedCLI {
  const command = options.command ?? 'node'
  const child = spawn(command, args, {
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
  const done = new Promise<CLIResult>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    if (options.timeoutMs != null) {
      const timeoutMs = options.timeoutMs
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new CLITimeoutError(command, args, timeoutMs, { stdout, stderr, code: null }))
      }, timeoutMs)
    }
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout, stderr: stderr + err.message, code: null })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
  // `done` may never be awaited when a test only reads `stdout()`; avoid an unhandled rejection.
  done.catch(() => {})
  if (options.input != null) {
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input)
  }
  return { child, stdout: () => stdout, stderr: () => stderr, done }
}

/**
 * Run a non-interactive CLI command to completion and collect its output.
 * Resolves on spawn failure (see `spawnCLI`); rejects with a `CLITimeoutError` only when
 * `timeoutMs` is set and fires.
 */
export function runCLI(args: Array<string>, options: RunCLIOptions = {}): Promise<CLIResult> {
  return spawnCLI(args, options).done
}
