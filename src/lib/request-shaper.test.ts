import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROXY_PATH, PROXY_TARGET_HEADER } from '@/lib/proxy'
import { RequestShapeError, shapeRequest } from '@/lib/request-shaper'
import { createDefaultSettings, newHeaderEntry } from '@/lib/settings'
import type { ConnectionSettings, Mode } from '@/types'

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeSettings(patch: Partial<ConnectionSettings> = {}): ConnectionSettings {
  return { ...createDefaultSettings(), ...patch }
}

function shape(
  mode: Mode,
  settings: ConnectionSettings,
  init?: RequestInit,
): ReturnType<typeof shapeRequest> {
  return shapeRequest({ mode, settings, init })
}

function sdkInit(body: unknown, headers?: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

function parsedBody(result: ReturnType<typeof shapeRequest>): Record<string, unknown> {
  expect(typeof result.requestBody).toBe('string')
  return JSON.parse(result.requestBody ?? '') as Record<string, unknown>
}

function expectShapeError(fn: () => unknown, message?: string | RegExp): void {
  let caught: unknown
  try {
    fn()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(RequestShapeError)
  if (message !== undefined) expect((caught as Error).message).toMatch(message)
}

describe('RequestShapeError', () => {
  it('Error のサブクラスで name を持つ', () => {
    const e = new RequestShapeError('だめ')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(RequestShapeError)
    expect(e.name).toBe('RequestShapeError')
    expect(e.message).toBe('だめ')
  })
})

describe('エンドポイントの解決', () => {
  it.each([
    ['chat-ui', 'http://localhost:28787/api/chat'],
    ['chat-text', 'http://localhost:28787/api/text'],
    ['completion', 'http://localhost:28787/api/completion'],
    ['raw', 'http://localhost:28787/api/json'],
  ] as const)('%s は settings.endpoints[mode] を使う', (mode, url) => {
    const result = shape(mode, makeSettings())
    expect(result.targetUrl).toBe(url)
    expect(result.fetchUrl).toBe(url)
  })

  it('実行のたびに最新の設定から解決する（SDK が固定した api には左右されない）', () => {
    const settings = makeSettings()
    const first = shape('chat-ui', settings, sdkInit({ messages: [] }))
    const second = shape(
      'chat-ui',
      {
        ...settings,
        endpoints: { ...settings.endpoints, 'chat-ui': 'https://api.example.com/v2/chat' },
      },
      sdkInit({ messages: [] }),
    )
    expect(first.targetUrl).toBe('http://localhost:28787/api/chat')
    expect(second.targetUrl).toBe('https://api.example.com/v2/chat')
  })

  it('絶対 URL は加工せずそのまま使う', () => {
    const settings = makeSettings({
      endpoints: { ...createDefaultSettings().endpoints, raw: 'http://localhost:28787' },
    })
    expect(shape('raw', settings).targetUrl).toBe('http://localhost:28787')
  })

  it('前後の空白は取り除く', () => {
    const settings = makeSettings({
      endpoints: { ...createDefaultSettings().endpoints, 'chat-ui': '  https://a.example/chat \n' },
    })
    expect(shape('chat-ui', settings).targetUrl).toBe('https://a.example/chat')
  })

  it('相対パスは location があれば絶対化する', () => {
    vi.stubGlobal('location', { href: 'http://app.test:5173/some/page?x=1' })
    const settings = makeSettings({
      endpoints: { ...createDefaultSettings().endpoints, 'chat-ui': '/api/chat?s=1' },
    })
    const result = shape('chat-ui', settings)
    expect(result.targetUrl).toBe('http://app.test:5173/api/chat?s=1')
    expect(result.fetchUrl).toBe('http://app.test:5173/api/chat?s=1')
  })

  it('location が無ければ相対パスのまま', () => {
    expect(globalThis.location).toBeUndefined()
    const settings = makeSettings({
      endpoints: { ...createDefaultSettings().endpoints, 'chat-ui': '/api/chat' },
    })
    expect(shape('chat-ui', settings).targetUrl).toBe('/api/chat')
  })

  it.each([
    ['', 'エンドポイントを入力してください'],
    ['   ', 'エンドポイントを入力してください'],
    ['localhost:28787/api', /http:\/\//],
    ['api/chat', /http:\/\//],
    ['ftp://example.com', /http:\/\//],
  ])('不正なエンドポイント (%j) は RequestShapeError', (endpoint, message) => {
    const settings = makeSettings({
      endpoints: { ...createDefaultSettings().endpoints, 'chat-ui': endpoint },
    })
    expectShapeError(() => shape('chat-ui', settings), message)
  })

  it('他モードのエンドポイントが不正でも、実行するモードが正しければ通る', () => {
    const settings = makeSettings({
      endpoints: { ...createDefaultSettings().endpoints, raw: '' },
    })
    expect(() => shape('chat-ui', settings)).not.toThrow()
    expectShapeError(() => shape('raw', settings))
  })
})

describe('ヘッダーのマージ', () => {
  it('Record / Headers / [string, string][] をすべて受け付け、キーを小文字にする', () => {
    const settings = makeSettings()
    const fromRecord = shape('raw', settings, { headers: { 'X-One': '1', Accept: 'text/plain' } })
    const fromHeaders = shape('raw', settings, {
      headers: new Headers({ 'X-One': '1', Accept: 'text/plain' }),
    })
    const fromArray = shape('raw', settings, {
      headers: [
        ['X-One', '1'],
        ['Accept', 'text/plain'],
      ],
    })
    for (const result of [fromRecord, fromHeaders, fromArray]) {
      expect(result.headers['x-one']).toBe('1')
      expect(result.headers.accept).toBe('text/plain')
      expect(result.headers).not.toHaveProperty('X-One')
    }
  })

  it('Record の undefined 値は指定なしとして無視する', () => {
    const result = shape('raw', makeSettings({ rawBody: '' }), {
      headers: { 'x-a': '1', 'x-b': undefined } as unknown as Record<string, string>,
    })
    expect(result.headers).toEqual({ 'x-a': '1' })
  })

  it('init 内の大文字小文字違いの重複は後勝ちで 1 つにする', () => {
    const result = shape('raw', makeSettings(), {
      headers: [
        ['X-Dup', 'first'],
        ['x-dup', 'second'],
      ],
    })
    expect(result.headers['x-dup']).toBe('second')
    expect(Object.keys(result.headers).filter((k) => k === 'x-dup')).toHaveLength(1)
  })

  it('設定画面のヘッダーが init のヘッダーを大文字小文字を無視して上書きする', () => {
    const settings = makeSettings({
      headers: [newHeaderEntry({ name: 'X-API-Key', value: 'from-settings' })],
    })
    const result = shape('raw', settings, { headers: { 'x-api-key': 'from-init', 'x-keep': 'k' } })
    expect(result.headers['x-api-key']).toBe('from-settings')
    expect(result.headers['x-keep']).toBe('k')
    expect(Object.keys(result.headers).filter((k) => k.startsWith('x-api'))).toHaveLength(1)
  })

  it('設定内で同名が複数あれば後のエントリが勝つ', () => {
    const settings = makeSettings({
      headers: [
        newHeaderEntry({ name: 'x-a', value: '1' }),
        newHeaderEntry({ name: 'X-A', value: '2' }),
      ],
    })
    expect(shape('raw', settings).headers['x-a']).toBe('2')
  })

  it('後ろの設定が disabled なら前の有効なエントリが残る', () => {
    const settings = makeSettings({
      headers: [
        newHeaderEntry({ name: 'x-a', value: '1' }),
        newHeaderEntry({ name: 'x-a', value: '2', enabled: false }),
      ],
    })
    expect(shape('raw', settings).headers['x-a']).toBe('1')
  })

  it('disabled と名前が空（空白のみ含む）のエントリは無視する', () => {
    const settings = makeSettings({
      rawBody: '',
      headers: [
        newHeaderEntry({ name: 'x-off', value: '1', enabled: false }),
        newHeaderEntry({ name: '', value: 'orphan' }),
        newHeaderEntry({ name: '   ', value: 'orphan' }),
        newHeaderEntry({ name: 'x-on', value: '2' }),
      ],
    })
    expect(shape('raw', settings).headers).toEqual({ 'x-on': '2' })
  })

  it('disabled のエントリは不正な名前でも検証しない', () => {
    const settings = makeSettings({
      headers: [newHeaderEntry({ name: 'bad name', value: '1', enabled: false })],
    })
    expect(() => shape('raw', settings)).not.toThrow()
  })

  it('名前と値の前後の空白を取り除く', () => {
    const settings = makeSettings({
      headers: [newHeaderEntry({ name: '  X-Pad ', value: '  v  ' })],
    })
    expect(shape('raw', settings).headers['x-pad']).toBe('v')
  })

  it('値が空のヘッダーは空のまま送る', () => {
    const settings = makeSettings({ headers: [newHeaderEntry({ name: 'x-empty', value: '' })] })
    expect(shape('raw', settings).headers['x-empty']).toBe('')
  })

  it.each(['bad name', 'x:y', 'x/y', 'é', 'a,b', 'x(y)', '日本語'])(
    '設定の不正なヘッダー名 (%s) は RequestShapeError',
    (name) => {
      const settings = makeSettings({ headers: [newHeaderEntry({ name, value: '1' })] })
      expectShapeError(() => shape('raw', settings), /ヘッダー名/)
    },
  )

  it('init の不正なヘッダー名も RequestShapeError', () => {
    expectShapeError(
      () => shape('raw', makeSettings(), { headers: { 'bad name': '1' } }),
      /ヘッダー名/,
    )
    expectShapeError(() => shape('raw', makeSettings(), { headers: [['x y', '1']] }), /ヘッダー名/)
  })

  it.each(["x-a'b", 'x_a', 'x.a', 'X-A~b', '!#$%&*+^`|'])(
    'RFC 7230 の token として有効な名前 (%s) は通す',
    (name) => {
      const settings = makeSettings({ headers: [newHeaderEntry({ name, value: '1' })] })
      expect(shape('raw', settings).headers[name.toLowerCase()]).toBe('1')
    },
  )

  it.each(['a\nb', 'a\r\nb', 'a\0b', 'こんにちは'])(
    'fetch が拒否する値 (%j) は RequestShapeError',
    (value) => {
      const settings = makeSettings({ headers: [newHeaderEntry({ name: 'x-a', value })] })
      expectShapeError(() => shape('raw', settings), /x-a/)
    },
  )

  it('ISO-8859-1 の範囲の値は通す', () => {
    const settings = makeSettings({ headers: [newHeaderEntry({ name: 'x-a', value: 'café' })] })
    expect(shape('raw', settings).headers['x-a']).toBe('café')
  })

  it('[名前, 値] の組になっていない配列ヘッダーは RequestShapeError', () => {
    expectShapeError(
      () =>
        shape('raw', makeSettings(), {
          headers: [['only-name']] as unknown as [string, string][],
        }),
      /形式/,
    )
  })

  it('入力の settings / init を破壊しない', () => {
    const settings = makeSettings({
      headers: [newHeaderEntry({ name: 'X-A', value: ' v ' })],
      bearerToken: 'tok',
    })
    const settingsBefore = JSON.stringify(settings)
    const initHeaders = { 'X-Init': '1' }
    shape('raw', settings, { headers: initHeaders })
    expect(JSON.stringify(settings)).toBe(settingsBefore)
    expect(initHeaders).toEqual({ 'X-Init': '1' })
  })
})

describe('Bearer トークン', () => {
  it('トークンがあり authorization が無ければ自動で付与する', () => {
    const result = shape('raw', makeSettings({ bearerToken: 'abc123' }))
    expect(result.headers.authorization).toBe('Bearer abc123')
  })

  it('トークンの前後の空白は取り除く', () => {
    expect(shape('raw', makeSettings({ bearerToken: '  abc \n' })).headers.authorization).toBe(
      'Bearer abc',
    )
  })

  it.each(['', '   ', '\n\t'])('空・空白のみのトークン (%j) は付与しない', (bearerToken) => {
    expect(shape('raw', makeSettings({ bearerToken })).headers).not.toHaveProperty('authorization')
  })

  it('設定画面の明示的な Authorization が優先される（大文字小文字を問わない）', () => {
    const settings = makeSettings({
      bearerToken: 'tok',
      headers: [newHeaderEntry({ name: 'Authorization', value: 'Basic dXNlcjpwYXNz' })],
    })
    expect(shape('raw', settings).headers.authorization).toBe('Basic dXNlcjpwYXNz')
  })

  it('init の authorization（SDK 経由など）がある場合もトークンで上書きしない', () => {
    const settings = makeSettings({ bearerToken: 'tok', rawBody: '' })
    expect(shape('raw', settings, { headers: { AUTHORIZATION: 'Token xyz' } }).headers).toEqual({
      authorization: 'Token xyz',
    })
  })

  it('disabled の Authorization ヘッダーは無いものとして扱い、トークンを付与する', () => {
    const settings = makeSettings({
      bearerToken: 'tok',
      headers: [newHeaderEntry({ name: 'Authorization', value: 'Basic x', enabled: false })],
    })
    expect(shape('raw', settings).headers.authorization).toBe('Bearer tok')
  })

  it('値が空でも明示された Authorization があればトークンは付けない（意図的な上書き）', () => {
    const settings = makeSettings({
      bearerToken: 'tok',
      headers: [newHeaderEntry({ name: 'authorization', value: '' })],
    })
    expect(shape('raw', settings).headers.authorization).toBe('')
  })

  it('改行を含むトークンは RequestShapeError', () => {
    expectShapeError(() => shape('raw', makeSettings({ bearerToken: 'a\nb' })), /authorization/)
  })
})

describe('メソッド', () => {
  it.each(['chat-ui', 'chat-text', 'completion'] as const)('%s は既定で POST', (mode) => {
    const result = shape(mode, makeSettings())
    expect(result.method).toBe('POST')
    expect(result.fetchInit.method).toBe('POST')
  })

  it('init.method を大文字にして使う', () => {
    expect(shape('chat-ui', makeSettings(), { method: 'put' }).method).toBe('PUT')
  })

  it('raw は init.method ?? settings.rawMethod', () => {
    expect(shape('raw', makeSettings({ rawMethod: 'DELETE' })).method).toBe('DELETE')
    expect(shape('raw', makeSettings({ rawMethod: 'DELETE' }), { method: 'patch' }).method).toBe(
      'PATCH',
    )
  })

  it('空文字の init.method は未指定として扱う', () => {
    expect(shape('raw', makeSettings({ rawMethod: 'PUT' }), { method: '' }).method).toBe('PUT')
  })

  it('不正なメソッド名は RequestShapeError', () => {
    expectShapeError(() => shape('raw', makeSettings(), { method: 'GE T' }), /メソッド/)
  })

  it.each(['GET', 'HEAD'] as const)('%s は body を付けない', (method) => {
    const result = shape('raw', makeSettings({ rawBody: '{"a":1}' }), { method })
    expect(result.requestBody).toBeUndefined()
    expect(result.fetchInit).not.toHaveProperty('body')
    expect(result.headers).not.toHaveProperty('content-type')
  })

  it('GET では init.body があっても捨てる（chat 系でも同様）', () => {
    const result = shape('chat-ui', makeSettings(), {
      method: 'GET',
      body: JSON.stringify({ messages: [] }),
    })
    expect(result.requestBody).toBeUndefined()
    expect(result.fetchInit).not.toHaveProperty('body')
  })

  it('raw の rawMethod が GET なら rawBody があっても送らない', () => {
    const result = shape('raw', makeSettings({ rawMethod: 'GET' }))
    expect(result.method).toBe('GET')
    expect(result.requestBody).toBeUndefined()
  })
})

describe('Chat / Completion の body 整形', () => {
  const messages = [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'one' }] },
    { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'two' }] },
    { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'three' }] },
  ]

  it('設定が何も無ければ JSON の内容を変えない', () => {
    const body = { id: 'c1', messages, trigger: 'submit-message' }
    const result = shape('chat-ui', makeSettings(), sdkInit(body))
    expect(parsedBody(result)).toEqual(body)
    expect(result.fetchInit.body).toBe(result.requestBody)
  })

  describe('sendLastMessageOnly', () => {
    it.each(['chat-ui', 'chat-text'] as const)('%s は messages を最後の 1 件だけにする', (mode) => {
      const result = shape(
        mode,
        makeSettings({ sendLastMessageOnly: true }),
        sdkInit({ id: 'c1', messages }),
      )
      expect(parsedBody(result)).toEqual({ id: 'c1', messages: [messages[2]] })
    })

    it('false なら全件のまま', () => {
      const result = shape(
        'chat-ui',
        makeSettings({ sendLastMessageOnly: false }),
        sdkInit({ messages }),
      )
      expect(parsedBody(result).messages).toEqual(messages)
    })

    it('completion には適用しない', () => {
      const result = shape(
        'completion',
        makeSettings({ sendLastMessageOnly: true }),
        sdkInit({ prompt: 'hi', messages }),
      )
      expect(parsedBody(result)).toEqual({ prompt: 'hi', messages })
    })

    it('messages が配列でなければ触らない', () => {
      const result = shape(
        'chat-ui',
        makeSettings({ sendLastMessageOnly: true }),
        sdkInit({ messages: 'oops' }),
      )
      expect(parsedBody(result)).toEqual({ messages: 'oops' })
      const noMessages = shape(
        'chat-ui',
        makeSettings({ sendLastMessageOnly: true }),
        sdkInit({ id: 'c1' }),
      )
      expect(parsedBody(noMessages)).toEqual({ id: 'c1' })
    })

    it('空配列は空のまま、1 件ならそのまま', () => {
      const settings = makeSettings({ sendLastMessageOnly: true })
      expect(parsedBody(shape('chat-ui', settings, sdkInit({ messages: [] }))).messages).toEqual([])
      expect(
        parsedBody(shape('chat-ui', settings, sdkInit({ messages: [messages[0]] }))).messages,
      ).toEqual([messages[0]])
    })

    it('元の init.body 文字列は変更されない', () => {
      const init = sdkInit({ messages })
      const before = init.body
      shape('chat-ui', makeSettings({ sendLastMessageOnly: true }), init)
      expect(init.body).toBe(before)
    })
  })

  describe('extraBody', () => {
    it('浅くマージし、extraBody のキーが優先される', () => {
      const result = shape(
        'chat-ui',
        makeSettings({ extraBody: '{"model":"gpt-x","id":"override","extra":{"a":1}}' }),
        sdkInit({ id: 'c1', model: 'old', messages: [] }),
      )
      expect(parsedBody(result)).toEqual({
        id: 'override',
        model: 'gpt-x',
        messages: [],
        extra: { a: 1 },
      })
    })

    it('マージは浅い（ネストしたオブジェクトは丸ごと置き換わる）', () => {
      const result = shape(
        'chat-ui',
        makeSettings({ extraBody: '{"options":{"b":2}}' }),
        sdkInit({ options: { a: 1 }, messages: [] }),
      )
      expect(parsedBody(result).options).toEqual({ b: 2 })
    })

    it.each(['chat-ui', 'chat-text', 'completion'] as const)('%s に適用される', (mode) => {
      const result = shape(mode, makeSettings({ extraBody: '{"k":"v"}' }), sdkInit({ prompt: 'p' }))
      expect(parsedBody(result)).toEqual({ prompt: 'p', k: 'v' })
    })

    it.each(['', '   ', '\n'])('空・空白のみ (%j) なら何もしない', (extraBody) => {
      const result = shape('chat-ui', makeSettings({ extraBody }), sdkInit({ a: 1 }))
      expect(parsedBody(result)).toEqual({ a: 1 })
    })

    it('sendLastMessageOnly と併用できる（messages を絞ってから extraBody を重ねる）', () => {
      const result = shape(
        'chat-ui',
        makeSettings({ sendLastMessageOnly: true, extraBody: '{"messages":["forced"],"x":1}' }),
        sdkInit({ messages }),
      )
      // extraBody が最優先なので、絞った結果ではなく extraBody の messages になる
      expect(parsedBody(result)).toEqual({ messages: ['forced'], x: 1 })
    })

    it.each(['{', '{"a":}', 'abc'])('不正な JSON (%s) は RequestShapeError', (extraBody) => {
      expectShapeError(
        () => shape('chat-ui', makeSettings({ extraBody }), sdkInit({ a: 1 })),
        /追加ボディ/,
      )
    })

    it.each(['[1]', '"s"', '5', 'null'])(
      'オブジェクト以外 (%s) は RequestShapeError',
      (extraBody) => {
        expectShapeError(
          () => shape('completion', makeSettings({ extraBody }), sdkInit({ prompt: 'p' })),
          /JSONオブジェクト/,
        )
      },
    )

    it('raw には適用しない（不正でもエラーにしない）', () => {
      const settings = makeSettings({ extraBody: '{', rawBody: '{"a":1}' })
      const result = shape('raw', settings)
      expect(result.requestBody).toBe('{"a":1}')
    })
  })

  describe('JSON オブジェクトでない body', () => {
    it.each(['hello', '[1,2,3]', '123', '"str"', 'null', '{broken'])(
      '文字列 body (%s) は触らずそのまま通す',
      (body) => {
        const result = shape(
          'chat-ui',
          makeSettings({ sendLastMessageOnly: true, extraBody: '{"a":1}' }),
          { method: 'POST', body },
        )
        expect(result.requestBody).toBe(body)
        expect(result.fetchInit.body).toBe(body)
      },
    )

    it('JSON でない body のときは extraBody が不正でもエラーにしない', () => {
      expect(() =>
        shape('chat-ui', makeSettings({ extraBody: '{' }), { method: 'POST', body: 'plain' }),
      ).not.toThrow()
    })

    it('body が無ければ body なしのまま', () => {
      const result = shape('chat-ui', makeSettings({ extraBody: '{"a":1}' }), { method: 'POST' })
      expect(result.requestBody).toBeUndefined()
      expect(result.fetchInit).not.toHaveProperty('body')
      expect(result.headers).not.toHaveProperty('content-type')
    })
  })

  describe('文字列以外の body', () => {
    it('FormData はそのまま通し、requestBody は説明文字列', () => {
      const form = new FormData()
      form.append('a', '1')
      const result = shape('chat-ui', makeSettings({ extraBody: '{"x":1}' }), {
        method: 'POST',
        body: form,
      })
      expect(result.fetchInit.body).toBe(form)
      expect(result.requestBody).toBe('[FormData]')
      // multipart の boundary は fetch 任せなので content-type を付けない
      expect(result.headers).not.toHaveProperty('content-type')
    })

    it('URLSearchParams は文字列表現をログに出し、content-type は付けない', () => {
      const params = new URLSearchParams({ a: '1', b: '2' })
      const result = shape('raw', makeSettings(), { method: 'POST', body: params })
      expect(result.fetchInit.body).toBe(params)
      expect(result.requestBody).toBe('a=1&b=2')
      expect(result.headers).not.toHaveProperty('content-type')
    })

    it('Blob / バイナリはサイズだけ説明する', () => {
      const blob = new Blob(['hello'])
      expect(shape('raw', makeSettings(), { method: 'POST', body: blob }).requestBody).toBe(
        '[Blob 5 bytes]',
      )
      const bytes = new Uint8Array([1, 2, 3])
      expect(shape('raw', makeSettings(), { method: 'POST', body: bytes }).requestBody).toBe(
        '[binary 3 bytes]',
      )
      const buffer = new ArrayBuffer(8)
      expect(shape('raw', makeSettings(), { method: 'POST', body: buffer }).requestBody).toBe(
        '[binary 8 bytes]',
      )
    })

    it('ReadableStream はそのまま通す', () => {
      const stream = new ReadableStream()
      const result = shape('raw', makeSettings(), { method: 'POST', body: stream })
      expect(result.fetchInit.body).toBe(stream)
      expect(result.requestBody).toBe('[ReadableStream]')
    })
  })
})

