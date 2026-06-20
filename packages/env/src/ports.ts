import getAvailablePort from 'get-port'
import { appEnvVar } from './env-var.js'

export async function getPort(app: string, opts: { default?: number } = {}): Promise<number> {
  const override = process.env[appEnvVar(app, 'PORT')]
  if (override != null) return Number.parseInt(override, 10)
  return getAvailablePort(opts.default == null ? undefined : { port: opts.default })
}
