export function appEnvVar(app: string, key: string): string {
  const slug = app.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return `${slug}_${key}`
}
