import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNetworkLog, networkLog } from '@/lib/network-log'
import type { NetworkLogStore } from '@/lib/network-log'
import { PROXY_TOGGLE_LABEL } from '@/lib/proxy'
import { RequestShapeError } from '@/lib/request-shaper'
import { createDefaultSettings } from '@/lib/settings'
import { settingsStore } from '@/lib/settings-store'
import { STREAM_CANCELLED_ERROR } from '@/lib/stream-analyzer'
import { createTesterFetch } from '@/lib/tester-fetch'
import type { ConnectionSettings, Mode, NetworkLogEntry } from '@/types'

const encoder = new TextEncoder()
const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'x-vercel-ai-ui-message-stream': 'v1',
}

/** チャンクを 1 つずつ（非同期に）流す ReadableStream。strings は UTF-8 に、Uint8Array はそのまま流す。 */
function streamOf(
  chunks: Array<string | Uint8Array>,
  opts: { failAfter?: Error } = {},
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 1))
      const chunk = chunks[i++]
      if (chunk !== undefined) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
        return
      }
      if (opts.failAfter) controller.error(opts.failAfter)
      else controller.close()
    },
  })
}

function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  return new Response(streamOf(chunks), { status: 200, headers: SSE_HEADERS, ...init })
}

function newLog(): NetworkLogStore {
  // 通知は使わないので何もしないスケジューラーにする（状態は getEntry で読む）
  return createNetworkLog({ schedule: () => () => {}, pageOrigin: () => 'http://localhost:5173' })
}

function settingsWith(over: Partial<ConnectionSettings> = {}): ConnectionSettings {
  return { ...createDefaultSettings(), ...over }
}

const TERMINAL = new Set(['done', 'error', 'aborted'])

/** ログ側の読み取りはバックグラウンドで進むので、終端状態になるまで待つ。 */
async function settled(log: NetworkLogStore, id: string): Promise<NetworkLogEntry> {
  for (let i = 0; i < 400; i++) {
    const entry = log.getEntry(id)
    if (entry !== undefined && TERMINAL.has(entry.state)) return entry
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`エントリ ${id} が終端状態になりませんでした`)
}

function selectedId(log: NetworkLogStore): string {
  const id = log.getSelectedId()
  if (id === null) throw new Error('エントリがありません')
  return id
}

interface Harness {
  log: NetworkLogStore
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>
  run: (init?: RequestInit, input?: RequestInfo | URL) => Promise<Response>
}

function harness(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  opts: { mode?: Mode; settings?: ConnectionSettings; getSettings?: () => ConnectionSettings } = {},
): Harness {
  const log = newLog()
  const settings = opts.settings ?? settingsWith()
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => respond(String(input), init ?? {}))
  const tester = createTesterFetch({
    mode: opts.mode ?? 'chat-ui',
    getSettings: opts.getSettings ?? (() => settings),
    log,
    fetchImpl,
  })
  const chatBody = JSON.stringify({ id: 'c1', messages: [{ role: 'user', content: 'hi' }] })
  return {
    log,
    fetchImpl,
    run: (init, input = 'http://ignored.invalid/') =>
      tester(input, { method: 'POST', body: chatBody, ...init }),
  }
}

afterEach(() => {
  networkLog.clear()
  settingsStore.reset()
})

