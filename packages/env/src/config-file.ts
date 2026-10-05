import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Expand a leading `~` or `~/…` (also `~\…`) to the home directory. Other paths are returned as-is. */
export function expandHome(path: string): string {
  if (path === '~') {
    return homedir()
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2))
  }
  return path
}

export type ReadJSONFileOptions<T> = {
  /** Value returned when the file does not exist (`ENOENT`). Without it, a missing file throws. */
  default?: T
}

/**
 * Read and parse a JSON file. Returns `options.default` on `ENOENT` when provided; any other
 * read or parse failure throws an error naming the path (the original error is the `cause`).
 * Schema validation stays with the caller.
 */
export async function readJSONFile<T = unknown>(
  path: string,
  options: ReadJSONFileOptions<T> = {},
): Promise<T> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && 'default' in options) {
      return options.default as T
    }
    throw new Error(`failed to read ${path}: ${(cause as Error).message}`, { cause })
  }
  try {
    return JSON.parse(content) as T
  } catch (cause) {
    throw new Error(`failed to parse JSON in ${path}: ${(cause as Error).message}`, { cause })
  }
}
