import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { describe, expect, test, vi } from 'vitest'

import { ExitOnAbort } from '../src/ExitOnAbort.js'
import { InterruptOnCtrlC } from '../src/InterruptOnCtrlC.js'

describe('ExitOnAbort', () => {
  test('renders children while the signal is live', () => {
    const controller = new AbortController()
    const { lastFrame } = render(
      <ExitOnAbort signal={controller.signal}>
        <Text>prompt</Text>
      </ExitOnAbort>,
    )
    expect(lastFrame()).toContain('prompt')
  })

  test('exits the app when the signal aborts', async () => {
    const controller = new AbortController()
    const instance = render(
      <ExitOnAbort signal={controller.signal}>
        <Text>prompt</Text>
      </ExitOnAbort>,
    )
    controller.abort()
    await vi.waitFor(() => expect(instance.lastFrame()).toBeDefined())
    // After exit, further rerenders no longer update the frame.
    instance.rerender(<Text>changed</Text>)
    await new Promise((r) => setTimeout(r, 50))
    expect(instance.lastFrame()).not.toContain('changed')
  })

  test('exits at once for an already-aborted signal', async () => {
    const instance = render(
      <ExitOnAbort signal={AbortSignal.abort()}>
        <Text>prompt</Text>
      </ExitOnAbort>,
    )
    await new Promise((r) => setTimeout(r, 50))
    instance.rerender(<Text>changed</Text>)
    await new Promise((r) => setTimeout(r, 50))
    expect(instance.lastFrame()).not.toContain('changed')
  })
})

describe('InterruptOnCtrlC', () => {
  test('calls onInterrupt on Ctrl+C only', async () => {
    const onInterrupt = vi.fn()
    const { stdin } = render(
      <InterruptOnCtrlC onInterrupt={onInterrupt}>
        <Text>prompt</Text>
      </InterruptOnCtrlC>,
    )
    await new Promise((r) => setTimeout(r, 20))
    stdin.write('a')
    await new Promise((r) => setTimeout(r, 20))
    expect(onInterrupt).not.toHaveBeenCalled()
    stdin.write('\x03')
    await vi.waitFor(() => expect(onInterrupt).toHaveBeenCalledTimes(1))
  })
})