describe('createTesterFetch: SSE（UI Message Stream）', () => {
  const WIRE = [
    'data: {"type":"start","messageId":"m1"}\n\n',
    'data: {"type":"text-start","id":"t1"}\n\ndata: {"type":"text-de',
    'lta","id":"t1","delta":"こんにちは"}\n\n',
    'data: {"type":"text-end","id":"t1"}\n\ndata: {"type":"finish"}\n\n',
    'data: [DONE]\n\n',
  ]

  it('アプリ側には全チャンクがそのまま届き、ログにはイベントが入る', async () => {
    const h = harness(() => sseResponse(WIRE))
    const res = await h.run()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe(WIRE.join(''))

    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.state).toBe('done')
    expect(entry.events.map((e) => e.kind)).toEqual([
      'sse-json',
      'sse-json',
      'sse-json',
      'sse-json',
      'sse-json',
      'sse-done',
    ])
    expect(entry.events.map((e) => e.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
      undefined,
    ])
    expect(entry.events.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(entry.rawBody).toBe(WIRE.join(''))
    expect(entry.bytesReceived).toBe(encoder.encode(WIRE.join('')).length)
    expect(entry.status).toBe(200)
    expect(entry.statusText).toBe('')
    expect(entry.responseHeaders).toMatchObject(SSE_HEADERS)
    expect(entry.ttfbMs).toBeGreaterThanOrEqual(0)
    expect(entry.totalMs).toBeGreaterThanOrEqual(entry.ttfbMs ?? 0)
    const summary = entry.diagnostics.find((d) => d.id === 'summary')
    expect(summary?.level).toBe('ok')
    expect(entry.diagnostics.every((d) => d.level === 'ok')).toBe(true)
  })

  it('リクエストの内容（URL・メソッド・ヘッダー・body）がログに入る', async () => {
    const h = harness(() => sseResponse([]), {
      settings: settingsWith({ bearerToken: 'sk-test-token' }),
    })
    const res = await h.run({ headers: { 'X-Trace': 'abc' } })
    await res.text()
    const entry = await settled(h.log, selectedId(h.log))

    expect(entry).toMatchObject({
      mode: 'chat-ui',
      method: 'POST',
      targetUrl: 'http://localhost:28787/api/chat',
      viaProxy: false,
    })
    expect(entry.requestHeaders).toMatchObject({
      'x-trace': 'abc',
      authorization: 'Bearer sk-test-token',
      'content-type': 'application/json',
    })
    expect(JSON.parse(entry.requestBody ?? '')).toMatchObject({ id: 'c1' })

    // fetch に渡したものと、ログに残したものが一致する
    const [url, init] = h.fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('http://localhost:28787/api/chat')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(entry.requestBody)
    expect(init?.headers).toEqual(entry.requestHeaders)
  })

  it('input の URL は無視し、設定のエンドポイントへ送る', async () => {
    const h = harness(() => sseResponse([]))
    await (await h.run({}, 'http://ignored.invalid/api/other')).text()
    expect(h.fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:28787/api/chat')
  })

  it('Request オブジェクトや URL オブジェクトを input に渡しても動く', async () => {
    const h = harness(() => sseResponse([]))
    await (await h.run({}, new URL('http://ignored.invalid/'))).text()
    await (await h.run({}, new Request('http://ignored.invalid/'))).text()
    expect(h.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('設定は呼び出しの時点で読み直す（ヘッダー・エンドポイントの変更が次のリクエストに効く）', async () => {
    let settings = settingsWith()
    const h = harness(() => sseResponse([]), { getSettings: () => settings })
    await (await h.run()).text()
    settings = settingsWith({
      endpoints: { ...settings.endpoints, 'chat-ui': 'http://other.test/v2/chat' },
      bearerToken: 'next-token',
    })
    await (await h.run()).text()

    expect(h.fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:28787/api/chat')
    expect(h.fetchImpl.mock.calls[1]?.[0]).toBe('http://other.test/v2/chat')
    expect(h.fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer next-token',
    })
    expect(h.log.getEntries()).toHaveLength(2)
    expect(h.log.getEntries()[0]?.targetUrl).toBe('http://other.test/v2/chat')
  })

  it('追加ボディ・最後の 1 件のみの設定が body に反映され、ログにも同じものが残る', async () => {
    const h = harness(() => sseResponse([]), {
      settings: settingsWith({ extraBody: '{"model":"x"}', sendLastMessageOnly: true }),
    })
    const body = JSON.stringify({ messages: [{ id: 'a' }, { id: 'b' }] })
    await (await h.run({ body })).text()
    const sent = h.fetchImpl.mock.calls[0]?.[1]?.body
    expect(JSON.parse(String(sent))).toEqual({ messages: [{ id: 'b' }], model: 'x' })
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.requestBody).toBe(sent)
  })

  it('リクエストの signal はそのまま fetch に渡る', async () => {
    const h = harness(() => sseResponse([]))
    const controller = new AbortController()
    await (await h.run({ signal: controller.signal })).text()
    expect(h.fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
  })

  it('マルチバイト文字がチャンクの途中で割れても、ログには正しい文字列が残る', async () => {
    const bytes = encoder.encode('data: {"type":"text-delta","id":"t","delta":"あ😀"}\n\n')
    const cut = bytes.indexOf(0xe3) + 1 // 「あ」の 1 バイト目の直後
    const cut2 = bytes.indexOf(0xf0) + 2 // 絵文字の途中
    const h = harness(
      () =>
        new Response(streamOf([bytes.slice(0, cut), bytes.slice(cut, cut2), bytes.slice(cut2)]), {
          headers: SSE_HEADERS,
        }),
    )
    const res = await h.run()
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.events[0]?.data).toEqual({ type: 'text-delta', id: 't', delta: 'あ😀' })
    expect(entry.rawBody).not.toContain('�')
    expect(entry.bytesReceived).toBe(bytes.length)
  })

  it('アプリ側が読み終わる前でも、ログへの記録は進む（読み取りが独立している）', async () => {
    const h = harness(() => sseResponse(WIRE))
    const res = await h.run()
    const id = selectedId(h.log)
    // アプリ側はまだ 1 バイトも読んでいない
    const entry = await settled(h.log, id)
    expect(entry.state).toBe('done')
    expect(entry.events).toHaveLength(6)
    expect(await res.text()).toBe(WIRE.join(''))
  })

  it('壊れた SSE や順序違反は診断に出る', async () => {
    const h = harness(() =>
      sseResponse(['data: {"type":"text-delta","id":"x","delta":"a"}\n\ndata: oops\n\n']),
    )
    await (await h.run()).text()
    const entry = await settled(h.log, selectedId(h.log))
    const ids = entry.diagnostics.map((d) => d.id)
    expect(ids).toContain('sse-invalid-json')
    expect(ids).toContain('ui-chunk-order')
    expect(entry.diagnostics[0]?.level).toBe('error')
  })

  it('HTTP エラー（ボディあり）も、ステータス・ヘッダー・本文がアプリ側に届き、診断される', async () => {
    const h = harness(
      () =>
        new Response('{"error":{"message":"Invalid API key"}}', {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        }),
    )
    const res = await h.run()
    expect(res.ok).toBe(false)
    expect(res.status).toBe(401)
    expect(res.statusText).toBe('Unauthorized')
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ error: { message: 'Invalid API key' } })

    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.state).toBe('done')
    expect(entry.status).toBe(401)
    expect(entry.events).toEqual([
      expect.objectContaining({
        kind: 'text-chunk',
        raw: '{"error":{"message":"Invalid API key"}}',
      }),
    ])
    const status = entry.diagnostics.find((d) => d.id === 'http-status')
    expect(status?.level).toBe('error')
    expect(status?.detail).toContain('Invalid API key')
    expect(entry.diagnostics.find((d) => d.id === 'summary')).toBeUndefined()
  })
})

