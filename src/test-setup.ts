import { afterEach } from 'vitest'

// jsdom には無いブラウザ API を補う（Radix UI / AI Elements / react-resizable-panels が参照する）。
// node 環境のテストでは window が無いので何もしない。
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  const proto = Element.prototype
  proto.scrollIntoView ??= () => {}
  proto.scrollTo ??= () => {}
  proto.hasPointerCapture ??= () => false
  proto.setPointerCapture ??= () => {}
  proto.releasePointerCapture ??= () => {}
}

// jsdom 環境のときだけ Testing Library の後始末を行う
afterEach(async () => {
  if (typeof document === 'undefined') return
  const { cleanup } = await import('@testing-library/react')
  cleanup()
})
