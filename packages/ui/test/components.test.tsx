import { render } from 'ink-testing-library'
import { act } from 'react'
import { describe, expect, test, vi } from 'vitest'

import { ConfirmCard } from '../src/ConfirmCard.js'
import { Footer } from '../src/Footer.js'
import { IconLine } from '../src/IconLine.js'
import { KeyHints } from '../src/KeyHints.js'
import { SelectCard } from '../src/SelectCard.js'
import { Spinner } from '../src/Spinner.js'
import { SystemNotice } from '../src/SystemNotice.js'

const noop = (): void => {}

describe('IconLine', () => {
  test('renders the icon and child text', () => {
    const { lastFrame } = render(
      <IconLine icon="*" color="blue">
        hello
      </IconLine>,
    )
    expect(lastFrame()).toContain('*')
    expect(lastFrame()).toContain('hello')
  })
})

describe('SystemNotice', () => {
  test('renders the notice text', () => {
    const { lastFrame } = render(<SystemNotice variant="error" text="boom" />)
    expect(lastFrame()).toContain('boom')
  })
})

describe('ConfirmCard', () => {
  test('renders the confirmation message', () => {
    const { lastFrame } = render(
      <ConfirmCard message="proceed?" onConfirm={noop} onCancel={noop} />,
    )
    expect(lastFrame()).toContain('proceed?')
  })

  test('y confirms', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={onConfirm} onCancel={onCancel} />)
    act(() => stdin.write('y'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  test('enter confirms', () => {
    const onConfirm = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={onConfirm} onCancel={vi.fn()} />)
    act(() => stdin.write('\r'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('n cancels', () => {
    const onCancel = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={vi.fn()} onCancel={onCancel} />)
    act(() => stdin.write('n'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('esc cancels', () => {
    vi.useFakeTimers()
    const onCancel = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={vi.fn()} onCancel={onCancel} />)
    stdin.write('\x1b')
    vi.runAllTimers()
    expect(onCancel).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('shared latch: y then y confirms once', () => {
    const onConfirm = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={onConfirm} onCancel={vi.fn()} />)
    act(() => stdin.write('y'))
    act(() => stdin.write('y'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('shared latch: y then esc confirms once, never cancels', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(<ConfirmCard message="?" onConfirm={onConfirm} onCancel={onCancel} />)
    act(() => stdin.write('y'))
    stdin.write('\x1b')
    vi.runAllTimers()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  test('isActive={false} ignores all keys', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(
      <ConfirmCard message="?" isActive={false} onConfirm={onConfirm} onCancel={onCancel} />,
    )
    act(() => stdin.write('y'))
    act(() => stdin.write('n'))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  test('a rejecting onConfirm does not raise an unhandled rejection', async () => {
    const onRejection = vi.fn()
    process.on('unhandledRejection', onRejection)
    const { stdin } = render(
      <ConfirmCard
        message="?"
        onConfirm={() => Promise.reject(new Error('boom'))}
        onCancel={vi.fn()}
      />,
    )
    act(() => stdin.write('y'))
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', onRejection)
    expect(onRejection).not.toHaveBeenCalled()
  })

  test('a synchronous throw from onCancel does not escape the handler', () => {
    const { stdin, lastFrame } = render(
      <ConfirmCard
        message="alive"
        onConfirm={vi.fn()}
        onCancel={() => {
          throw new Error('boom')
        }}
      />,
    )
    expect(() => act(() => stdin.write('n'))).not.toThrow()
    expect(lastFrame()).toContain('alive')
  })
})

describe('SelectCard', () => {
  test('renders item labels', () => {
    const { lastFrame } = render(
      <SelectCard
        title="pick one"
        items={[
          { label: 'alpha', value: 'a' },
          { label: 'beta', value: 'b' },
        ]}
        onSelect={noop}
      />,
    )
    expect(lastFrame()).toContain('pick one')
    expect(lastFrame()).toContain('alpha')
  })

  test('renders the empty message when there are no items', () => {
    const { lastFrame } = render(
      <SelectCard items={[]} onSelect={noop} emptyMessage="nothing here" />,
    )
    expect(lastFrame()).toContain('nothing here')
  })
})

describe('Spinner', () => {
  test('renders the label and elapsed seconds', () => {
    const { lastFrame } = render(<Spinner label="loading" elapsedMs={3000} />)
    expect(lastFrame()).toContain('loading')
    expect(lastFrame()).toContain('(3s)')
  })
})

describe('KeyHints', () => {
  test('renders each hint as [keys] label', () => {
    const { lastFrame } = render(
      <KeyHints
        hints={[
          { keys: 'esc', label: 'cancel' },
          { keys: 'enter', label: 'confirm' },
        ]}
      />,
    )
    expect(lastFrame()).toContain('[esc] cancel')
    expect(lastFrame()).toContain('[enter] confirm')
  })
})

describe('Footer', () => {
  test('renders its children', () => {
    const { lastFrame } = render(
      <Footer>
        <KeyHints hints={[{ keys: 'q', label: 'quit' }]} />
      </Footer>,
    )
    expect(lastFrame()).toContain('[q] quit')
  })
})
