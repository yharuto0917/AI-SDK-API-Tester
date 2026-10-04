import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject, UIEvent } from 'react'

/**
 * 固定行高の簡易ウィンドウ描画に使う、スクロール要素の状態。
 * scrollTop と表示領域の高さを state に持ち、末尾へのスクロールも提供する。
 * ref を付けた要素は、このフックを使うコンポーネントが描画されている間ずっと存在すること。
 */
export function useInspectorScroller(): {
  ref: RefObject<HTMLDivElement | null>
  scrollTop: number
  /** DOM から測れないとき（jsdom など）は 0 */
  viewportHeight: number
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  scrollToBottom: () => void
} {
  const ref = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => setViewportHeight(element.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  const scrollToBottom = useCallback(() => {
    const element = ref.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
    setScrollTop(element.scrollTop)
  }, [])

  return { ref, scrollTop, viewportHeight, onScroll, scrollToBottom }
}
