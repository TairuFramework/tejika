import getAvailablePort from 'get-port'
import { appEnvVar, getAppEnvVar } from './env-var.js'

const MIN_PORT = 1
const MAX_PORT = 65535

function invalidPort(value: string | number, label?: string): Error {
  return new Error(
    label == null
      ? `Invalid port number: "${value}"`
      : `${label} is not a valid port number: "${value}"`,
  )
}

/**
 * Parse a port from a string, rejecting anything that is not an integer in
 * 1..65535. `Number.parseInt` is deliberately not used: it accepts `'80abc'`,
 * `'80.5'` and `'0x50'`. Port `0` is rejected too — it means "any port" to the
 * OS, so accepting it would silently defeat a pinned port.
 */
export function parsePort(value: string, label?: string): number {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw invalidPort(value, label)
  }
  return assertPort(Number(trimmed), label, value)
}

/** Range-check a port that is already a number. Module-private. */
function assertPort(port: number, label?: string, raw: string | number = port): number {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw invalidPort(raw, label)
  }
  return port
}

export type GetPortOptions = {
  /** Preferred port. If it is taken, a different free port is returned. */
  default?: number
  /** Host to probe for availability. */
  host?: string
}

/**
 * Resolve a port for a server to listen on. The env override wins; otherwise a
 * free port is found, preferring `opts.default`.
 *
 * NOTE: when `opts.default` is already taken this returns a DIFFERENT port. Use
 * `resolvePort` for a client that must dial a known port — probing would see the
 * server holding it and hand back a port nothing is listening on.
 */
export async function getPort(app: string, opts: GetPortOptions = {}): Promise<number> {
  const override = getAppEnvVar(app, 'PORT')
  if (override != null) {
    return parsePort(override, appEnvVar(app, 'PORT'))
  }
  if (opts.default != null) {
    assertPort(opts.default)
  }
  return getAvailablePort({ port: opts.default, host: opts.host })
}

/**
 * Resolve a known port without probing: the env override if set, otherwise
 * `defaultPort` verbatim. Synchronous and I/O-free — this is the client-side
 * counterpart of `getPort`.
 */
export function resolvePort(app: string, defaultPort: number): number {
  const override = getAppEnvVar(app, 'PORT')
  if (override != null) {
    return parsePort(override, appEnvVar(app, 'PORT'))
  }
  return assertPort(defaultPort)
}