describe('Raw モードの body', () => {
  it('init.body が無ければ settings.rawBody をそのまま（再整形せず）送る', () => {
    const rawBody = '{\n  "a":   1\n}'
    const result = shape('raw', makeSettings({ rawBody }))
    expect(result.requestBody).toBe(rawBody)
    expect(result.fetchInit.body).toBe(rawBody)
  })

  it('init.body があれば rawBody より優先する', () => {
    const result = shape('raw', makeSettings({ rawBody: 'from-settings' }), {
      method: 'POST',
      body: 'from-init',
    })
    expect(result.requestBody).toBe('from-init')
  })

  it('init.body が null でも rawBody にフォールバックする', () => {
    const result = shape('raw', makeSettings({ rawBody: 'fallback' }), {
      method: 'POST',
      body: null,
    })
    expect(result.requestBody).toBe('fallback')
  })

  it.each(['', '   ', '\n\t'])('rawBody が空・空白のみ (%j) なら body なし', (rawBody) => {
    const result = shape('raw', makeSettings({ rawBody }))
    expect(result.requestBody).toBeUndefined()
    expect(result.fetchInit).not.toHaveProperty('body')
  })

  it('空文字の init.body は明示指定として扱う（rawBody に置き換えない）', () => {
    const result = shape('raw', makeSettings({ rawBody: 'x' }), { method: 'POST', body: '' })
    expect(result.requestBody).toBe('')
  })

  it('sendLastMessageOnly / extraBody は適用しない', () => {
    const rawBody = JSON.stringify({ messages: [1, 2, 3] })
    const result = shape(
      'raw',
      makeSettings({ rawBody, sendLastMessageOnly: true, extraBody: '{"x":1}' }),
    )
    expect(result.requestBody).toBe(rawBody)
  })
})

