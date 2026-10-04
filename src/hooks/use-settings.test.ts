// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSettings } from '@/hooks/use-settings'
import { createDefaultSettings } from '@/lib/settings'
import { SETTINGS_STORAGE_KEY, settingsStore } from '@/lib/settings-store'

beforeEach(() => {
  // シングルトンのストアはテスト間で共有されるので毎回初期化する
  settingsStore.reset()
  localStorage.clear()
  sessionStorage.clear()
})

describe('useSettings', () => {
  it('現在の設定を返す', () => {
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings).toEqual(createDefaultSettings())
  })

  it('update で設定が変わり、再レンダリングされる', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      result.current.update({ mode: 'raw', useDevProxy: true })
    })
    expect(result.current.settings.mode).toBe('raw')
    expect(result.current.settings.useDevProxy).toBe(true)
  })

  it('関数形式の update も使える', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      result.current.update((prev) => ({ ...prev, rawBody: 'changed' }))
    })
    expect(result.current.settings.rawBody).toBe('changed')
  })

  it('フックの外（ストア直接）からの更新にも追従する', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      settingsStore.update({ mode: 'completion' })
    })
    expect(result.current.settings.mode).toBe('completion')
  })

  it('reset で既定値に戻る', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      result.current.update({ mode: 'raw', bearerToken: 'tok' })
    })
    act(() => {
      result.current.reset()
    })
    expect(result.current.settings).toEqual(createDefaultSettings())
  })

  it('複数のフックが同じ状態を共有する', () => {
    const a = renderHook(() => useSettings())
    const b = renderHook(() => useSettings())
    act(() => {
      a.result.current.update({ mode: 'chat-text' })
    })
    expect(b.result.current.settings.mode).toBe('chat-text')
  })

  it('変更が無ければ再レンダリングしても参照が安定する', () => {
    const { result, rerender } = renderHook(() => useSettings())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
    expect(result.current.settings).toBe(first.settings)
    expect(result.current.update).toBe(first.update)
    expect(result.current.reset).toBe(first.reset)
  })

  it('設定が変わっても update / reset の参照は変わらない', () => {
    const { result } = renderHook(() => useSettings())
    const { update, reset, settings } = result.current
    act(() => {
      update({ mode: 'raw' })
    })
    expect(result.current.update).toBe(update)
    expect(result.current.reset).toBe(reset)
    expect(result.current.settings).not.toBe(settings)
  })

  it('値が同じ update では再レンダリングせず参照も変わらない', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      result.current.update({ mode: 'raw' })
    })
    const before = result.current
    act(() => {
      result.current.update({ mode: 'raw' })
    })
    expect(result.current).toBe(before)
  })

  it('更新は localStorage に永続化され、bearerToken は sessionStorage に入る', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      result.current.update({ mode: 'raw', bearerToken: 'tok' })
    })
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY) ?? ''
    expect(JSON.parse(saved)).toMatchObject({ mode: 'raw' })
    expect(saved).not.toContain('tok')
    expect(sessionStorage.getItem('ai-sdk-tester:bearer-token')).toBe('tok')
  })

  it('アンマウント後のストア更新で例外にならない', () => {
    const { unmount } = renderHook(() => useSettings())
    unmount()
    expect(() => settingsStore.update({ mode: 'raw' })).not.toThrow()
  })
})
