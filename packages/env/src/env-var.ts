export function appEnvVar(app: string, key: string): string {
  const slug = app.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return `${slug}_${key}`
}

/**
 * Reads an app env override, treating an empty or whitespace-only value as unset.
 *
 * `MYAPP_DATA_DIR= node …` leaves the variable defined as `''`, which would slip
 * past a `?? fallback` (nullish coalescing only catches `null`/`undefined`). This
 * returns `undefined` in that case so callers fall back to their default.
 */
export function getAppEnvVar(app: string, key: string): string | undefined {
  const value = process.env[appEnvVar(app, key)]
  if (value == null) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