describe('content-type の付与', () => {
  it.each(['chat-ui', 'chat-text', 'completion'] as const)(
    '%s は body が文字列で content-type が無ければ application/json を付ける',
    (mode) => {
      const result = shape(mode, makeSettings(), { method: 'POST', body: 'plain text' })
      expect(result.headers['content-type']).toBe('application/json')
      expect(result.fetchInit.headers).toMatchObject({ 'content-type': 'application/json' })
    },
  )

  it('init に content-type があればそのまま（大文字小文字を問わない）', () => {
    const result = shape('chat-ui', makeSettings(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: '{"a":1}',
    })
    expect(result.headers).toEqual({ 'content-type': 'application/x-ndjson' })
  })

  it('設定画面の content-type が優先される', () => {
    const settings = makeSettings({
      headers: [newHeaderEntry({ name: 'Content-Type', value: 'text/plain' })],
    })
    const result = shape('chat-ui', settings, sdkInit({ a: 1 }))
    expect(result.headers['content-type']).toBe('text/plain')
  })

  it('raw: JSON としてパースできる body にだけ application/json を付ける', () => {
    expect(shape('raw', makeSettings({ rawBody: '{"a":1}' })).headers['content-type']).toBe(
      'application/json',
    )
    expect(shape('raw', makeSettings({ rawBody: '[1,2]' })).headers['content-type']).toBe(
      'application/json',
    )
    expect(shape('raw', makeSettings({ rawBody: '123' })).headers['content-type']).toBe(
      'application/json',
    )
  })

  it('raw: JSON でない body には付けない', () => {
    expect(shape('raw', makeSettings({ rawBody: 'hello world' })).headers).not.toHaveProperty(
      'content-type',
    )
    expect(shape('raw', makeSettings({ rawBody: '{broken' })).headers).not.toHaveProperty(
      'content-type',
    )
  })

  it('raw: body が無ければ付けない', () => {
    expect(shape('raw', makeSettings({ rawBody: '' })).headers).not.toHaveProperty('content-type')
  })

  it('raw: 明示した content-type は維持する', () => {
    const settings = makeSettings({
      rawBody: '{"a":1}',
      headers: [newHeaderEntry({ name: 'content-type', value: 'text/plain' })],
    })
    expect(shape('raw', settings).headers['content-type']).toBe('text/plain')
  })
})

