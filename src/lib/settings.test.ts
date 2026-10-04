import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOCK_ENDPOINTS,
  applyMockPreset,
  createDefaultSettings,
  newHeaderEntry,
  normalizeSettings,
  parseExtraBody,
  validateEndpoint,
} from '@/lib/settings'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createDefaultSettings', () => {
  it('仕様どおりの既定値を返す', () => {
    expect(createDefaultSettings()).toEqual({
      mode: 'chat-ui',
      endpoints: {
        'chat-ui': 'http://localhost:28787/api/chat',
        'chat-text': 'http://localhost:28787/api/text',
        completion: 'http://localhost:28787/api/completion',
        raw: 'http://localhost:28787/api/json',
      },
      headers: [],
      bearerToken: '',
      extraBody: '',
      credentials: 'same-origin',
      useDevProxy: false,
      sendLastMessageOnly: false,
      autoSendAfterToolOutput: true,
      completionProtocol: 'data',
      rawMethod: 'POST',
      rawBody: '{\n  "hello": "world"\n}',
    })
  })

  it('呼び出しごとに独立したオブジェクトを返す（MOCK_ENDPOINTS を汚染しない）', () => {
    const a = createDefaultSettings()
    a.endpoints.raw = 'http://changed.example/'
    a.headers.push(newHeaderEntry())
    expect(MOCK_ENDPOINTS.raw).toBe('http://localhost:28787/api/json')
    const b = createDefaultSettings()
    expect(b.endpoints.raw).toBe('http://localhost:28787/api/json')
    expect(b.headers).toEqual([])
  })
})

describe('applyMockPreset', () => {
  it('endpoints だけをモックに置き換え、他の項目は保つ', () => {
    const base = {
      ...createDefaultSettings(),
      mode: 'raw' as const,
      endpoints: {
        'chat-ui': 'https://api.example.com/chat',
        'chat-text': '/t',
        completion: '/c',
        raw: '/r',
      },
      bearerToken: 'secret',
      useDevProxy: true,
    }
    const result = applyMockPreset(base)
    expect(result.endpoints).toEqual(MOCK_ENDPOINTS)
    expect(result.mode).toBe('raw')
    expect(result.bearerToken).toBe('secret')
    expect(result.useDevProxy).toBe(true)
  })

  it('入力を破壊せず、結果の endpoints が MOCK_ENDPOINTS と共有されない', () => {
    const base = createDefaultSettings()
    base.endpoints['chat-ui'] = '/custom'
    const result = applyMockPreset(base)
    expect(base.endpoints['chat-ui']).toBe('/custom')
    result.endpoints['chat-ui'] = '/mutated'
    expect(MOCK_ENDPOINTS['chat-ui']).toBe('http://localhost:28787/api/chat')
  })
})

describe('newHeaderEntry', () => {
  it('既定は name / value 空・enabled true', () => {
    const entry = newHeaderEntry()
    expect(entry).toMatchObject({ name: '', value: '', enabled: true })
    expect(entry.id).not.toBe('')
  })

  it('指定した項目だけ上書きする', () => {
    expect(newHeaderEntry({ name: 'x-a', enabled: false })).toMatchObject({
      name: 'x-a',
      value: '',
      enabled: false,
    })
    expect(newHeaderEntry({ value: 'v' })).toMatchObject({ name: '', value: 'v', enabled: true })
  })

  it('ID が衝突しない', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newHeaderEntry().id))
    expect(ids.size).toBe(500)
  })

  it('crypto.randomUUID が無い環境でも一意な ID を作れる', () => {
    vi.stubGlobal('crypto', undefined)
    const ids = new Set(Array.from({ length: 500 }, () => newHeaderEntry().id))
    expect(ids.size).toBe(500)
    expect([...ids].every((id) => id !== '')).toBe(true)
  })

  it('randomUUID が例外を投げてもフォールバックする', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new Error('insecure context')
      },
    })
    const a = newHeaderEntry()
    const b = newHeaderEntry()
    expect(a.id).not.toBe(b.id)
  })
})

