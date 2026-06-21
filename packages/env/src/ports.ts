import getAvailablePort from 'get-port'
import { appEnvVar, getAppEnvVar } from './env-var.js'

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
