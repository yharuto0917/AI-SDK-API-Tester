// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useNetworkLog } from '@/hooks/use-network-log'
import { networkLog } from '@/lib/network-log'
import type { BeginLogInit } from '@/lib/network-log'

const INIT: BeginLogInit = {
  mode: 'chat-ui',
  method: 'POST',
  targetUrl: 'http://localhost:28787/api/chat',
  viaProxy: false,
  requestHeaders: {},
}

beforeEach(() => {
  // シングルトンのストアはテスト間で共有されるので毎回空にする
  networkLog.clear()
})

afterEach(() => {
  networkLog.clear()
})

describe('useNetworkLog', () => {
  it('初期状態は空で、選択なし', () => {
    const { result } = renderHook(() => useNetworkLog())
    expect(result.current.entries).toEqual([])
    expect(result.current.selectedId).toBeNull()
    expect(result.current.selectedEntry).toBeUndefined()
  })

  it('begin でエントリが増え、自動で選択される', () => {
    const { result } = renderHook(() => useNetworkLog())
    let id = ''
    act(() => {
      id = networkLog.begin(INIT)
    })
    expect(result.current.entries.map((e) => e.id)).toEqual([id])
    expect(result.current.selectedId).toBe(id)
    expect(result.current.selectedEntry?.id).toBe(id)
    expect(result.current.selectedEntry).toBe(result.current.entries[0])
  })

  it('マウント前から存在するエントリも読める', () => {
    const id = networkLog.begin(INIT)
    const { result } = renderHook(() => useNetworkLog())
    expect(result.current.selectedEntry?.id).toBe(id)
  })

  it('select で選択を切り替えられる（null で解除）', () => {
    const a = networkLog.begin(INIT)
    const b = networkLog.begin(INIT)
    const { result } = renderHook(() => useNetworkLog())
    expect(result.current.selectedId).toBe(b)

    act(() => result.current.select(a))
    expect(result.current.selectedId).toBe(a)
    expect(result.current.selectedEntry?.id).toBe(a)

    act(() => result.current.select(null))
    expect(result.current.selectedId).toBeNull()
    expect(result.current.selectedEntry).toBeUndefined()
  })

  it('clear で全件と選択が消える', () => {
    networkLog.begin(INIT)
    networkLog.begin(INIT)
    const { result } = renderHook(() => useNetworkLog())
    act(() => result.current.clear())
    expect(result.current.entries).toEqual([])
    expect(result.current.selectedId).toBeNull()
    expect(result.current.selectedEntry).toBeUndefined()
  })

  it('受信中の更新（間引かれた通知）も反映され、選択中のエントリは最新になる', async () => {
    const { result } = renderHook(() => useNetworkLog())
    let id = ''
    act(() => {
      id = networkLog.begin(INIT)
    })
    act(() => {
      networkLog.recordHead(id, { status: 200, statusText: 'OK', responseHeaders: {} })
      networkLog.recordText(id, 'Hello', { sse: false })
    })
    await waitFor(() => expect(result.current.selectedEntry?.rawBody).toBe('Hello'))
    expect(result.current.selectedEntry?.state).toBe('streaming')

    act(() => networkLog.finish(id, { state: 'done' }))
    expect(result.current.selectedEntry?.state).toBe('done')
  })

  it('状態が変わらない間は同じ参照を返す（不要な再レンダリングを起こさない）', () => {
    networkLog.begin(INIT)
    const { result, rerender } = renderHook(() => useNetworkLog())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
    expect(result.current.entries).toBe(first.entries)
  })

  it('select / clear は常に同じ参照（ストア由来で安定）', () => {
    const { result } = renderHook(() => useNetworkLog())
    const { select, clear } = result.current
    act(() => {
      networkLog.begin(INIT)
    })
    expect(result.current.select).toBe(select)
    expect(result.current.clear).toBe(clear)
  })

  it('アンマウント後はストアの購読を解除する', () => {
    const { unmount } = renderHook(() => useNetworkLog())
    unmount()
    // 購読が残っていれば act 外の更新で警告・例外になりうる。何も起きないことを確認する
    expect(() => networkLog.begin(INIT)).not.toThrow()
  })
})
