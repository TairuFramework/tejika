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

export async function getPort(app: string, opts: { default?: number } = {}): Promise<number> {
  const override = getAppEnvVar(app, 'PORT')
  if (override != null) {
    const port = Number.parseInt(override, 10)
    if (Number.isNaN(port)) {
      throw new Error(`${appEnvVar(app, 'PORT')} is not a valid port number: "${override}"`)
    }
    return port
  }
  return getAvailablePort(opts.default == null ? undefined : { port: opts.default })
}
