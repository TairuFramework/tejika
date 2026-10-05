import { type FSWatcher, watch } from 'node:fs'
import { open, stat } from 'node:fs/promises'

export type FollowLogOptions = {
  /** Stops following. `followLog` resolves once the in-flight read finishes. */
  signal: AbortSignal
  /** Byte offset to start reading from. Default: the current end of the file. */
  start?: number
  /** Receives each appended chunk. Default: write to `process.stdout`. */
  onData?: (chunk: Buffer) => void
  /** Fallback poll interval, covering platforms where `fs.watch` misses appends. Default 1000ms. */
  pollIntervalMs?: number
}

/**
 * Tail a log file until `signal` aborts. A file that shrinks (truncated or rotated) is re-read
 * from the start. Rejects if the file cannot be watched or read, e.g. it was removed.
 */
export async function followLog(path: string, options: FollowLogOptions): Promise<void> {
  const { signal, onData = (chunk) => process.stdout.write(chunk), pollIntervalMs = 1000 } = options
  let offset = options.start ?? (await stat(path)).size
  let reading = Promise.resolve()
  let failure: unknown
  let wake: (() => void) | undefined
  const readMore = async () => {
    const size = (await stat(path)).size
    if (size < offset) offset = 0
    if (size === offset) return
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(size - offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      offset += bytesRead
      onData(buffer.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  }
  const stopWith = (error: unknown) => {
    failure ??= error
    wake?.()
  }
  const schedule = () => {
    reading = reading.then(readMore).catch(stopWith)
  }
  let watcher: FSWatcher | undefined
  let timer: NodeJS.Timeout | undefined
  const onAbort = () => wake?.()
  try {
    watcher = watch(path, schedule)
    watcher.on('error', stopWith)
    timer = setInterval(schedule, pollIntervalMs)
    await new Promise<void>((resolve) => {
      wake = resolve
      if (signal.aborted || failure != null) return resolve()
      signal.addEventListener('abort', onAbort, { once: true })
    })
  } finally {
    clearInterval(timer)
    signal.removeEventListener('abort', onAbort)
    watcher?.close()
    await reading
  }
  if (failure != null) throw failure
}