describe('createTesterFetch: 非 SSE', () => {
  it('Text Stream は text-chunk イベントとして記録され、アプリ側にも全文が届く', async () => {
    const h = harness(
      () =>
        new Response(streamOf(['Hel', 'lo, ', 'world']), {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      { mode: 'chat-text' },
    )
    const res = await h.run()
    expect(await res.text()).toBe('Hello, world')
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.events.map((e) => [e.kind, e.raw])).toEqual([
      ['text-chunk', 'Hel'],
      ['text-chunk', 'lo, '],
      ['text-chunk', 'world'],
    ])
    expect(entry.rawBody).toBe('Hello, world')
    // SSE 前提の診断は出ない
    expect(entry.diagnostics.map((d) => d.id).sort()).toEqual(['http-status', 'summary'])
  })

  it('Text Stream モードに SSE が返ってきたら、本文は SSE として解析せず content-type を警告する', async () => {
    const h = harness(() => sseResponse(['data: {"type":"start"}\n\n']), { mode: 'chat-text' })
    await (await h.run()).text()
    const entry = await settled(h.log, selectedId(h.log))
    // content-type が SSE なので、イベントとしては解析される（モードに関わらず中身を見られるように）
    expect(entry.events[0]?.kind).toBe('sse-json')
    expect(entry.diagnostics.find((d) => d.id === 'content-type')?.level).toBe('warn')
  })

  it('Raw モード: 設定のメソッド・body で送り、JSON 以外の応答も記録する', async () => {
    const h = harness(
      () =>
        new Response('plain response', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      {
        mode: 'raw',
        settings: settingsWith({ rawMethod: 'PUT', rawBody: '{"a":1}' }),
      },
    )
    const res = await h.run({ method: undefined, body: undefined })
    expect(await res.text()).toBe('plain response')
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.method).toBe('PUT')
    expect(entry.requestBody).toBe('{"a":1}')
    expect(entry.targetUrl).toBe('http://localhost:28787/api/json')
    expect(entry.mode).toBe('raw')
    expect(entry.rawBody).toBe('plain response')
  })

  it('Raw モードの GET は body なしで送る', async () => {
    const h = harness(
      () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      {
        mode: 'raw',
        settings: settingsWith({ rawMethod: 'GET' }),
      },
    )
    await (await h.run({ method: undefined, body: undefined })).text()
    const init = h.fetchImpl.mock.calls[0]?.[1]
    expect(init?.method).toBe('GET')
    expect(init).not.toHaveProperty('body')
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.requestBody).toBeUndefined()
  })
})

