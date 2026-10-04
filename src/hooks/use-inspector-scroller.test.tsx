// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useInspectorScroller } from '@/hooks/use-inspector-scroller'

function Probe({ onReady }: { onReady?: (api: ReturnType<typeof useInspectorScroller>) => void }) {
  const api = useInspectorScroller()
  const { ref, scrollTop, viewportHeight, onScroll } = api
  useEffect(() => {
    onReady?.(api)
  })
  return (
    <div ref={ref} data-testid="scroller" onScroll={onScroll}>
      <span data-testid="state">{`${scrollTop}/${viewportHeight}`}</span>
    </div>
  )
}

describe('useInspectorScroller', () => {
  const originalResizeObserver = globalThis.ResizeObserver

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
    vi.restoreAllMocks()
  })

  it('DOM から高さが測れない環境（jsdom）では viewportHeight が 0', () => {
    render(<Probe />)
    expect(screen.getByTestId('state').textContent).toBe('0/0')
  })

  it('マウント時に clientHeight を測り、ResizeObserver の通知で更新する', () => {
    let notify: () => void = () => {}
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        notify = () => callback([], this as unknown as ResizeObserver)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    let height = 240
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)

    render(<Probe />)
    expect(screen.getByTestId('state').textContent).toBe('0/240')

    height = 500
    act(() => notify())
    expect(screen.getByTestId('state').textContent).toBe('0/500')
  })

  it('スクロールすると scrollTop が state に反映される', () => {
    render(<Probe />)
    fireEvent.scroll(screen.getByTestId('scroller'), { target: { scrollTop: 123 } })
    expect(screen.getByTestId('state').textContent).toBe('123/0')
  })

  it('scrollToBottom で末尾へ寄せる', () => {
    let api: ReturnType<typeof useInspectorScroller> | undefined
    render(<Probe onReady={(value) => (api = value)} />)
    const scroller = screen.getByTestId('scroller')
    let scrollTop = 0
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 4000 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })
    act(() => api?.scrollToBottom())
    expect(scrollTop).toBe(4000)
    expect(screen.getByTestId('state').textContent).toBe('4000/0')
  })

  it('ResizeObserver が無い環境でも落ちない', () => {
    // @ts-expect-error テストのため、存在しない状態を再現する
    delete globalThis.ResizeObserver
    expect(() => render(<Probe />)).not.toThrow()
  })

  it('アンマウント時に ResizeObserver を切り離す', () => {
    const disconnect = vi.fn()
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect = disconnect
    }
    const { unmount } = render(<Probe />)
    unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
