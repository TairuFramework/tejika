import { Box } from 'ink'
import { render } from 'ink-testing-library'
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ConfirmCard } from '../src/ConfirmCard.js'
import { Footer } from '../src/Footer.js'
import { IconLine } from '../src/IconLine.js'
import { KeyHints } from '../src/KeyHints.js'
import { SelectCard } from '../src/SelectCard.js'
import { Spinner } from '../src/Spinner.js'
import { SystemNotice } from '../src/SystemNotice.js'

const noop = (): void => {}

// Failure-safe restore: if an assertion between vi.useFakeTimers() and
// vi.useRealTimers() throws, this prevents fake timers from leaking into
// later tests. Safe to call when real timers are already active.
afterEach(() => {
  vi.useRealTimers()
})

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

  test('a rejecting onCancel does not raise an unhandled rejection', async () => {
    const onRejection = vi.fn()
    process.on('unhandledRejection', onRejection)
    const { stdin } = render(
      <ConfirmCard
        message="?"
        onConfirm={vi.fn()}
        onCancel={() => Promise.reject(new Error('boom'))}
      />,
    )
    act(() => stdin.write('n'))
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', onRejection)
    expect(onRejection).not.toHaveBeenCalled()
  })

  test('a synchronous throw from onConfirm does not escape the handler', () => {
    const { stdin, lastFrame } = render(
      <ConfirmCard
        message="alive"
        onConfirm={() => {
          throw new Error('boom')
        }}
        onCancel={vi.fn()}
      />,
    )
    expect(() => act(() => stdin.write('y'))).not.toThrow()
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

  test('enter selects the highlighted item', () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      <SelectCard
        items={[
          { label: 'alpha', value: 'a' },
          { label: 'beta', value: 'b' },
        ]}
        onSelect={onSelect}
      />,
    )
    act(() => stdin.write('\r'))
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  test('arrow-down then enter selects the second item', () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      <SelectCard
        items={[
          { label: 'alpha', value: 'a' },
          { label: 'beta', value: 'b' },
        ]}
        onSelect={onSelect}
      />,
    )
    act(() => stdin.write('\x1b[B'))
    act(() => stdin.write('\r'))
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  test('a non-string generic value round-trips through onSelect', () => {
    const onSelect = vi.fn<(value: number) => void>()
    const { stdin } = render(
      <SelectCard
        items={[
          { label: 'one', value: 1 },
          { label: 'two', value: 2 },
        ]}
        onSelect={onSelect}
      />,
    )
    act(() => stdin.write('\x1b[B'))
    act(() => stdin.write('\r'))
    expect(onSelect).toHaveBeenCalledWith(2)
  })

  test('esc cancels when onCancel is provided', () => {
    vi.useFakeTimers()
    const onCancel = vi.fn()
    const { stdin } = render(
      <SelectCard items={[{ label: 'a', value: 'a' }]} onSelect={noop} onCancel={onCancel} />,
    )
    stdin.write('\x1b')
    vi.runAllTimers()
    expect(onCancel).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('isActive={false} does not select on enter', () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      <SelectCard isActive={false} items={[{ label: 'a', value: 'a' }]} onSelect={onSelect} />,
    )
    act(() => stdin.write('\r'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('esc is a no-op when onCancel is absent', () => {
    vi.useFakeTimers()
    const onSelect = vi.fn()
    const { stdin } = render(
      <SelectCard
        items={[
          { label: 'alpha', value: 'a' },
          { label: 'beta', value: 'b' },
        ]}
        onSelect={onSelect}
      />,
    )
    expect(() => {
      stdin.write('\x1b')
      vi.runAllTimers()
    }).not.toThrow()
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('input isolation (H8)', () => {
  test('active ConfirmCard + inactive SelectCard: enter confirms only', () => {
    const onConfirm = vi.fn()
    const onSelect = vi.fn()
    const { stdin } = render(
      <>
        <ConfirmCard message="?" isActive onConfirm={onConfirm} onCancel={noop} />
        <SelectCard isActive={false} items={[{ label: 'a', value: 'a' }]} onSelect={onSelect} />
      </>,
    )
    act(() => stdin.write('\r'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('inactive ConfirmCard + active SelectCard: arrow+enter selects only', () => {
    const onConfirm = vi.fn()
    const onSelect = vi.fn()
    const { stdin } = render(
      <>
        <ConfirmCard message="?" isActive={false} onConfirm={onConfirm} onCancel={noop} />
        <SelectCard
          isActive
          items={[
            { label: 'alpha', value: 'a' },
            { label: 'beta', value: 'b' },
          ]}
          onSelect={onSelect}
        />
      </>,
    )
    act(() => stdin.write('\x1b[B'))
    act(() => stdin.write('\r'))
    expect(onSelect).toHaveBeenCalledWith('b')
    expect(onConfirm).not.toHaveBeenCalled()
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

describe('SystemNotice icon', () => {
  test('info notice uses an ascii "i", not the ambiguous-width glyph', () => {
    const { lastFrame } = render(<SystemNotice variant="info" text="heads up" />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('heads up')
    expect(frame).not.toContain('ℹ')
    expect(frame).toContain('i')
  })
})

describe('KeyHints layout', () => {
  test('renders each hint even when width is tight', () => {
    const { lastFrame } = render(
      <Box width={16}>
        <KeyHints
          hints={[
            { keys: 'esc', label: 'cancel' },
            { keys: 'enter', label: 'confirm' },
          ]}
        />
      </Box>,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[esc] cancel')
    expect(frame).toContain('[enter] confirm')
  })
})

describe('Footer borderColor', () => {
  test('accepts a borderColor override without error', () => {
    const { lastFrame } = render(
      <Footer borderColor="magenta">
        <KeyHints hints={[{ keys: 'q', label: 'quit' }]} />
      </Footer>,
    )
    expect(lastFrame()).toContain('[q] quit')
  })
})