describe('createTesterFetch: プロキシ', () => {
  it('プロキシ経由なら /__proxy へ x-proxy-target 付きで送り、ログには実際の宛先を残す', async () => {
    const h = harness(() => sseResponse(['data: {"type":"start"}\n\n']), {
      settings: settingsWith({ useDevProxy: true, bearerToken: 'tok' }),
    })
    await (await h.run()).text()

    const [url, init] = h.fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('/__proxy')
    expect(init?.headers).toMatchObject({
      'x-proxy-target': 'http://localhost:28787/api/chat',
      authorization: 'Bearer tok',
    })
    expect(init?.credentials).toBe('omit')

    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.viaProxy).toBe(true)
    expect(entry.targetUrl).toBe('http://localhost:28787/api/chat')
    // 宛先に届くヘッダーを記録する（x-proxy-target は含めない）
    expect(entry.requestHeaders).not.toHaveProperty('x-proxy-target')
    expect(entry.requestHeaders.authorization).toBe('Bearer tok')
  })

  it('プロキシが動いていない（SPA の index.html が返る）ことを診断する', async () => {
    const h = harness(
      () =>
        new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      { settings: settingsWith({ useDevProxy: true }) },
    )
    await (await h.run()).text()
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.diagnostics.find((d) => d.id === 'proxy-unavailable')?.level).toBe('error')
  })

  it('プロキシ自身のエラー（x-proxy-error）を診断する', async () => {
    const h = harness(
      () =>
        new Response('{"error":"proxy_error","message":"fetch failed: ECONNREFUSED"}', {
          status: 502,
          headers: { 'content-type': 'application/json', 'x-proxy-error': '1' },
        }),
      { settings: settingsWith({ useDevProxy: true }) },
    )
    await (await h.run()).text()
    const entry = await settled(h.log, selectedId(h.log))
    const d = entry.diagnostics.find((x) => x.id === 'proxy-error')
    expect(d?.detail).toContain('ECONNREFUSED')
  })
})

describe('createTesterFetch: 中断', () => {
  it('ストリーム中の abort はアプリ側にも AbortError として伝わり、ログは aborted になる', async () => {
    const controller = new AbortController()
    const h = harness((_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('data: {"type":"start"}\n\n'))
          init.signal?.addEventListener('abort', () =>
            c.error(new DOMException('This operation was aborted', 'AbortError')),
          )
        },
      })
      return new Response(stream, { headers: SSE_HEADERS })
    })
    const res = await h.run({ signal: controller.signal })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)

    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })

    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.state).toBe('aborted')
    expect(entry.error).toBeUndefined()
    // それまでに受信した分は残る
    expect(entry.events.map((e) => e.type)).toEqual(['start'])
    expect(entry.diagnostics.find((d) => d.id === 'aborted')?.level).toBe('info')
    expect(entry.diagnostics.find((d) => d.id === 'network-error')).toBeUndefined()
  })

  it('レスポンスを受け取る前の abort も aborted で、AbortError をそのまま投げ直す', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness((_url, init) => {
      throw init.signal?.reason
    })
    await expect(h.run({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.state).toBe('aborted')
    expect(entry.status).toBeUndefined()
  })

  it('abort(reason) で reason がそのまま reject されても aborted として扱う', async () => {
    const controller = new AbortController()
    const h = harness((_url, init) => {
      throw init.signal?.reason
    })
    controller.abort(new Error('user cancelled'))
    await expect(h.run({ signal: controller.signal })).rejects.toThrow('user cancelled')
    expect((await settled(h.log, selectedId(h.log))).state).toBe('aborted')
  })

  it('タイムアウトは中断ではなく失敗として扱う', async () => {
    const controller = new AbortController()
    const timeout = new DOMException('The operation timed out', 'TimeoutError')
    controller.abort(timeout)
    const h = harness(() => {
      throw timeout
    })
    await expect(h.run({ signal: controller.signal })).rejects.toBe(timeout)
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.state).toBe('error')
    expect(entry.error?.name).toBe('TimeoutError')
  })
})

