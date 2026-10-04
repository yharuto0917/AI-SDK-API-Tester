import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROXY_ERROR_HEADER,
  PROXY_NAME,
  PROXY_PATH,
  PROXY_TARGET_HEADER,
  PROXY_TOGGLE_LABEL,
  checkProxyAvailable,
} from '@/lib/proxy'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('proxy constants', () => {
  it('契約どおりの値', () => {
    expect(PROXY_PATH).toBe('/__proxy')
    expect(PROXY_TARGET_HEADER).toBe('x-proxy-target')
    expect(PROXY_ERROR_HEADER).toBe('x-proxy-error')
  })

  it('設定画面のトグルのラベルは呼び名から組み立てる（診断の案内文と同じ文字列を使うため）', () => {
    expect(PROXY_NAME).toBe('devプロキシ')
    expect(PROXY_TOGGLE_LABEL).toBe('devプロキシ経由で送信')
  })
})

describe('checkProxyAvailable', () => {
  it('200 + {proxy:"ai-sdk-tester"} なら true', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ proxy: 'ai-sdk-tester', version: 1 }))
    await expect(checkProxyAvailable(fetchImpl as unknown as typeof fetch)).resolves.toBe(true)
  })

  it('PROXY_PATH へ GET し、signal を渡す', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ proxy: 'ai-sdk-tester' }))
    const controller = new AbortController()
    await checkProxyAvailable(fetchImpl as unknown as typeof fetch, controller.signal)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/__proxy')
    expect(init.method).toBe('GET')
    expect(init.signal).toBe(controller.signal)
    expect(init.credentials).toBe('omit')
  })

  it('version が無くても proxy 名が合えば true', async () => {
    const fetchImpl = async () => jsonResponse({ proxy: 'ai-sdk-tester' })
    await expect(checkProxyAvailable(fetchImpl as unknown as typeof fetch)).resolves.toBe(true)
  })

  it.each([404, 500, 502, 204, 301])('ステータス %d は false', async (status) => {
    const fetchImpl = async () =>
      new Response(status === 204 ? null : JSON.stringify({ proxy: 'ai-sdk-tester' }), { status })
    await expect(checkProxyAvailable(fetchImpl as unknown as typeof fetch)).resolves.toBe(false)
  })

  it('200 でも別の JSON なら false', async () => {
    for (const body of [{ proxy: 'other' }, { ok: true }, {}, [], null, 'ai-sdk-tester', 1]) {
      const fetchImpl = async () => jsonResponse(body)
      await expect(checkProxyAvailable(fetchImpl as unknown as typeof fetch)).resolves.toBe(false)
    }
  })

  it('200 の HTML（SPA フォールバック）は false', async () => {
    const fetchImpl = async () =>
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    await expect(checkProxyAvailable(fetchImpl as unknown as typeof fetch)).resolves.toBe(false)
  })

  it('fetch が reject しても throw せず false', async () => {
    const fetchImpl = async () => {
      throw new TypeError('Failed to fetch')
    }
    await expect(checkProxyAvailable(fetchImpl as unknown as typeof fetch)).resolves.toBe(false)
  })

  it('fetch が同期的に throw しても false', async () => {
    const fetchImpl = () => {
      throw new Error('sync')
    }
    await expect(checkProxyAvailable(fetchImpl as unknown as typeof fetch)).resolves.toBe(false)
  })

  it('abort 済みの signal でも throw せず false', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return jsonResponse({ proxy: 'ai-sdk-tester' })
    })
    await expect(
      checkProxyAvailable(fetchImpl as unknown as typeof fetch, controller.signal),
    ).resolves.toBe(false)
  })

  it('fetchImpl 省略時は globalThis.fetch を使う', async () => {
    const stub = vi.fn(async () => jsonResponse({ proxy: 'ai-sdk-tester' }))
    vi.stubGlobal('fetch', stub)
    await expect(checkProxyAvailable()).resolves.toBe(true)
    expect(stub).toHaveBeenCalledTimes(1)
  })
})
