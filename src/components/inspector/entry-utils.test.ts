import { describe, expect, it } from 'vitest'
import {
  displayHeaders,
  displayResponseHeaders,
  durationLabel,
  isEmphasizedHeader,
  isInFlight,
  isSensitiveResponseHeaderName,
  LOG_STATE_LABELS,
  splitUrl,
  statusTone,
} from '@/components/inspector/entry-utils'

describe('splitUrl', () => {
  it('絶対 URL を origin とパス（クエリ・ハッシュ込み）に分ける', () => {
    expect(splitUrl('https://api.example.com:8080/v1/chat?stream=1#top')).toEqual({
      origin: 'https://api.example.com:8080',
      path: '/v1/chat?stream=1#top',
    })
  })

  it('パスが無ければ "/" になる', () => {
    expect(splitUrl('http://localhost:3000')).toEqual({
      origin: 'http://localhost:3000',
      path: '/',
    })
  })

  it('相対パスはそのままパス扱い', () => {
    expect(splitUrl('/api/chat')).toEqual({ origin: '', path: '/api/chat' })
  })

  it('解釈できない文字列はそのままパス扱い', () => {
    expect(splitUrl('not a url')).toEqual({ origin: '', path: 'not a url' })
    expect(splitUrl('')).toEqual({ origin: '', path: '' })
  })

  it('origin を持たないスキーム（data: など）は分けない', () => {
    expect(splitUrl('data:text/plain,hi')).toEqual({ origin: '', path: 'data:text/plain,hi' })
  })
})

describe('statusTone', () => {
  it('2xx は success', () => {
    expect(statusTone(200)).toBe('success')
    expect(statusTone(204)).toBe('success')
    expect(statusTone(299)).toBe('success')
  })

  it('1xx / 3xx は info', () => {
    expect(statusTone(101)).toBe('info')
    expect(statusTone(301)).toBe('info')
    expect(statusTone(399)).toBe('info')
  })

  it('4xx / 5xx は error', () => {
    expect(statusTone(400)).toBe('error')
    expect(statusTone(404)).toBe('error')
    expect(statusTone(500)).toBe('error')
    expect(statusTone(599)).toBe('error')
  })

  it('未受信・範囲外は none', () => {
    expect(statusTone(undefined)).toBe('none')
    expect(statusTone(0)).toBe('none')
    expect(statusTone(600)).toBe('none')
    expect(statusTone(Number.NaN)).toBe('none')
  })
})

describe('isInFlight', () => {
  it('pending / streaming だけ true', () => {
    expect(isInFlight('pending')).toBe(true)
    expect(isInFlight('streaming')).toBe(true)
    expect(isInFlight('done')).toBe(false)
    expect(isInFlight('error')).toBe(false)
    expect(isInFlight('aborted')).toBe(false)
  })

  it('すべての状態に日本語ラベルがある', () => {
    expect(Object.keys(LOG_STATE_LABELS).sort()).toEqual([
      'aborted',
      'done',
      'error',
      'pending',
      'streaming',
    ])
  })
})

describe('displayHeaders', () => {
  const headers = {
    Authorization: 'Bearer sk-secret-token-1234',
    'Content-Type': 'application/json',
  }

  it('秘匿情報を表示しないときは Authorization をマスクする', () => {
    const masked = displayHeaders(headers, false)
    expect(masked.Authorization).not.toContain('secret')
    expect(masked.Authorization.startsWith('Bearer ')).toBe(true)
    expect(masked['Content-Type']).toBe('application/json')
  })

  it('表示するときはそのまま', () => {
    expect(displayHeaders(headers, true)).toBe(headers)
  })
})

describe('isSensitiveResponseHeaderName（レスポンスは狭い規則）', () => {
  it.each([
    'set-cookie',
    'Set-Cookie',
    'set-cookie2',
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'X-API-Key',
    'api-key',
    'x-auth-token',
    'x-access-token',
    'x-csrf-token',
    'x-xsrf-token',
  ])('%s は値を隠す', (name) => {
    expect(isSensitiveResponseHeaderName(name)).toBe(true)
  })

  it.each([
    'access-control-allow-credentials',
    'access-control-allow-origin',
    'access-control-allow-headers',
    'access-control-expose-headers',
    'www-authenticate',
    'proxy-authenticate',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-tokens',
    'anthropic-ratelimit-tokens-remaining',
    'openai-organization',
    'content-type',
    'x-vercel-ai-ui-message-stream',
    // 完全一致だけが対象。名前の一部に key / token / auth が含まれるだけでは隠さない
    'x-custom-token',
    'idempotency-key',
    'x-request-id',
  ])('%s は隠さない', (name) => {
    expect(isSensitiveResponseHeaderName(name)).toBe(false)
  })
})

describe('displayResponseHeaders', () => {
  const headers = {
    'access-control-allow-credentials': 'true',
    'access-control-allow-origin': 'https://app.example.com',
    'www-authenticate': 'Bearer realm="api", error="invalid_token"',
    'x-ratelimit-remaining-tokens': '99000',
    'content-type': 'text/event-stream',
    'set-cookie': 'session=abcdef1234567890abcdef',
    'x-api-key': 'sk-echoed-key-0123456789',
    'x-csrf-token': 'csrf-short',
  }

  it('秘匿情報を表示しないときは、秘密を運ぶ名前の値だけを隠す', () => {
    expect(displayResponseHeaders(headers, false)).toEqual({
      'access-control-allow-credentials': 'true',
      'access-control-allow-origin': 'https://app.example.com',
      'www-authenticate': 'Bearer realm="api", error="invalid_token"',
      'x-ratelimit-remaining-tokens': '99000',
      'content-type': 'text/event-stream',
      'set-cookie': '••••cdef',
      'x-api-key': '••••6789',
      'x-csrf-token': '••••',
    })
  })

  it('リクエスト側の広い規則では隠れる名前が、レスポンス側では隠れない', () => {
    const response = { 'access-control-allow-credentials': 'true', 'www-authenticate': 'Basic x' }
    expect(displayHeaders(response, false)['access-control-allow-credentials']).toBe('••••')
    expect(displayResponseHeaders(response, false)).toEqual(response)
  })

  it('表示するときはそのまま、元のオブジェクトも書き換えない', () => {
    expect(displayResponseHeaders(headers, true)).toBe(headers)
    const copy = { ...headers }
    displayResponseHeaders(headers, false)
    expect(headers).toEqual(copy)
  })
})

describe('isEmphasizedHeader', () => {
  it('UI Message Stream ヘッダーと content-type を強調する（大文字小文字は無視）', () => {
    expect(isEmphasizedHeader('x-vercel-ai-ui-message-stream')).toBe(true)
    expect(isEmphasizedHeader('Content-Type')).toBe(true)
    expect(isEmphasizedHeader('cache-control')).toBe(false)
  })
})

describe('durationLabel', () => {
  it('完了していれば formatDuration、未完了は —', () => {
    expect(durationLabel({ totalMs: 123 })).toBe('123 ms')
    expect(durationLabel({ totalMs: 1500 })).toBe('1.50 s')
    expect(durationLabel({})).toBe('—')
  })
})