describe('createTesterFetch: アプリ側が読み取りを打ち切ったとき', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 読み続ける限りイベントを流し続ける上流。pull の回数と、上流が cancel されたかを数える。 */
  function endlessUpstream() {
    const probe = { pulls: 0, cancelled: false, cancelReason: undefined as unknown }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        probe.pulls++
        await sleep(1)
        controller.enqueue(encoder.encode('data: {"type":"text-delta","id":"t1","delta":"x"}\n\n'))
      },
      cancel(reason) {
        probe.cancelled = true
        probe.cancelReason = reason
      },
    })
    return { probe, response: new Response(stream, { status: 200, headers: SSE_HEADERS }) }
  }

  it('アプリ側が cancel したら上流の読み取りも止まり、ログは StreamCancelled で終端する', async () => {
    const { probe, response } = endlessUpstream()
    const h = harness(() => response)
    const res = await h.run()
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    expect((await reader.read()).done).toBe(false)

    // SDK が不正な chunk を見つけて、レスポンスの読み取りをやめた状況。
    // cancel() の完了は上流が止まるまで待たされるので、ここでは待たずにログの終端を確かめる（退行時に 30 秒止まらない）
    const cancelled = reader.cancel(new Error('Type validation failed'))

    const entry = await settled(h.log, selectedId(h.log))
    await cancelled
    expect(entry.state).toBe('error')
    expect(entry.error?.name).toBe(STREAM_CANCELLED_ERROR)
    expect(entry.error?.message).toContain('Type validation failed')
    expect(entry.error?.hint).toContain('クライアント（AI SDK）が読み取りをやめました')
    expect(entry.totalMs).toBeDefined()
    // 切断されたのではなく SDK が打ち切った、と診断する（途中切断やネットワークエラーとは言わない）
    const diagnosticIds = entry.diagnostics.map((d) => d.id)
    expect(diagnosticIds).toContain('stream-cancelled')
    expect(diagnosticIds).not.toContain('network-error')
    expect(diagnosticIds).not.toContain('ui-stream-truncated')
    expect(diagnosticIds).not.toContain('summary')

    // 接続が閉じる: 上流が cancel され、その後は読まれない
    await vi.waitFor(() => expect(probe.cancelled).toBe(true))
    const pullsAtCancel = probe.pulls
    await sleep(60)
    expect(probe.pulls).toBe(pullsAtCancel)
    // 打ち切りまでに受信した分はログに残る
    expect(entry.events.length).toBeGreaterThan(0)
    expect(h.log.getEntry(entry.id)?.events.length).toBe(entry.events.length)
  })

  it('cancel の理由が渡されなくても、打ち切りとして終端する', async () => {
    const { probe, response } = endlessUpstream()
    const h = harness(() => response)
    const res = await h.run()
    const cancelled = (res.body as ReadableStream<Uint8Array>).cancel()

    const entry = await settled(h.log, selectedId(h.log))
    await cancelled
    expect(entry.error?.name).toBe(STREAM_CANCELLED_ERROR)
    expect(entry.error?.message).toContain('理由は渡されていません')
    await vi.waitFor(() => expect(probe.cancelled).toBe(true))
  })

  it('停止ボタンの abort のあとの cancel は、エラーではなく aborted として残す', async () => {
    const controller = new AbortController()
    const { probe, response } = endlessUpstream()
    const h = harness(() => response)
    const res = await h.run({ signal: controller.signal })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()

    controller.abort()
    const cancelled = reader.cancel()

    const entry = await settled(h.log, selectedId(h.log))
    await cancelled
    expect(entry.state).toBe('aborted')
    expect(entry.error).toBeUndefined()
    expect(entry.diagnostics.map((d) => d.id)).toContain('aborted')
    await vi.waitFor(() => expect(probe.cancelled).toBe(true))
  })

  it('ストリームを最後まで読み切ったあとの cancel は、完了を打ち切りに書き換えない', async () => {
    const h = harness(() =>
      sseResponse(['data: {"type":"start"}\n\n', 'data: {"type":"finish"}\n\n']),
    )
    const res = await h.run()
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    while (!(await reader.read()).done) {
      // 読み切る
    }
    const entry = await settled(h.log, selectedId(h.log))
    await reader.cancel().catch(() => {})
    await sleep(10)
    expect(h.log.getEntry(entry.id)?.state).toBe('done')
    expect(h.log.getEntry(entry.id)?.error).toBeUndefined()
  })

  it('アプリ側が cancel しても、その時点までのレスポンスはログに全部残る（ログ側の読み取りは先に進んでいる）', async () => {
    const { response } = endlessUpstream()
    const h = harness(() => response)
    const res = await h.run()
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await sleep(20)
    const cancelled = reader.cancel(new Error('x'))
    const entry = await settled(h.log, selectedId(h.log))
    await cancelled
    expect(entry.rawBody.startsWith('data: {"type":"text-delta"')).toBe(true)
    expect(entry.bytesReceived).toBe(encoder.encode(entry.rawBody).length)
  })
})

