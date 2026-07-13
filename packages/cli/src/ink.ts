import { type RenderOptions, render } from 'ink'
import type { ReactElement } from 'react'

/**
 * Render an interactive Ink app and resolve when it exits.
 *
 * Ink's defaults apply, including `exitOnCtrlC: true` — an app that wants to
 * intercept Ctrl+C must pass `{ exitOnCtrlC: false }` and then take on the duty of
 * exiting, because Ink's raw mode swallows SIGINT.
 */
export async function runInk(element: ReactElement, options: RenderOptions = {}): Promise<void> {
  const app = render(element, options)
  await app.waitUntilExit()
}

/** Render an Ink element once for non-interactive output, then unmount. */
export function renderStatic(element: ReactElement): void {
  const { unmount } = render(element)
  unmount()
}