describe('開発プロキシ', () => {
  const absolute = 'https://api.example.com/v1/chat'
  function proxySettings(patch: Partial<ConnectionSettings> = {}): ConnectionSettings {
    return makeSettings({
      useDevProxy: true,
      credentials: 'include',
      endpoints: { ...createDefaultSettings().endpoints, 'chat-ui': absolute },
      ...patch,
    })
  }

  it('fetchUrl が PROXY_PATH になり、x-proxy-target に実際の宛先が入る', () => {
    const result = shape('chat-ui', proxySettings(), sdkInit({ messages: [] }))
    expect(result.viaProxy).toBe(true)
    expect(result.fetchUrl).toBe(PROXY_PATH)
    expect(result.targetUrl).toBe(absolute)
    expect(result.fetchInit.headers).toMatchObject({ [PROXY_TARGET_HEADER]: absolute })
  })

  it('credentials は 設定に関わらず omit に固定する', () => {
    for (const credentials of ['omit', 'same-origin', 'include'] as const) {
      const result = shape('chat-ui', proxySettings({ credentials }), sdkInit({}))
      expect(result.fetchInit.credentials).toBe('omit')
    }
  })

  it('実効ヘッダー（headers）には x-proxy-target を含めず、他のヘッダーは転送対象として保つ', () => {
    const result = shape(
      'chat-ui',
      proxySettings({ bearerToken: 'tok' }),
      sdkInit({ messages: [] }, { 'x-custom': '1' }),
    )
    expect(result.headers).toEqual({
      'content-type': 'application/json',
      'x-custom': '1',
      authorization: 'Bearer tok',
    })
    expect(result.fetchInit.headers).toEqual({
      ...result.headers,
      [PROXY_TARGET_HEADER]: absolute,
    })
  })

  it('ユーザーが x-proxy-target を指定しても実際の宛先で上書きし、実効ヘッダーには出さない', () => {
    const settings = proxySettings({
      headers: [newHeaderEntry({ name: 'X-Proxy-Target', value: 'http://evil.example/' })],
    })
    const result = shape('chat-ui', settings, sdkInit({}))
    expect((result.fetchInit.headers as Record<string, string>)[PROXY_TARGET_HEADER]).toBe(absolute)
    expect(result.headers).not.toHaveProperty(PROXY_TARGET_HEADER)
  })

  it('相対パスのエンドポイントは location があっても RequestShapeError', () => {
    vi.stubGlobal('location', { href: 'http://app.test:5173/' })
    const settings = proxySettings({
      endpoints: { ...createDefaultSettings().endpoints, 'chat-ui': '/api/chat' },
    })
    expectShapeError(
      () => shape('chat-ui', settings, sdkInit({})),
      'プロキシ利用時は絶対URLを指定してください',
    )
  })

  it('空のエンドポイントは相対 URL エラーではなく入力エラーを優先する', () => {
    const settings = proxySettings({
      endpoints: { ...createDefaultSettings().endpoints, 'chat-ui': '' },
    })
    expectShapeError(() => shape('chat-ui', settings), 'エンドポイントを入力してください')
  })

  it('プロキシ不使用なら fetchUrl は targetUrl、credentials は設定どおり、x-proxy-target なし', () => {
    for (const credentials of ['omit', 'same-origin', 'include'] as const) {
      const result = shape(
        'chat-ui',
        makeSettings({ credentials, useDevProxy: false }),
        sdkInit({}),
      )
      expect(result.viaProxy).toBe(false)
      expect(result.fetchUrl).toBe(result.targetUrl)
      expect(result.fetchInit.credentials).toBe(credentials)
      expect(result.fetchInit.headers).not.toHaveProperty(PROXY_TARGET_HEADER)
    }
  })

  it('プロキシ不使用のとき相対パスは通る', () => {
    const settings = makeSettings({
      endpoints: { ...createDefaultSettings().endpoints, 'chat-ui': '/api/chat' },
    })
    expect(() => shape('chat-ui', settings)).not.toThrow()
  })

  it('raw でも同様にプロキシ経由になる', () => {
    const settings = proxySettings({
      endpoints: { ...createDefaultSettings().endpoints, raw: 'https://x.example/json' },
      rawBody: '{"a":1}',
    })
    const result = shape('raw', settings)
    expect(result.fetchUrl).toBe(PROXY_PATH)
    expect(result.fetchInit.headers).toMatchObject({
      [PROXY_TARGET_HEADER]: 'https://x.example/json',
      'content-type': 'application/json',
    })
    expect(result.fetchInit.body).toBe('{"a":1}')
  })
})