describe('createTesterFetch: 失敗', () => {
  it('fetch の失敗は同じエラーを投げ直し、ヒントつきでログに残す（CORS / 接続不可）', async () => {
    const failure = new TypeError('Failed to fetch')
    const h = harness(() => {
      throw failure
    })
    await expect(h.run()).rejects.toBe(failure)

    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.state).toBe('error')
    expect(entry.status).toBeUndefined()
    expect(entry.error?.name).toBe('TypeError')
    expect(entry.error?.message).toBe('Failed to fetch')
    expect(entry.error?.hint).toContain('CORS')
    // 設定画面のトグルと同じ名前で、回避策を案内する
    expect(entry.error?.hint).toContain(`「${PROXY_TOGGLE_LABEL}」`)
    expect(entry.targetUrl).toBe('http://localhost:28787/api/chat')
    // 別オリジン（pageOrigin は localhost:5173）への失敗なので CORS として診断される
    expect(entry.diagnostics.find((d) => d.id === 'network-error')?.title).toContain('CORS')
  })

  it.each(['NetworkError when attempting to fetch resource.', 'Load failed', 'fetch failed'])(
    '他のブラウザの文言（%s）にもヒントを付ける',
    async (message) => {
      const h = harness(() => {
        throw new TypeError(message)
      })
      await expect(h.run()).rejects.toThrow(message)
      expect((await settled(h.log, selectedId(h.log))).error?.hint).toBeDefined()
    },
  )

  it('プロキシ経由の fetch 失敗にはプロキシ向けのヒントを付ける', async () => {
    const h = harness(
      () => {
        throw new TypeError('Failed to fetch')
      },
      { settings: settingsWith({ useDevProxy: true }) },
    )
    await expect(h.run()).rejects.toThrow()
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.error?.hint).toContain('/__proxy')
    expect(entry.error?.hint).not.toContain('CORS')
  })

  it('fetch 失敗以外のエラーにはヒントを付けない', async () => {
    const h = harness(() => {
      throw new Error('boom')
    })
    await expect(h.run()).rejects.toThrow('boom')
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.error).toEqual({ name: 'Error', message: 'boom' })
  })

  it('Error 以外が投げられても落ちない', async () => {
    const h = harness(() => {
      throw 'just a string'
    })
    await expect(h.run()).rejects.toBe('just a string')
    expect((await settled(h.log, selectedId(h.log))).error).toEqual({
      name: 'Error',
      message: 'just a string',
    })
  })

  it('ストリーム途中の切断は、アプリ側にもエラーが伝わり、ログは error になる', async () => {
    const failure = new TypeError('terminated')
    const h = harness(
      () =>
        new Response(streamOf(['data: {"type":"start"}\n\n'], { failAfter: failure }), {
          headers: SSE_HEADERS,
        }),
    )
    const res = await h.run()
    await expect(res.text()).rejects.toThrow('terminated')

    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.state).toBe('error')
    expect(entry.status).toBe(200)
    expect(entry.error?.message).toBe('terminated')
    expect(entry.error?.hint).toContain('切断')
    expect(entry.events.map((e) => e.type)).toEqual(['start'])
    expect(entry.diagnostics.find((d) => d.id === 'ui-stream-truncated')?.level).toBe('error')
  })

  it('RequestShapeError: ログに begin → finish(error) を残してから同じエラーを投げる', async () => {
    const h = harness(() => sseResponse([]), {
      settings: settingsWith({
        endpoints: { ...createDefaultSettings().endpoints, 'chat-ui': '' },
        useDevProxy: true,
      }),
    })
    const error = await h.run().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RequestShapeError)

    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.log.getEntries()).toHaveLength(1)
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.state).toBe('error')
    expect(entry.error).toEqual({
      name: 'RequestShapeError',
      message: (error as RequestShapeError).message,
    })
    expect(entry.method).toBe('POST')
    expect(entry.viaProxy).toBe(true)
    expect(entry.targetUrl).toBe('')
    expect(entry.requestHeaders).toEqual({})
    const diagnostic = entry.diagnostics.find((d) => d.id === 'network-error')
    expect(diagnostic?.title).toContain('送信できません')
    expect(diagnostic?.detail).toContain((error as RequestShapeError).message)
  })

  it('追加ボディが不正な JSON のときも RequestShapeError としてログに残る', async () => {
    const h = harness(() => sseResponse([]), { settings: settingsWith({ extraBody: '{oops' }) })
    await expect(h.run()).rejects.toBeInstanceOf(RequestShapeError)
    expect(h.fetchImpl).not.toHaveBeenCalled()
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.error?.name).toBe('RequestShapeError')
    expect(entry.targetUrl).toBe('http://localhost:28787/api/chat')
  })

  it('Raw モードの RequestShapeError では設定のメソッドを記録する', async () => {
    const h = harness(() => sseResponse([]), {
      mode: 'raw',
      settings: settingsWith({
        rawMethod: 'PATCH',
        endpoints: { ...createDefaultSettings().endpoints, raw: 'not a url' },
      }),
    })
    await expect(h.run({ method: undefined })).rejects.toBeInstanceOf(RequestShapeError)
    expect((await settled(h.log, selectedId(h.log))).method).toBe('PATCH')
  })
})

