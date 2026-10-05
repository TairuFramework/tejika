import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getLogDir } from '@tejika/env'
import { followLog } from '@tejika/log/follow'
import { getDaemonStatus, spawnDaemon, stopDaemon } from '@tejika/process'
import { Command } from 'commander'

import { withPIDPath, withSocketPath } from './options.js'
import { addJSONOption, fail, printJSON } from './output.js'
import { withCommandSignal } from './signal.js'

const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_STOP_KILL_TIMEOUT_MS = 75_000
const DEFAULT_LOG_LINES = 50

export type DaemonIdentity = {
  state: 'not-running' | 'stale' | 'booting' | 'running'
  pid?: number
  /** Set when a daemon is alive but serves another socket than the selected one. */
  otherSocketPath?: string
}

export type DaemonCommandContext = {
  socketPath: string
  pidPath: string
  signal: AbortSignal
}

export type CreateDaemonCommandOptions = {
  /** App name, used to resolve paths and env overrides through `@tejika/env`. */
  app: string
  /** Daemon entry script, run by `spawnDaemon`. */
  entry: string
  /** Extra arguments for the entry script. */
  args?: Array<string>
  description?: string
  /** Budget for the daemon to accept connections after spawn. Default 30000ms. */
  startTimeoutMs?: number
  /** Time a stopping daemon gets to drain before it is SIGKILLed. Default 75000ms. */
  stopKillTimeoutMs?: number
  /**
   * Runs after the daemon accepts connections, for app-level readiness. Throw to fail the start;
   * returned fields are merged into the start output.
   */
  waitReady?: (context: DaemonCommandContext) => Promise<Record<string, unknown> | undefined>
  /** Extra fields for `status` while the daemon is running. A throw is reported as `error`. */
  describeStatus?: (context: DaemonCommandContext) => Promise<Record<string, unknown> | undefined>
}

type CommandOptions = { socketPath: string; pidPath: string; json?: boolean }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Identify the daemon by its pid file, which records the socket path it serves. A daemon serving
 * a different socket than the selected one (compared after `path.resolve`, as `stopDaemon` does)
 * is reported as `not-running` for the selected socket, with the other path named.
 */
export async function resolveDaemonIdentity(
  app: string,
  socketPath: string,
  pidPath: string,
): Promise<DaemonIdentity> {
  const status = await getDaemonStatus({ app, pidPath })
  if (status.state === 'not-running') return { state: 'not-running' }
  if (status.state === 'stale') return { state: 'stale', pid: status.pid }
  if (resolve(status.socketPath) !== resolve(socketPath)) {
    return { state: 'not-running', otherSocketPath: status.socketPath }
  }
  return { state: status.state === 'booting' ? 'booting' : 'running', pid: status.pid }
}

function mismatchMessage(socketPath: string, other: string): string {
  return `The daemon serves ${other}, not the selected socket ${socketPath}`
}

type StartOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string; value?: Record<string, unknown> }

type StopOutcome =
  | { state: 'stopped'; pid?: number; forced: boolean }
  | { state: 'not-running' }
  | { state: 'failed'; message: string }

type StopJSON = { state: 'stopped'; pid?: number; forced: boolean } | { state: 'not-running' }

function stopJSON(stop: StopOutcome & { state: 'stopped' | 'not-running' }): StopJSON {
  if (stop.state === 'not-running') return { state: 'not-running' }
  const json: StopJSON = { state: 'stopped', forced: stop.forced }
  if (stop.pid != null) json.pid = stop.pid
  return json
}

function lastLines(text: string, count: number): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-count).join('\n')
}

/**
 * A `daemon start|stop|status|restart|logs` command group over `@tejika/process`, generic over the
 * app name. Every subcommand takes `--socket-path` and `--pid-path`, both resolved from
 * `@tejika/env` unless given, so a custom path reaches start, stop, status and restart alike.
 */
