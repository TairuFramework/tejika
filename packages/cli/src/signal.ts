/**
 * Run `work` with a signal that `SIGINT` or `SIGTERM` aborts. The listeners are removed once
 * `work` settles, so the process regains its default signal behaviour.
 */
export async function withCommandSignal<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    return await work(controller.signal)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