describe('createTesterFetch: ボディなしのレスポンス', () => {
  it('body が null（HEAD など）ならそのまま返し、すぐ完了にする', async () => {
    const response = new Response(null, { status: 200, headers: { 'x-a': '1' } })
    const h = harness(() => response, {
      mode: 'raw',
      settings: settingsWith({ rawMethod: 'GET' }),
    })
    const res = await h.run({ method: undefined, body: undefined })
    expect(res).toBe(response)
    const entry = h.log.getEntry(selectedId(h.log))
    expect(entry?.state).toBe('done')
    expect(entry?.status).toBe(200)
    expect(entry?.responseHeaders).toEqual({ 'x-a': '1' })
    expect(entry?.events).toEqual([])
    expect(entry?.diagnostics.find((d) => d.id === 'summary')?.level).toBe('ok')
  })

  it('204 No Content', async () => {
    const h = harness(() => new Response(null, { status: 204, statusText: 'No Content' }), {
      mode: 'raw',
    })
    const res = await h.run({ method: undefined })
    expect(res.status).toBe(204)
    expect(res.body).toBeNull()
    const entry = h.log.getEntry(selectedId(h.log))
    expect(entry?.state).toBe('done')
    expect(entry?.statusText).toBe('No Content')
  })

  it.each([204, 205, 304])(
    '%i でボディ付きの応答が来ても（モック等）、アプリへは body=null で返し、ログ用には読む',
    async (status) => {
      // Response のコンストラクターはこの組み合わせを拒否するので、本物に似せたオブジェクトで再現する
      const fake = {
        status,
        statusText: 'Odd',
        ok: status < 300,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: streamOf(['ignored by app']),
      } as unknown as Response
      const h = harness(() => fake, { mode: 'raw' })
      const res = await h.run({ method: undefined })
      expect(res.status).toBe(status)
      expect(res.statusText).toBe('Odd')
      expect(res.body).toBeNull()
      expect(await res.text()).toBe('')

      const entry = await settled(h.log, selectedId(h.log))
      expect(entry.state).toBe('done')
      expect(entry.rawBody).toBe('ignored by app')
    },
  )

  it('空のストリーム（イベント 0 件）も完了として記録する', async () => {
    const h = harness(() => new Response(streamOf([]), { headers: SSE_HEADERS }))
    const res = await h.run()
    expect(await res.text()).toBe('')
    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.state).toBe('done')
    expect(entry.diagnostics.find((d) => d.id === 'ui-stream-empty')?.level).toBe('warn')
  })
})