describe('fetchInit と戻り値の構造', () => {
  it('SDK 形式の init から必要最小限の fetchInit を作る', () => {
    const controller = new AbortController()
    const settings = makeSettings({ credentials: 'include' })
    const result = shape('chat-ui', settings, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
      credentials: 'omit',
      signal: controller.signal,
      cache: 'no-store',
    })
    expect(Object.keys(result.fetchInit).sort()).toEqual(
      ['body', 'cache', 'credentials', 'headers', 'method', 'signal'].sort(),
    )
    // credentials は SDK 側の指定ではなく設定画面の値を使う
    expect(result.fetchInit.credentials).toBe('include')
    expect(result.fetchInit.signal).toBe(controller.signal)
    expect(result.fetchInit.method).toBe('POST')
    expect(result.fetchInit.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('signal が無ければキーごと省く', () => {
    const result = shape('chat-ui', makeSettings(), sdkInit({}))
    expect(result.fetchInit).not.toHaveProperty('signal')
  })

  it.each<[Mode, boolean]>([
    ['chat-ui', false],
    ['chat-text', false],
    ['completion', false],
    ['raw', false],
    ['raw', true],
  ])('%s（プロキシ %s）でも HTTP キャッシュを使わない', (mode, useDevProxy) => {
    // プロキシ経由は URL が常に /__proxy なので、キャッシュが宛先違いの応答を返し得る
    const settings = makeSettings({
      useDevProxy,
      endpoints: { ...makeSettings().endpoints, [mode]: 'http://localhost:28787/api/x' },
      rawMethod: 'GET',
    })
    expect(shape(mode, settings, sdkInit({})).fetchInit.cache).toBe('no-store')
  })

  it('init を省略しても動く（chat は POST・body なし）', () => {
    const result = shape('chat-ui', makeSettings())
    expect(result.method).toBe('POST')
    expect(result.requestBody).toBeUndefined()
    expect(result.headers).toEqual({})
  })

  it('requestBody は実際に送る body 文字列と一致する', () => {
    const result = shape(
      'chat-ui',
      makeSettings({ extraBody: '{"k":1}' }),
      sdkInit({ messages: [1, 2] }),
    )
    expect(result.fetchInit.body).toBe(result.requestBody)
  })

  it('同じ入力から毎回同じ結果を返す（副作用なし）', () => {
    const settings = makeSettings({
      bearerToken: 'tok',
      extraBody: '{"k":1}',
      headers: [newHeaderEntry({ name: 'x-a', value: '1' })],
    })
    const init = sdkInit({ messages: [1, 2] })
    expect(shape('chat-ui', settings, init)).toEqual(shape('chat-ui', settings, init))
  })
})

describe('ブラウザの fetch が送らないヘッダー（forbidden request-header）', () => {
  const withHeaders = (...pairs: Array<[string, string]>) =>
    makeSettings({ headers: pairs.map(([name, value]) => newHeaderEntry({ name, value })) })

  it('設定の Cookie / Origin は、実効ヘッダーにも fetch の headers にも入れず、名前だけ droppedHeaders に残す', () => {
    const result = shape(
      'chat-ui',
      withHeaders(['Cookie', 'session=abc'], ['Origin', 'https://evil.example'], ['x-ok', '1']),
      sdkInit({ messages: [] }),
    )
    expect(result.headers).toEqual({ 'content-type': 'application/json', 'x-ok': '1' })
    expect(result.fetchInit.headers).toEqual({ 'content-type': 'application/json', 'x-ok': '1' })
    expect(result.droppedHeaders).toEqual(['cookie', 'origin'])
    // 値（Cookie の中身など）はログに載せない
    expect(JSON.stringify(result.droppedHeaders)).not.toContain('abc')
  })

  it('SDK が渡した init.headers に禁止ヘッダーがあっても同じ', () => {
    const result = shape('chat-ui', makeSettings(), sdkInit({}, { Referer: 'https://x.example/' }))
    expect(result.headers).not.toHaveProperty('referer')
    expect(result.droppedHeaders).toEqual(['referer'])
  })

  it('禁止ヘッダーが無ければ droppedHeaders は空配列', () => {
    const result = shape('chat-ui', withHeaders(['x-a', '1']), sdkInit({}))
    expect(result.droppedHeaders).toEqual([])
  })

  it.each([
    'Host',
    'Content-Length',
    'Accept-Encoding',
    'Connection',
    'Proxy-Authorization',
    'Sec-Fetch-Mode',
  ])('%s も取り除いて droppedHeaders に残す', (name) => {
    const result = shape('raw', withHeaders([name, 'v']))
    expect(result.headers).not.toHaveProperty(name.toLowerCase())
    expect(result.droppedHeaders).toEqual([name.toLowerCase()])
  })

  it('メソッド上書きヘッダーは、禁止メソッドを値にしたときだけ落とす', () => {
    expect(shape('raw', withHeaders(['X-HTTP-Method-Override', 'TRACE'])).droppedHeaders).toEqual([
      'x-http-method-override',
    ])
    const kept = shape('raw', withHeaders(['X-HTTP-Method-Override', 'PUT']))
    expect(kept.droppedHeaders).toEqual([])
    expect(kept.headers['x-http-method-override']).toBe('PUT')
  })

  it('同じヘッダーを何度指定しても、名前は 1 回だけ（大文字小文字は区別しない）', () => {
    const result = shape('raw', withHeaders(['Cookie', 'a=1'], ['cookie', 'b=2']))
    expect(result.droppedHeaders).toEqual(['cookie'])
  })

  it('無効（enabled: false）にしたヘッダーは、指定していないのと同じで droppedHeaders に出さない', () => {
    const settings = makeSettings({
      headers: [newHeaderEntry({ name: 'Cookie', value: 'a=1', enabled: false })],
    })
    expect(shape('raw', settings).droppedHeaders).toEqual([])
  })

  it('Bearer トークンから作る Authorization は送れるので、そのまま残る', () => {
    const result = shape('raw', makeSettings({ bearerToken: 'tok' }))
    expect(result.headers.authorization).toBe('Bearer tok')
    expect(result.droppedHeaders).toEqual([])
  })

  it('プロキシ経由でも、禁止ヘッダーは fetch に渡さない。x-proxy-target は「落とされたヘッダー」ではない', () => {
    const settings = makeSettings({
      useDevProxy: true,
      // body の無い GET にして、content-type が付かない状態で比べる
      rawMethod: 'GET',
      endpoints: { ...createDefaultSettings().endpoints, raw: 'https://x.example/json' },
      headers: [newHeaderEntry({ name: 'Cookie', value: 'a=1' })],
    })
    const result = shape('raw', settings)
    expect(result.droppedHeaders).toEqual(['cookie'])
    expect(result.fetchInit.headers).toEqual({ [PROXY_TARGET_HEADER]: 'https://x.example/json' })
    expect(result.headers).toEqual({})
  })

  it('不正な文字を含む禁止ヘッダーは、取り除く前に RequestShapeError で止める', () => {
    expectShapeError(() => shape('raw', withHeaders(['Cookie', 'a=あ'])), /Cookie/)
  })
})