export function createDaemonCommand(options: CreateDaemonCommandOptions): Command {
  const {
    app,
    entry,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    stopKillTimeoutMs = DEFAULT_STOP_KILL_TIMEOUT_MS,
  } = options

  async function runStart(socketPath: string, pidPath: string): Promise<StartOutcome> {
    return await withCommandSignal(async (signal) => {
      try {
        const identity = await resolveDaemonIdentity(app, socketPath, pidPath)
        if (identity.otherSocketPath != null) {
          return { ok: false, message: mismatchMessage(socketPath, identity.otherSocketPath) }
        }
        if (identity.state !== 'running' && identity.state !== 'booting') {
          await spawnDaemon({
            app,
            entry,
            args: options.args,
            socketPath,
            pidPath,
            timeoutMs: startTimeoutMs,
            signal,
          })
        }
        const current = await resolveDaemonIdentity(app, socketPath, pidPath)
        const value: Record<string, unknown> = { pid: current.pid, socketPath }
        if (options.waitReady != null) {
          try {
            Object.assign(value, await options.waitReady({ socketPath, pidPath, signal }))
          } catch (error) {
            return { ok: false, message: errorMessage(error), value }
          }
        }
        return { ok: true, value }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    })
  }

  function reportStart(outcome: StartOutcome, json: boolean | undefined): void {
    if (json && outcome.value != null) printJSON(outcome.value)
    if (!outcome.ok) {
      fail(outcome.message)
      return
    }
    if (!json) {
      const { pid, socketPath } = outcome.value
      process.stdout.write(`daemon running (pid ${pid ?? 'unknown'})\nsocket: ${socketPath}\n`)
    }
  }

  async function runStop(socketPath: string, pidPath: string): Promise<StopOutcome> {
    return await withCommandSignal(async (signal) => {
      const identity = await resolveDaemonIdentity(app, socketPath, pidPath)
      if (identity.otherSocketPath != null) {
        return { state: 'failed', message: mismatchMessage(socketPath, identity.otherSocketPath) }
      }
      const result = await stopDaemon({
        app,
        pidPath,
        waitForExit: true,
        killTimeoutMs: stopKillTimeoutMs,
        // Checked under the boot mutex: a daemon replaced since the identity read is not signalled.
        expectedSocketPath: socketPath,
        signal,
      })
      if (result.stopped) {
        return { state: 'stopped', pid: result.pid, forced: result.forced === true }
      }
      if (result.reason === 'not-running') return { state: 'not-running' }
      if (result.reason === 'socket-mismatch') {
        const current = await resolveDaemonIdentity(app, socketPath, pidPath)
        return {
          state: 'failed',
          message: mismatchMessage(socketPath, current.otherSocketPath ?? 'another socket'),
        }
      }
      const detail = result.error instanceof Error ? `: ${result.error.message}` : ''
      return {
        state: 'failed',
        message: `Could not stop the daemon (${result.reason ?? 'unknown'})${detail}`,
      }
    })
  }

  function reportStop(stop: StopOutcome, json: boolean | undefined): void {
    if (stop.state === 'failed') {
      fail(stop.message)
      return
    }
    if (json) {
      printJSON(stopJSON(stop))
      return
    }
    const pid = stop.state === 'stopped' && stop.pid != null ? ` (pid ${stop.pid})` : ''
    if (stop.state === 'not-running') {
      process.stdout.write('daemon not running\n')
    } else if (stop.forced) {
      process.stdout.write(`daemon did not exit in time; force-killed${pid}\n`)
    } else {
      process.stdout.write(`daemon stopped${pid}\n`)
    }
  }

  async function runStatus({ socketPath, pidPath, json }: CommandOptions): Promise<void> {
    const identity = await resolveDaemonIdentity(app, socketPath, pidPath)
    const result: Record<string, unknown> = { state: identity.state }
    if (identity.pid != null) result.pid = identity.pid
    if (identity.otherSocketPath != null) result.otherSocketPath = identity.otherSocketPath
    if (identity.state === 'running' || identity.state === 'booting') {
      result.socketPath = socketPath
    }
    const describeStatus = options.describeStatus
    if (identity.state === 'running' && describeStatus != null) {
      try {
        const extra = await withCommandSignal((signal) =>
          describeStatus({ socketPath, pidPath, signal }),
        )
        Object.assign(result, extra)
      } catch (error) {
        result.error = errorMessage(error)
      }
    }
    if (json) {
      printJSON(result)
      return
    }
    const lines = [`${identity.state}${identity.pid == null ? '' : ` (pid ${identity.pid})`}`]
    if (identity.otherSocketPath != null) {
      lines.push(`another daemon serves ${identity.otherSocketPath}`)
    }
    for (const [key, value] of Object.entries(result)) {
      if (['state', 'pid', 'otherSocketPath', 'socketPath', 'error'].includes(key)) continue
      lines.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    }
    if (result.error != null) lines.push(`could not query the daemon: ${result.error}`)
    process.stdout.write(`${lines.join('\n')}\n`)
  }

  async function runLogs(logOptions: { lines: string; follow?: boolean }): Promise<void> {
    const count = Number(logOptions.lines)
    if (!/^\d+$/.test(logOptions.lines) || !Number.isSafeInteger(count)) {
      fail(`Invalid line count "${logOptions.lines}"`)
      return
    }
    const logPath = join(getLogDir(app), 'daemon.log')
    let content: string
    try {
      content = await readFile(logPath, 'utf8')
    } catch (error) {
      fail(`Cannot read ${logPath}: ${errorMessage(error)}`)
      return
    }
    const tail = count === 0 ? '' : lastLines(content, count)
    if (tail !== '') process.stdout.write(`${tail}\n`)
    if (!logOptions.follow) return
    try {
      await withCommandSignal((signal) =>
        followLog(logPath, { signal, start: Buffer.byteLength(content) }),
      )
    } catch (error) {
      fail(`Cannot follow ${logPath}: ${errorMessage(error)}`)
    }
  }

  const daemon = new Command('daemon').description(
    options.description ?? `Manage the ${app} daemon`,
  )

  const withPaths = (cmd: Command): Command =>
    addJSONOption(withPIDPath(withSocketPath(cmd, app), app))

  withPaths(
    daemon.command('start').description('Start the daemon and wait until it is ready'),
  ).action(async (opts: CommandOptions) => {
    reportStart(await runStart(opts.socketPath, opts.pidPath), opts.json)
  })

  withPaths(
    daemon.command('stop').description('Stop the daemon, letting in-flight work drain'),
  ).action(async (opts: CommandOptions) => {
    reportStop(await runStop(opts.socketPath, opts.pidPath), opts.json)
  })

  withPaths(daemon.command('status').description('Show whether the daemon is running')).action(
    runStatus,
  )

  withPaths(daemon.command('restart').description('Stop then start the daemon')).action(
    async (opts: CommandOptions) => {
      const stopped = await runStop(opts.socketPath, opts.pidPath)
      // An absent daemon is fine to start; any other non-stopped outcome (socket mismatch, stop
      // failure) must not start anything.
      if (stopped.state === 'failed') {
        reportStop(stopped, opts.json)
        return
      }
      const started = await runStart(opts.socketPath, opts.pidPath)
      if (!opts.json) {
        reportStop(stopped, false)
        reportStart(started, false)
        return
      }
      if (started.value != null) printJSON({ stop: stopJSON(stopped), start: started.value })
      if (!started.ok) fail(started.message)
    },
  )

  daemon
    .command('logs')
    .description('Print the daemon log')
    .option('-n, --lines <count>', 'number of lines to show', String(DEFAULT_LOG_LINES))
    .option('-f, --follow', 'follow the log until interrupted')
    .action(runLogs)

  return daemon
}