describe('createTesterFetch: ログ側の失敗がアプリ側に影響しない', () => {
  it('recordText / finish が例外を投げても、アプリ側には全チャンクが届く', async () => {
    const real = newLog()
    const broken: NetworkLogStore = {
      ...real,
      recordText: () => {
        throw new Error('log is broken')
      },
      finish: () => {
        throw new Error('log is broken')
      },
    }
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse(['a: 1\n\n', 'b: 2\n\n']))
    const tester = createTesterFetch({
      mode: 'chat-ui',
      getSettings: () => settingsWith(),
      log: broken,
      fetchImpl,
    })
    const res = await tester('x', { method: 'POST', body: '{}' })
    expect(await res.text()).toBe('a: 1\n\nb: 2\n\n')
  })

  it('begin / recordHead が例外を投げても、通信は続き、レスポンスが返る', async () => {
    const real = newLog()
    const broken: NetworkLogStore = {
      ...real,
      begin: () => {
        throw new Error('log is broken')
      },
      recordHead: () => {
        throw new Error('log is broken')
      },
    }
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse(['data: {}\n\n']))
    const tester = createTesterFetch({
      mode: 'chat-ui',
      getSettings: () => settingsWith(),
      log: broken,
      fetchImpl,
    })
    const res = await tester('x', { method: 'POST', body: '{}' })
    expect(await res.text()).toBe('data: {}\n\n')
  })

  it('fetch の失敗時にログが壊れていても、元のエラーがそのまま投げられる', async () => {
    const real = newLog()
    const broken: NetworkLogStore = {
      ...real,
      finish: () => {
        throw new Error('log is broken')
      },
    }
    const failure = new TypeError('Failed to fetch')
    const tester = createTesterFetch({
      mode: 'chat-ui',
      getSettings: () => settingsWith(),
      log: broken,
      fetchImpl: async () => {
        throw failure
      },
    })
    await expect(tester('x', { method: 'POST', body: '{}' })).rejects.toBe(failure)
  })
})

describe('createTesterFetch: 既定値', () => {
  it('getSettings の既定は settingsStore、log の既定は networkLog', async () => {
    settingsStore.reset()
    settingsStore.update({ bearerToken: 'from-store' })
    networkLog.clear()
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse(['data: {"type":"start"}\n\n']))
    const tester = createTesterFetch({ mode: 'chat-ui', fetchImpl })
    await (await tester('x', { method: 'POST', body: '{}' })).text()

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer from-store',
    })
    const id = selectedId(networkLog)
    expect((await settled(networkLog, id)).events).toHaveLength(1)
  })

  it('fetchImpl の既定は globalThis.fetch（呼び出し時に解決する）', async () => {
    const original = globalThis.fetch
    const spy = vi.fn<typeof fetch>(async () => sseResponse([]))
    globalThis.fetch = spy
    try {
      const tester = createTesterFetch({
        mode: 'chat-ui',
        getSettings: () => settingsWith(),
        log: newLog(),
      })
      await (await tester('x', { method: 'POST', body: '{}' })).text()
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('createTesterFetch: ブラウザが送らないヘッダー', () => {
  it('Cookie など禁止ヘッダーは fetch に渡さず、ログには名前だけ残す', async () => {
    const h = harness(() => sseResponse(['data: {"type":"start"}\n\n']), {
      settings: settingsWith({
        headers: [
          { id: 'h1', name: 'Cookie', value: 'session=top-secret', enabled: true },
          { id: 'h2', name: 'x-ok', value: '1', enabled: true },
        ],
      }),
    })
    await (await h.run()).text()

    const [, init] = h.fetchImpl.mock.calls[0] ?? []
    const sent = init?.headers as Record<string, string>
    expect(sent).not.toHaveProperty('cookie')
    expect(sent['x-ok']).toBe('1')

    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.droppedHeaders).toEqual(['cookie'])
    expect(entry.requestHeaders).not.toHaveProperty('cookie')
    expect(entry.requestHeaders['x-ok']).toBe('1')
    // 値はどこにも残らない
    expect(JSON.stringify(entry)).not.toContain('top-secret')
    expect(entry.diagnostics.find((d) => d.id === 'request-headers-dropped')?.level).toBe('warn')
  })

  it('禁止ヘッダーが無ければ droppedHeaders はキーごと無い', async () => {
    const h = harness(() => sseResponse(['data: {"type":"start"}\n\n']))
    await (await h.run()).text()
    expect(await settled(h.log, selectedId(h.log))).not.toHaveProperty('droppedHeaders')
  })
})

describe('createTesterFetch: リクエスト body の保持上限', () => {
  it('巨大な body はログには先頭だけ残し（requestBodyTruncated）、実際の送信は全文のまま', async () => {
    const attachment = `data:image/png;base64,${'A'.repeat(500_000)}`
    const body = JSON.stringify({
      id: 'c1',
      messages: [{ role: 'user', parts: [{ type: 'file', url: attachment }] }],
    })
    const h = harness(() => sseResponse(['data: {"type":"start"}\n\n']))
    await (await h.run({ body })).text()

    const [, init] = h.fetchImpl.mock.calls[0] ?? []
    expect(init?.body).toBe(body)

    const entry = await settled(h.log, selectedId(h.log))
    expect(entry.requestBodyTruncated).toBe(true)
    expect(entry.requestBody).toHaveLength(200_000)
    expect(body.startsWith(entry.requestBody ?? '')).toBe(true)
  })
})
