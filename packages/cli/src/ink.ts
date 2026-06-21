import { type RenderOptions, render } from 'ink'
import type { ReactElement } from 'react'

/** Render an interactive Ink app and resolve when it exits. */
export async function runInk(element: ReactElement, options: RenderOptions = {}): Promise<void> {
  const app = render(element, { exitOnCtrlC: false, ...options })
  await app.waitUntilExit()
}

/** Render an Ink element once for non-interactive output, then unmount. */
export function renderStatic(element: ReactElement): void {
  const { unmount } = render(element)
  unmount()
}