describe('normalizeSettings', () => {
  it.each([undefined, null, 42, 'text', true, [], [1, 2]])(
    'オブジェクト以外 (%j) は既定値',
    (raw) => {
      expect(normalizeSettings(raw)).toEqual(createDefaultSettings())
    },
  )

  it('空オブジェクトは既定値で補完される', () => {
    expect(normalizeSettings({})).toEqual(createDefaultSettings())
  })

  it('正しい値はそのまま復元する（往復で変わらない）', () => {
    const settings = {
      ...createDefaultSettings(),
      mode: 'completion' as const,
      endpoints: {
        'chat-ui': 'https://a.example/chat',
        'chat-text': '/text',
        completion: 'https://a.example/c',
        raw: '/raw',
      },
      headers: [
        { id: 'h1', name: 'x-a', value: '1', enabled: true },
        { id: 'h2', name: 'x-b', value: '2', enabled: false },
      ],
      bearerToken: 'tok',
      extraBody: '{"a":1}',
      credentials: 'include' as const,
      useDevProxy: true,
      sendLastMessageOnly: true,
      autoSendAfterToolOutput: false,
      completionProtocol: 'text' as const,
      rawMethod: 'PATCH' as const,
      rawBody: 'plain',
    }
    expect(normalizeSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings)
  })

  it('不正な列挙値は既定値に戻す', () => {
    const result = normalizeSettings({
      mode: 'nope',
      credentials: 'always',
      completionProtocol: 'json',
      rawMethod: 'TRACE',
    })
    expect(result.mode).toBe('chat-ui')
    expect(result.credentials).toBe('same-origin')
    expect(result.completionProtocol).toBe('data')
    expect(result.rawMethod).toBe('POST')
  })

  it('列挙値は大文字小文字違い・非文字列も既定値扱い', () => {
    expect(normalizeSettings({ rawMethod: 'get' }).rawMethod).toBe('POST')
    expect(normalizeSettings({ mode: 1 }).mode).toBe('chat-ui')
    expect(normalizeSettings({ credentials: null }).credentials).toBe('same-origin')
  })

  it('型違いの真偽値・文字列は既定値で補完する', () => {
    const result = normalizeSettings({
      useDevProxy: 'true',
      sendLastMessageOnly: 1,
      autoSendAfterToolOutput: 'no',
      extraBody: { a: 1 },
      rawBody: 5,
    })
    expect(result.useDevProxy).toBe(false)
    expect(result.sendLastMessageOnly).toBe(false)
    expect(result.autoSendAfterToolOutput).toBe(true)
    expect(result.extraBody).toBe('')
    expect(result.rawBody).toBe('{\n  "hello": "world"\n}')
  })

  it('空文字の rawBody / extraBody / endpoint はユーザー入力として保持する', () => {
    const result = normalizeSettings({
      rawBody: '',
      extraBody: '',
      endpoints: { raw: '' },
    })
    expect(result.rawBody).toBe('')
    expect(result.endpoints.raw).toBe('')
  })

  it('endpoints は欠損・型違いのモードだけ既定値で補完する', () => {
    const result = normalizeSettings({
      endpoints: { 'chat-ui': '/mine', 'chat-text': 5, completion: null },
    })
    expect(result.endpoints).toEqual({
      ...MOCK_ENDPOINTS,
      'chat-ui': '/mine',
    })
  })

  it.each([null, [], 'x', 3])('endpoints が不正 (%j) でも既定値', (endpoints) => {
    expect(normalizeSettings({ endpoints }).endpoints).toEqual(MOCK_ENDPOINTS)
  })

  it('headers が配列でなければ空配列', () => {
    expect(normalizeSettings({ headers: 'x' }).headers).toEqual([])
    expect(normalizeSettings({ headers: { a: 1 } }).headers).toEqual([])
  })

  it('headers のオブジェクトでない要素は捨て、欠損項目は補完する', () => {
    const result = normalizeSettings({
      headers: [null, 'x', 3, [], { id: 'k', name: 5, value: null }, { id: 'k2', name: 'a' }],
    })
    expect(result.headers).toEqual([
      { id: 'k', name: '', value: '', enabled: true },
      { id: 'k2', name: 'a', value: '', enabled: true },
    ])
  })

  it('headers の id が欠損・空・重複なら一意に採番し直す', () => {
    const result = normalizeSettings({
      headers: [
        { id: 'dup', name: 'a', value: '1', enabled: true },
        { id: 'dup', name: 'b', value: '2', enabled: true },
        { name: 'c', value: '3', enabled: true },
        { id: '', name: 'd', value: '4', enabled: true },
        { id: 7, name: 'e', value: '5', enabled: true },
      ],
    })
    const ids = result.headers.map((h) => h.id)
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(5)
    expect(ids[0]).toBe('dup')
    expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true)
    expect(result.headers.map((h) => h.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('bearerToken が文字列でなければ空文字', () => {
    expect(normalizeSettings({ bearerToken: 123 }).bearerToken).toBe('')
    expect(normalizeSettings({ bearerToken: null }).bearerToken).toBe('')
    expect(normalizeSettings({ bearerToken: 'abc' }).bearerToken).toBe('abc')
  })

  it('入力オブジェクトを破壊しない', () => {
    const raw = { headers: [{ id: 'a', name: 'n', value: 'v', enabled: true }], mode: 'raw' }
    const snapshot = JSON.parse(JSON.stringify(raw))
    normalizeSettings(raw)
    expect(raw).toEqual(snapshot)
  })

  it('getter が例外を投げる入力でも throw せず既定値を返す', () => {
    const hostile = {
      get mode(): string {
        throw new Error('boom')
      },
    }
    expect(() => normalizeSettings(hostile)).not.toThrow()
    expect(normalizeSettings(hostile)).toEqual(createDefaultSettings())
  })

  it('未知のキーは無視する', () => {
    const result = normalizeSettings({ mode: 'raw', unknown: 1 })
    expect(result).not.toHaveProperty('unknown')
    expect(result.mode).toBe('raw')
  })
})

describe('parseExtraBody', () => {
  it.each(['', ' ', '\n\t  '])('空・空白のみ (%j) は undefined 扱い', (text) => {
    expect(parseExtraBody(text)).toEqual({ ok: true, value: undefined })
  })

  it('JSON オブジェクトをパースする', () => {
    expect(parseExtraBody('{"a":1,"b":{"c":[1,2]}}')).toEqual({
      ok: true,
      value: { a: 1, b: { c: [1, 2] } },
    })
  })

  it('前後の空白は許容し、空オブジェクトも有効', () => {
    expect(parseExtraBody('  {}  \n')).toEqual({ ok: true, value: {} })
  })

  it.each(['[1,2]', '[]', '"str"', '123', 'true', 'null'])(
    'オブジェクト以外 (%s) は日本語エラー',
    (text) => {
      const result = parseExtraBody(text)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('JSONオブジェクト')
    },
  )

  it.each(['{', '{"a":}', "{'a':1}", 'abc', '{"a":1,}'])(
    '構文エラー (%s) は日本語エラー',
    (text) => {
      const result = parseExtraBody(text)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('正しいJSONではありません')
    },
  )
})

describe('validateEndpoint', () => {
  it.each([
    'http://localhost:28787/api/chat',
    'https://api.example.com/v1/chat?x=1#frag',
    'HTTP://EXAMPLE.COM/',
    'http://127.0.0.1:3000',
    'http://[::1]:28787/api',
    '/api/chat',
    '/',
    '/api/chat?stream=1',
    '  /padded  ',
  ])('許可: %s', (value) => {
    expect(validateEndpoint(value)).toBeNull()
  })

  it.each(['', '   ', '\n'])('空 (%j) は入力を促すエラー', (value) => {
    expect(validateEndpoint(value)).toBe('エンドポイントを入力してください')
  })

  it.each([
    'localhost:28787/api',
    'api/chat',
    './api',
    'ftp://example.com/x',
    'ws://example.com/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'example.com',
  ])('拒否: %s', (value) => {
    const error = validateEndpoint(value)
    expect(error).not.toBeNull()
    expect(error).toContain('http://')
  })

  it.each(['http://', 'https://', 'http://[bad', 'http://exa mple.com/'])(
    '壊れた絶対 URL (%s) は拒否',
    (value) => {
      expect(validateEndpoint(value)).toBe('URLの形式が正しくありません')
    },
  )
})
