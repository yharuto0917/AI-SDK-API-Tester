// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROXY_STATUS_LABELS, proxyStatusText, useProxyStatus } from '@/hooks/use-proxy-status'
import { PROXY_NAME, checkProxyAvailable } from '@/lib/proxy'
import { settingsStore } from '@/lib/settings-store'

// 生存確認だけ差し替える。PROXY_NAME などの定数は実物を使う（画面の文言がここから組み立てられるため）
vi.mock('@/lib/proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/proxy')>()),
  checkProxyAvailable: vi.fn(),
}))

const mockedCheck = vi.mocked(checkProxyAvailable)

interface Deferred {
  resolve: (value: boolean) => void
  signal: AbortSignal | undefined
}

/** 呼び出しごとに結果を手動で解決できる checkProxyAvailable のモックを仕込む。 */
function useDeferredChecks(): Deferred[] {
  const calls: Deferred[] = []
  mockedCheck.mockImplementation((_fetchImpl, signal) => {
    return new Promise<boolean>((resolve) => {
      calls.push({ resolve, signal })
    })
  })
  return calls
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  mockedCheck.mockReset()
  settingsStore.reset()
  localStorage.clear()
  sessionStorage.clear()
})

describe('useProxyStatus', () => {
  it('最初は「確認中」で、成功すると「利用可能」になる', async () => {
    const calls = useDeferredChecks()
    const { result } = renderHook(() => useProxyStatus())
    expect(result.current.status).toBe('checking')
    expect(calls).toHaveLength(1)

    await act(async () => {
      calls[0]?.resolve(true)
    })
    expect(result.current.status).toBe('available')
  })

  it('確認に失敗すると「利用不可」になる', async () => {
    mockedCheck.mockResolvedValue(false)
    const { result } = renderHook(() => useProxyStatus())
    await settle()
    expect(result.current.status).toBe('unavailable')
  })

  it('ウィンドウ focus で再確認し、結果が出るまでは前回の状態を保つ', async () => {
    const calls = useDeferredChecks()
    const { result } = renderHook(() => useProxyStatus())
    await act(async () => {
      calls[0]?.resolve(true)
    })
    expect(result.current.status).toBe('available')

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(calls).toHaveLength(2)
    // 「確認中」に戻して表示が点滅しないこと
    expect(result.current.status).toBe('available')

    await act(async () => {
      calls[1]?.resolve(false)
    })
    expect(result.current.status).toBe('unavailable')
  })

  it('useDevProxy を切り替えると再確認する（マウント直後は 1 回だけ）', async () => {
    const calls = useDeferredChecks()
    renderHook(() => useProxyStatus())
    expect(calls).toHaveLength(1)

    act(() => {
      settingsStore.update({ useDevProxy: true })
    })
    expect(calls).toHaveLength(2)

    // 関係の無い設定変更では再確認しない
    act(() => {
      settingsStore.update({ bearerToken: 'x' })
    })
    expect(calls).toHaveLength(2)
  })

  it('recheck() は「確認中」に戻してから結果を反映する', async () => {
    const calls = useDeferredChecks()
    const { result } = renderHook(() => useProxyStatus())
    await act(async () => {
      calls[0]?.resolve(false)
    })
    expect(result.current.status).toBe('unavailable')

    act(() => {
      result.current.recheck()
    })
    expect(result.current.status).toBe('checking')
    expect(calls).toHaveLength(2)

    await act(async () => {
      calls[1]?.resolve(true)
    })
    expect(result.current.status).toBe('available')
  })

  it('アンマウントすると進行中の確認を中断する', () => {
    const calls = useDeferredChecks()
    const { unmount } = renderHook(() => useProxyStatus())
    expect(calls[0]?.signal?.aborted).toBe(false)

    unmount()
    expect(calls[0]?.signal?.aborted).toBe(true)
  })

  it('アンマウント後は focus しても確認しない', () => {
    const calls = useDeferredChecks()
    const { unmount } = renderHook(() => useProxyStatus())
    unmount()

    window.dispatchEvent(new Event('focus'))
    expect(calls).toHaveLength(1)
  })

  it('後から始めた確認で置き換えられた古い結果は捨てる', async () => {
    const calls = useDeferredChecks()
    const { result } = renderHook(() => useProxyStatus())

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.signal?.aborted).toBe(true)

    // 新しい確認が先に終わり、その後に古い確認が（中断の結果として false で）返ってくる
    await act(async () => {
      calls[1]?.resolve(true)
    })
    await act(async () => {
      calls[0]?.resolve(false)
    })
    expect(result.current.status).toBe('available')
  })

  it('複数のフックが状態と確認を共有する', async () => {
    const calls = useDeferredChecks()
    const a = renderHook(() => useProxyStatus())
    const b = renderHook(() => useProxyStatus())
    // リクエストは重複させない
    expect(calls).toHaveLength(1)

    await act(async () => {
      calls[0]?.resolve(true)
    })
    expect(a.result.current.status).toBe('available')
    expect(b.result.current.status).toBe('available')

    act(() => {
      a.result.current.recheck()
    })
    expect(b.result.current.status).toBe('checking')

    // 片方が消えても、もう一方が使っている間は中断しない
    a.unmount()
    expect(calls[1]?.signal?.aborted).toBe(false)
  })

  it('再マウントすると「確認中」から確認し直す', async () => {
    mockedCheck.mockResolvedValue(true)
    const first = renderHook(() => useProxyStatus())
    await settle()
    expect(first.result.current.status).toBe('available')
    first.unmount()

    const calls = useDeferredChecks()
    const second = renderHook(() => useProxyStatus())
    expect(second.result.current.status).toBe('checking')
    expect(calls).toHaveLength(1)
  })
})

describe('proxyStatusText', () => {
  it('PROXY_NAME と状態ラベルから「呼び名: 状態」を組み立てる', () => {
    expect(proxyStatusText('available')).toBe(`${PROXY_NAME}: ${PROXY_STATUS_LABELS.available}`)
    expect(proxyStatusText('checking')).toBe(`${PROXY_NAME}: 確認中`)
    expect(proxyStatusText('unavailable')).toBe(`${PROXY_NAME}: 利用不可`)
  })
})
