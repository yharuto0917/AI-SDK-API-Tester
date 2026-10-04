import { describe, expect, it } from 'vitest'
import { PROXY_NAME, PROXY_PATH, PROXY_TOGGLE_LABEL } from '@/lib/proxy'
import {
  KNOWN_UI_CHUNK_TYPES,
  STREAM_CANCELLED_ERROR,
  buildDiagnostics,
} from '@/lib/stream-analyzer'
import type { Diagnostic, Mode, NetworkLogEntry, StreamEvent } from '@/types'

type Chunk = Record<string, unknown> & { type: string }

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'x-vercel-ai-ui-message-stream': 'v1',
}

function makeEntry(over: Partial<NetworkLogEntry> = {}): NetworkLogEntry {
  return {
    id: 'log-1',
    mode: 'chat-ui',
    startedAt: 0,
    method: 'POST',
    targetUrl: 'http://localhost:5173/api/chat',
    viaProxy: false,
    requestHeaders: {},
    state: 'done',
    status: 200,
    statusText: 'OK',
    responseHeaders: { ...SSE_HEADERS },
    ttfbMs: 120,
    totalMs: 1500,
    events: [],
    eventsTruncated: false,
    rawBody: '',
    rawBodyTruncated: false,
    bytesReceived: 0,
    diagnostics: [],
    ...over,
  }
}

/** UI Message Stream の chunk 列を sse-json イベント列にする（index は 0 始まりの通し番号）。 */
function jsonEvents(chunks: Chunk[], startIndex = 0): StreamEvent[] {
  return chunks.map((chunk, i) => ({
    index: startIndex + i,
    atMs: 10 * (startIndex + i),
    kind: 'sse-json',
    type: chunk.type,
    data: chunk,
    raw: JSON.stringify(chunk),
  }))
}

function doneEvent(index: number): StreamEvent {
  return { index, atMs: index * 10, kind: 'sse-done', raw: '[DONE]' }
}

/** 完了した UI Message Stream（既定で [DONE] 付き）。 */
function uiEntry(
  chunks: Chunk[],
  over: Partial<NetworkLogEntry> = {},
  opts: { done?: boolean } = {},
): NetworkLogEntry {
  const events = jsonEvents(chunks)
  if (opts.done ?? true) events.push(doneEvent(events.length))
  return makeEntry({ events, ...over })
}

const HELLO: Chunk[] = [
  { type: 'start', messageId: 'm1' },
  { type: 'start-step' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Hel' },
  { type: 'text-delta', id: 't1', delta: 'lo' },
  { type: 'text-end', id: 't1' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
]

const ids = (list: Diagnostic[]) => list.map((d) => d.id)
const find = (list: Diagnostic[], id: string) => list.find((d) => d.id === id)

function diagnose(entry: NetworkLogEntry, pageOrigin?: string): Diagnostic[] {
  return buildDiagnostics(entry, pageOrigin === undefined ? undefined : { pageOrigin })
}

/**
 * 実際の AI SDK（useChat と同じ processUIMessageStream）が、この chunk 列でエラーにするか。
 * message を渡すと、リクエストの最後のアシスタントメッセージに応答を続けるときと同じ初期状態で処理する。
 */
async function sdkRejects(chunks: Chunk[], message?: unknown): Promise<boolean> {
  const { readUIMessageStream } = await import('ai')
  const stream = new ReadableStream({
    start(controller) {
      // Chunk は UIMessageChunk の部分集合として SDK にそのまま渡す（型の厳密さは不要）
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  try {
    for await (const snapshot of readUIMessageStream({
      stream,
      terminateOnError: true,
      ...(message === undefined ? {} : { message: structuredClone(message) as never }),
    })) {
      void snapshot
    }
    return false
  } catch {
    return true
  }
}

describe('buildDiagnostics: http-status', () => {
  it('2xx は ok', () => {
    const d = find(diagnose(makeEntry({ mode: 'raw', responseHeaders: {} })), 'http-status')
    expect(d?.level).toBe('ok')
    expect(d?.title).toContain('200')
  })

  it('status が無ければ出さない', () => {
    const entry = makeEntry({ status: undefined, statusText: undefined, state: 'pending' })
    expect(ids(diagnose(entry))).toEqual([])
  })

  it.each([
    [401, '認証'],
    [403, 'Bearer'],
    [404, 'URL'],
    [405, 'メソッド'],
    [429, 'レート制限'],
    [500, 'サーバー'],
    [503, 'サーバー'],
  ])('%i は error で対処を示す', (status, keyword) => {
    const d = find(diagnose(makeEntry({ mode: 'raw', status, responseHeaders: {} })), 'http-status')
    expect(d?.level).toBe('error')
    expect(d?.title).toContain(String(status))
    expect(d?.detail).toContain(keyword)
  })

  it('statusText をタイトルに含める', () => {
    const d = find(
      diagnose(
        makeEntry({ mode: 'raw', status: 404, statusText: 'Not Found', responseHeaders: {} }),
      ),
      'http-status',
    )
    expect(d?.title).toContain('404 Not Found')
  })

  it.each([
    ['{"message":"Invalid API key"}', 'Invalid API key'],
    ['{"error":"quota exceeded"}', 'quota exceeded'],
    ['{"error":{"message":"model not found","type":"x"}}', 'model not found'],
    ['{"detail":[{"msg":"field required"}]}', 'field required'],
    ['{"errorText":"boom"}', 'boom'],
    ['upstream timeout', 'upstream timeout'],
  ])('本文 %s のエラーメッセージを detail に含める', (rawBody, expected) => {
    const d = find(
      diagnose(makeEntry({ mode: 'raw', status: 400, rawBody, responseHeaders: {} })),
      'http-status',
    )
    expect(d?.detail).toContain(expected)
  })

  it('HTML の本文は detail に出さない', () => {
    const d = find(
      diagnose(
        makeEntry({
          mode: 'raw',
          status: 500,
          rawBody: '<html><body>Internal Server Error</body></html>',
          responseHeaders: { 'content-type': 'text/html' },
        }),
      ),
      'http-status',
    )
    expect(d?.detail).not.toContain('<html>')
    expect(d?.detail).not.toContain('Internal Server Error')
  })

  it('2xx のときは本文からメッセージを取り出さない', () => {
    const d = find(
      diagnose(makeEntry({ mode: 'raw', rawBody: '{"error":"x"}', responseHeaders: {} })),
      'http-status',
    )
    expect(d?.detail).toBeUndefined()
  })

  it('3xx は info', () => {
    const d = find(
      diagnose(makeEntry({ mode: 'raw', status: 304, responseHeaders: {} })),
      'http-status',
    )
    expect(d?.level).toBe('info')
  })

  it('プロキシ自身のエラー（x-proxy-error）にはサーバー向けの対処を出さない', () => {
    const d = find(
      diagnose(
        makeEntry({
          mode: 'raw',
          viaProxy: true,
          status: 502,
          responseHeaders: { 'x-proxy-error': '1', 'content-type': 'application/json' },
          rawBody: '{"error":"proxy_error","message":"fetch failed"}',
        }),
      ),
      'http-status',
    )
    expect(d?.level).toBe('error')
    expect(d?.detail).toContain('プロキシ')
    expect(d?.detail).not.toContain('サーバー側でエラー')
  })

  it('レスポンスヘッダーのキーは大文字小文字を区別しない', () => {
    const d = diagnose(
      makeEntry({ responseHeaders: { 'Content-Type': 'Text/Event-Stream; charset=utf-8' } }),
    )
    expect(find(d, 'content-type')).toBeUndefined()
  })
})

describe('buildDiagnostics: network-error / aborted', () => {
  const failed = (over: Partial<NetworkLogEntry> = {}) =>
    makeEntry({
      state: 'error',
      status: undefined,
      statusText: undefined,
      responseHeaders: undefined,
      ttfbMs: undefined,
      error: { name: 'TypeError', message: 'Failed to fetch' },
      ...over,
    })

  it('クロスオリジンかつプロキシ無しなら CORS の可能性を示し、対処を案内する', () => {
    const d = find(
      diagnose(failed({ targetUrl: 'http://localhost:28787/api/chat' }), 'http://localhost:5173'),
      'network-error',
    )
    expect(d?.level).toBe('error')
    expect(d?.title).toContain('CORS')
    // 設定画面のトグルと同じ名前で案内する（名前が食い違うと、利用者が復旧手順に辿り着けない）
    expect(d?.detail).toContain(`「${PROXY_TOGGLE_LABEL}」`)
    expect(d?.detail).toContain('Access-Control-Allow-Origin')
    expect(d?.detail).toContain('Failed to fetch')
  })

  it('同一オリジンなら CORS とは言わない', () => {
    const d = find(
      diagnose(failed({ targetUrl: 'http://localhost:5173/api/chat' }), 'http://localhost:5173'),
      'network-error',
    )
    expect(d?.title).not.toContain('CORS')
    expect(d?.detail).not.toContain('CORS')
  })

  it('pageOrigin が不明なら CORS の憶測をしない', () => {
    const d = find(
      diagnose(failed({ targetUrl: 'http://localhost:28787/api/chat' })),
      'network-error',
    )
    expect(d?.title).not.toContain('CORS')
  })

  it('pageOrigin が URL として不正でも落ちず、CORS の憶測をしない', () => {
    const d = find(diagnose(failed(), 'not a url'), 'network-error')
    expect(d?.title).not.toContain('CORS')
  })

  it('ターゲットが相対・不正な URL でも落ちない', () => {
    const d = find(
      diagnose(failed({ targetUrl: '/api/chat' }), 'http://localhost:5173'),
      'network-error',
    )
    expect(d).toBeDefined()
  })

  it('プロキシ経由ならプロキシ→ターゲット間の接続失敗として案内する（CORS とは言わない）', () => {
    const d = find(
      diagnose(
        failed({ viaProxy: true, targetUrl: 'http://localhost:28787/api/chat' }),
        'http://localhost:5173',
      ),
      'network-error',
    )
    expect(d?.title).toContain('プロキシ')
    expect(d?.detail).toContain('http://localhost:28787/api/chat')
    expect(d?.detail).not.toContain('CORS')
  })

  it('中断（state aborted）は error ではなく info の aborted', () => {
    const entry = failed({ state: 'aborted', error: undefined })
    const list = diagnose(entry, 'http://localhost:5173')
    expect(find(list, 'aborted')?.level).toBe('info')
    expect(find(list, 'network-error')).toBeUndefined()
  })

  it('AbortError も aborted として扱う', () => {
    const list = diagnose(failed({ error: { name: 'AbortError', message: 'aborted' } }))
    expect(find(list, 'aborted')?.level).toBe('info')
    expect(find(list, 'network-error')).toBeUndefined()
  })

  it('途中で中断されても、受信済みの http-status は残る', () => {
    const list = diagnose(uiEntry(HELLO.slice(0, 4), { state: 'aborted' }, { done: false }))
    expect(find(list, 'http-status')?.level).toBe('ok')
    expect(find(list, 'aborted')?.level).toBe('info')
    expect(find(list, 'summary')).toBeUndefined()
    // 途中で止めただけなので finish が無いことは指摘しない
    expect(find(list, 'ui-stream-no-finish')).toBeUndefined()
  })

  it('RequestShapeError は送信前の設定ミスとして案内する', () => {
    const d = find(
      diagnose(
        failed({
          error: { name: 'RequestShapeError', message: '追加ボディが不正な JSON です' },
        }),
        'http://localhost:5173',
      ),
      'network-error',
    )
    expect(d?.title).toContain('送信できません')
    expect(d?.detail).toContain('追加ボディが不正な JSON です')
    expect(d?.detail).not.toContain('CORS')
  })

  it('state が error で error 情報が無くても network-error を出す', () => {
    const list = diagnose(failed({ error: undefined }))
    expect(find(list, 'network-error')).toBeDefined()
  })

  it('エラーが無い通常の完了では出さない', () => {
    expect(find(diagnose(uiEntry(HELLO)), 'network-error')).toBeUndefined()
  })

  it('レスポンス受信後の切断（chat-text など）は network-error として途中切断を案内する', () => {
    const entry = makeEntry({
      mode: 'chat-text',
      state: 'error',
      responseHeaders: { 'content-type': 'text/plain' },
      error: { name: 'TypeError', message: 'terminated' },
      events: [{ index: 0, atMs: 5, kind: 'text-chunk', raw: 'Hel' }],
    })
    const list = diagnose(entry)
    expect(find(list, 'network-error')?.title).toContain('受信中に接続が切断')
    expect(find(list, 'network-error')?.detail).toContain('terminated')
    expect(find(list, 'summary')).toBeUndefined()
  })
})

describe('buildDiagnostics: proxy-unavailable / proxy-error', () => {
  const viaProxy = (over: Partial<NetworkLogEntry> = {}) =>
    makeEntry({ mode: 'raw', viaProxy: true, responseHeaders: {}, ...over })

  it('プロキシ経由の 404（x-proxy-error 無し）は動いていない可能性として warn', () => {
    const d = find(
      diagnose(viaProxy({ status: 404, statusText: 'Not Found' })),
      'proxy-unavailable',
    )
    expect(d?.level).toBe('warn')
    expect(d?.detail).toContain('/__proxy')
  })

  it('プロキシ経由で text/html が返れば proxy-unavailable', () => {
    const d = find(
      diagnose(viaProxy({ responseHeaders: { 'content-type': 'text/html; charset=utf-8' } })),
      'proxy-unavailable',
    )
    expect(d?.level).toBe('warn')
  })

  it('アプリ自身の index.html が返っていれば動作していないと断定して error', () => {
    const d = find(
      diagnose(
        viaProxy({
          responseHeaders: { 'content-type': 'text/html' },
          rawBody: '<!doctype html><html><body><div id="root"></div></body></html>',
        }),
      ),
      'proxy-unavailable',
    )
    expect(d?.level).toBe('error')
    expect(d?.title).toContain('動作していません')
  })

  it('x-proxy-error があれば 404 でも proxy-unavailable ではない', () => {
    const list = diagnose(
      viaProxy({
        status: 404,
        responseHeaders: { 'x-proxy-error': '1', 'content-type': 'application/json' },
        rawBody: '{"error":"x","message":"y"}',
      }),
    )
    expect(find(list, 'proxy-unavailable')).toBeUndefined()
    expect(find(list, 'proxy-error')).toBeDefined()
  })

  it('プロキシを使っていなければ出さない', () => {
    expect(find(diagnose(viaProxy({ viaProxy: false, status: 404 })), 'proxy-unavailable')).toBe(
      undefined,
    )
    expect(
      find(
        diagnose(viaProxy({ viaProxy: false, responseHeaders: { 'content-type': 'text/html' } })),
        'proxy-unavailable',
      ),
    ).toBeUndefined()
  })

  it('プロキシ経由の 200 JSON や 500 は proxy-unavailable ではない', () => {
    expect(
      find(
        diagnose(viaProxy({ responseHeaders: { 'content-type': 'application/json' } })),
        'proxy-unavailable',
      ),
    ).toBeUndefined()
    expect(find(diagnose(viaProxy({ status: 500 })), 'proxy-unavailable')).toBeUndefined()
  })

  it('x-proxy-error（502）は proxy-error で、本文の message を detail に含める', () => {
    const d = find(
      diagnose(
        viaProxy({
          status: 502,
          statusText: 'Bad Gateway',
          responseHeaders: { 'x-proxy-error': '1', 'content-type': 'application/json' },
          rawBody:
            '{"error":"proxy_error","message":"fetch failed: connect ECONNREFUSED 127.0.0.1:28787"}',
        }),
      ),
      'proxy-error',
    )
    expect(d?.level).toBe('error')
    expect(d?.title).toContain('502')
    expect(d?.detail).toContain('ECONNREFUSED')
    expect(d?.detail).toContain('ポート')
  })

  it.each([
    ['forbidden', 403, '同じオリジン'],
    ['missing_target', 400, '絶対 URL'],
    ['invalid_target', 400, '絶対 URL'],
    ['redirect_error', 502, 'リダイレクト先の URL を直接'],
    ['method_not_allowed', 405, 'fetch が扱えない'],
  ])('proxy-error %s のコード別の対処', (code, status, keyword) => {
    const d = find(
      diagnose(
        viaProxy({
          status,
          responseHeaders: { 'x-proxy-error': '1' },
          rawBody: JSON.stringify({ error: code, message: 'm' }),
        }),
      ),
      'proxy-error',
    )
    expect(d?.detail).toContain('m')
    expect(d?.detail).toContain(keyword)
  })

  it('redirect_error は、転送先への接続失敗（proxy_error）の案内とは別に、リダイレクトを再送できなかった旨を示す', () => {
    const d = find(
      diagnose(
        viaProxy({
          status: 502,
          statusText: 'Bad Gateway',
          responseHeaders: { 'x-proxy-error': '1', 'content-type': 'application/json' },
          rawBody: JSON.stringify({
            error: 'redirect_error',
            message: '転送先が 307 で https://api.example.com/v2/chat へのリダイレクトを返しました',
          }),
        }),
      ),
      'proxy-error',
    )
    expect(d?.level).toBe('error')
    expect(d?.title).toContain(PROXY_NAME)
    // プロキシが出したメッセージ（Location など）をそのまま見せる
    expect(d?.detail).toContain('https://api.example.com/v2/chat')
    expect(d?.detail).toContain('再送できませんでした')
    // 接続失敗の案内（転送先の起動状態・ポート）は当てはまらないので出さない
    expect(d?.detail).not.toContain('ポート')
    expect(d?.detail).not.toContain('接続できませんでした')
  })

  it('未知のエラーコードでも、メッセージだけを示して落ちない', () => {
    const d = find(
      diagnose(
        viaProxy({
          status: 502,
          responseHeaders: { 'x-proxy-error': '1' },
          rawBody: '{"error":"something_new","message":"new failure"}',
        }),
      ),
      'proxy-error',
    )
    expect(d?.detail).toBe('new failure')
  })

  it('x-proxy-error の本文が JSON でなくても落ちない', () => {
    const d = find(
      diagnose(
        viaProxy({
          status: 502,
          responseHeaders: { 'x-proxy-error': '1' },
          rawBody: 'bad gateway',
        }),
      ),
      'proxy-error',
    )
    expect(d?.detail).toContain('bad gateway')
  })
})

describe('buildDiagnostics: content-type', () => {
  it('chat-ui で text/event-stream 以外なら warn', () => {
    const d = find(
      diagnose(makeEntry({ responseHeaders: { 'content-type': 'application/json' } })),
      'content-type',
    )
    expect(d?.level).toBe('warn')
    expect(d?.detail).toContain('application/json')
  })

  it('chat-ui で text/plain なら Text Stream モードを案内する', () => {
    const d = find(
      diagnose(makeEntry({ responseHeaders: { 'content-type': 'text/plain; charset=utf-8' } })),
      'content-type',
    )
    expect(d?.detail).toContain('Chat (Text Stream)')
  })

  it('chat-ui で Content-Type が無ければ warn', () => {
    const d = find(diagnose(makeEntry({ responseHeaders: {} })), 'content-type')
    expect(d?.level).toBe('warn')
    expect(d?.detail).toContain('指定なし')
  })

  it('chat-ui で text/event-stream（charset 付き・大文字小文字違い）なら出さない', () => {
    for (const value of [
      'text/event-stream',
      'text/event-stream; charset=utf-8',
      'Text/Event-Stream',
    ]) {
      const d = diagnose(makeEntry({ responseHeaders: { 'content-type': value } }))
      expect(find(d, 'content-type')).toBeUndefined()
    }
  })

  it('chat-text で text/event-stream が返ったら UI Message Stream モードを案内する', () => {
    const d = find(
      diagnose(
        makeEntry({ mode: 'chat-text', responseHeaders: { 'content-type': 'text/event-stream' } }),
      ),
      'content-type',
    )
    expect(d?.level).toBe('warn')
    expect(d?.detail).toContain('Chat (UI Message Stream)')
  })

  it('chat-text で text/plain なら出さない', () => {
    const d = diagnose(
      makeEntry({ mode: 'chat-text', responseHeaders: { 'content-type': 'text/plain' } }),
    )
    expect(find(d, 'content-type')).toBeUndefined()
  })

  it.each<Mode>(['completion', 'raw'])('%s は content-type を判定しない', (mode) => {
    for (const value of ['application/json', 'text/plain', 'text/event-stream']) {
      const d = diagnose(makeEntry({ mode, responseHeaders: { 'content-type': value } }))
      expect(find(d, 'content-type')).toBeUndefined()
    }
  })

  it('2xx 以外では判定しない', () => {
    const d = diagnose(
      makeEntry({ status: 500, responseHeaders: { 'content-type': 'application/json' } }),
    )
    expect(find(d, 'content-type')).toBeUndefined()
  })
})

describe('buildDiagnostics: ui-stream-header', () => {
  it('x-vercel-ai-ui-message-stream: v1 があれば ok', () => {
    expect(find(diagnose(uiEntry(HELLO)), 'ui-stream-header')?.level).toBe('ok')
  })

  it('無ければ warn（SDK は必須としない点も添える）', () => {
    const d = find(
      diagnose(uiEntry(HELLO, { responseHeaders: { 'content-type': 'text/event-stream' } })),
      'ui-stream-header',
    )
    expect(d?.level).toBe('warn')
    expect(d?.detail).toContain('必須としておらず')
  })

  it('クロスオリジンかつプロキシ無しなら CORS の Expose-Headers の可能性として info', () => {
    const d = find(
      diagnose(
        uiEntry(HELLO, {
          targetUrl: 'http://localhost:28787/api/chat',
          responseHeaders: { 'content-type': 'text/event-stream' },
        }),
        'http://localhost:5173',
      ),
      'ui-stream-header',
    )
    expect(d?.level).toBe('info')
    expect(d?.detail).toContain('Access-Control-Expose-Headers')
    expect(d?.detail).toContain('必須としておらず')
  })

  it('クロスオリジンでもプロキシ経由なら warn（ヘッダーは隠れない）', () => {
    const d = find(
      diagnose(
        uiEntry(HELLO, {
          viaProxy: true,
          targetUrl: 'http://localhost:28787/api/chat',
          responseHeaders: { 'content-type': 'text/event-stream' },
        }),
        'http://localhost:5173',
      ),
      'ui-stream-header',
    )
    expect(d?.level).toBe('warn')
  })

  it('値が v1 以外なら warn', () => {
    const d = find(
      diagnose(
        uiEntry(HELLO, {
          responseHeaders: {
            'content-type': 'text/event-stream',
            'x-vercel-ai-ui-message-stream': 'v2',
          },
        }),
      ),
      'ui-stream-header',
    )
    expect(d?.level).toBe('warn')
    expect(d?.title).toContain('v2')
  })

  it('completion は SSE で返ってきたときだけ判定する', () => {
    const sse = makeEntry({
      mode: 'completion',
      events: jsonEvents([{ type: 'text-delta', id: 'a', delta: 'x' }]),
    })
    expect(find(diagnose(sse), 'ui-stream-header')?.level).toBe('ok')
    const text = makeEntry({
      mode: 'completion',
      responseHeaders: { 'content-type': 'text/plain' },
    })
    expect(find(diagnose(text), 'ui-stream-header')).toBeUndefined()
  })

  it.each<Mode>(['chat-text', 'raw'])('%s では判定しない', (mode) => {
    expect(find(diagnose(makeEntry({ mode })), 'ui-stream-header')).toBeUndefined()
  })

  it('2xx 以外では判定しない', () => {
    expect(
      find(diagnose(makeEntry({ status: 500, responseHeaders: {} })), 'ui-stream-header'),
    ).toBeUndefined()
  })
})

describe('buildDiagnostics: 正常な UI Message Stream', () => {
  it('text の一連のイベント列は ok のみ（http-status / ui-stream-header / summary）', () => {
    const list = diagnose(uiEntry(HELLO))
    expect(list.every((d) => d.level === 'ok')).toBe(true)
    expect(ids(list).sort()).toEqual(['http-status', 'summary', 'ui-stream-header'])
  })

  it('summary にチャンク数・ttfb・total を日本語で入れる', () => {
    const d = find(diagnose(uiEntry(HELLO)), 'summary')
    expect(d?.level).toBe('ok')
    expect(d?.detail).toContain('チャンク数 9')
    expect(d?.detail).toContain('TTFB 120 ms')
    expect(d?.detail).toContain('合計 1.50 s')
  })

  it('ttfb / total が未確定なら — を出す', () => {
    const d = find(diagnose(uiEntry(HELLO, { ttfbMs: undefined, totalMs: undefined })), 'summary')
    expect(d?.detail).toContain('TTFB —')
    expect(d?.detail).toContain('合計 —')
  })

  it('イベント数が上限で打ち切られていれば + を付ける', () => {
    const d = find(diagnose(uiEntry(HELLO, { eventsTruncated: true })), 'summary')
    expect(d?.detail).toContain('チャンク数 9+')
  })

  it('reasoning / tool / data-* / source を含む実際の流れでも ok', () => {
    const chunks: Chunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: '考え中' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'weather' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"city":' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '"Tokyo"}' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'weather',
        input: { city: 'Tokyo' },
      },
      { type: 'tool-output-available', toolCallId: 'c1', output: { temp: 20 } },
      { type: 'data-weather', id: 'd1', data: { temp: 20 } },
      { type: 'source-url', sourceId: 's1', url: 'https://example.com' },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '20度です' },
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ]
    const list = diagnose(uiEntry(chunks))
    expect(list.every((d) => d.level === 'ok')).toBe(true)
  })

  it('コメント（": ping"）が混ざっていても ok', () => {
    const entry = uiEntry(HELLO)
    const comment: StreamEvent = { index: 99, atMs: 1, kind: 'sse-comment', raw: 'ping' }
    const list = diagnose({ ...entry, events: [comment, ...entry.events] })
    expect(list.every((d) => d.level === 'ok')).toBe(true)
  })
})

describe('buildDiagnostics: 診断の並び順', () => {
  it('error → warn → info → ok の順に並ぶ', () => {
    const chunks: Chunk[] = [
      { type: 'start' },
      { type: 'text-delta', id: 'x', delta: 'a' }, // error（順序）
      { type: 'mystery' }, // warn（未知 type）
    ]
    const entry = uiEntry(chunks, {}, { done: false }) // info（[DONE] なし）+ warn（finish なし）
    const levels = diagnose(entry).map((d) => d.level)
    const rank = { error: 0, warn: 1, info: 2, ok: 3 } as const
    expect(levels).toEqual([...levels].sort((a, b) => rank[a] - rank[b]))
    expect(levels[0]).toBe('error')
    expect(levels.at(-1)).toBe('ok')
    expect(new Set(levels)).toEqual(new Set(['error', 'warn', 'info', 'ok']))
  })
})

describe('buildDiagnostics: sse-invalid-json', () => {
  const bad = (index: number, raw: string, parseError?: string): StreamEvent => ({
    index,
    atMs: index,
    kind: 'sse-text',
    raw,
    ...(parseError === undefined ? {} : { parseError }),
  })

  it('JSON でない data を error にし、該当イベント番号を示す', () => {
    const events = [
      ...jsonEvents(HELLO.slice(0, 2)),
      bad(2, 'not json', 'Unexpected token o'),
      bad(3, '{"type":'),
    ]
    const d = find(diagnose(makeEntry({ events })), 'sse-invalid-json')
    expect(d?.level).toBe('error')
    expect(d?.title).toContain('2 件')
    expect(d?.detail).toContain('#2')
    expect(d?.detail).toContain('#3')
    expect(d?.detail).toContain('Unexpected token o')
    expect(d?.detail).toContain('not json')
  })

  it('[DONE] は除く', () => {
    expect(find(diagnose(uiEntry(HELLO)), 'sse-invalid-json')).toBeUndefined()
    const events = [...jsonEvents(HELLO), bad(8, '[DONE]')]
    expect(find(diagnose(makeEntry({ events })), 'sse-invalid-json')).toBeUndefined()
  })

  it('件数が多いときは先頭だけ列挙して残りは件数で示す', () => {
    const events = Array.from({ length: 8 }, (_, i) => bad(i, `x${i}`, 'e'))
    const d = find(diagnose(makeEntry({ events })), 'sse-invalid-json')
    expect(d?.title).toContain('8 件')
    expect(d?.detail).toContain('#4')
    expect(d?.detail).not.toContain('#5')
    expect(d?.detail).toContain('ほか 3 件')
  })

  it('長い raw は切り詰める', () => {
    const d = find(
      diagnose(makeEntry({ events: [bad(0, 'x'.repeat(500), 'e')] })),
      'sse-invalid-json',
    )
    expect(d?.detail?.length).toBeLessThan(500)
  })

  it('completion（SSE）でも判定し、chat-text / raw では判定しない', () => {
    const events = [bad(0, 'oops', 'e')]
    expect(
      find(diagnose(makeEntry({ mode: 'completion', events })), 'sse-invalid-json'),
    ).toBeDefined()
    for (const mode of ['chat-text', 'raw'] as const) {
      expect(find(diagnose(makeEntry({ mode, events })), 'sse-invalid-json')).toBeUndefined()
    }
  })
})

describe('buildDiagnostics: ui-chunk-unknown-type', () => {
  /**
   * ai パッケージの uiMessageChunkSchema が受け付ける type（data-* を除く）。
   * JSON Schema への変換は data-* の custom 型で失敗するので、存在しない type を検証にかけ、
   * union の各ブランチが「type がこの literal ではない」と報告する値を集める。
   */
  async function sdkChunkTypes(): Promise<string[]> {
    const { asSchema, uiMessageChunkSchema } = await import('ai')
    const result = await asSchema(uiMessageChunkSchema).validate?.({ type: '__not-a-chunk-type__' })
    if (result === undefined || result.success) throw new Error('検証が失敗するはずの入力が通った')
    const types = new Set<string>()
    const issues: unknown = (result.error as { issues?: unknown }).issues
    for (const issue of Array.isArray(issues) ? (issues as unknown[]) : []) {
      const branches = (issue as { errors?: unknown }).errors
      if (!Array.isArray(branches)) continue
      for (const branch of branches as unknown[]) {
        for (const item of Array.isArray(branch) ? (branch as unknown[]) : []) {
          const { code, path, values } = item as {
            code?: unknown
            path?: unknown
            values?: unknown
          }
          const atType = Array.isArray(path) && path.length === 1 && path[0] === 'type'
          if (code !== 'invalid_value' || !atType || !Array.isArray(values)) continue
          for (const value of values as unknown[]) if (typeof value === 'string') types.add(value)
        }
      }
    }
    return [...types]
  }

  it('既知 type の一覧は、ai パッケージの uiMessageChunkSchema が受け付ける type と一致する', async () => {
    const sdkTypes = await sdkChunkTypes()
    // 抽出の仕方が壊れて空どうしで一致した、という見落としを防ぐ
    expect(sdkTypes.length).toBeGreaterThan(20)
    // SDK に type が増えれば「SDK にあるのに一覧に無い」、減れば逆で、どちらもここで落ちる
    expect([...KNOWN_UI_CHUNK_TYPES].sort()).toEqual(sdkTypes.sort())
  })

  it('未知の type を warn にし、SDK では致命的になる点を detail に書く', () => {
    const d = find(
      diagnose(uiEntry([...HELLO, { type: 'mystery' }, { type: 'text-chunk' }])),
      'ui-chunk-unknown-type',
    )
    expect(d?.level).toBe('warn')
    expect(d?.title).toContain('mystery')
    expect(d?.title).toContain('text-chunk')
    expect(d?.detail).toContain('エラー終了')
    expect(d?.detail).toContain('#8')
  })

  it('data-* は既知として扱う', () => {
    const d = diagnose(uiEntry([...HELLO, { type: 'data-weather', data: {} }, { type: 'data-' }]))
    expect(find(d, 'ui-chunk-unknown-type')).toBeUndefined()
  })

  it('type の無い JSON（オブジェクトでない・type が文字列でない）も指摘する', () => {
    const events: StreamEvent[] = [
      { index: 0, atMs: 0, kind: 'sse-json', data: 'hello', raw: '"hello"' },
      { index: 1, atMs: 1, kind: 'sse-json', data: { type: 1 }, raw: '{"type":1}' },
      { index: 2, atMs: 2, kind: 'sse-json', data: [1], raw: '[1]' },
    ]
    const d = find(diagnose(makeEntry({ events })), 'ui-chunk-unknown-type')
    expect(d?.title).toContain('type なし')
  })

  it('StreamEvent.type が無くても data.type から判定する', () => {
    const events: StreamEvent[] = [
      { index: 0, atMs: 0, kind: 'sse-json', data: { type: 'mystery' }, raw: '{}' },
    ]
    expect(find(diagnose(makeEntry({ events })), 'ui-chunk-unknown-type')?.title).toContain(
      'mystery',
    )
  })

  it('completion（SSE）でも判定する', () => {
    const entry = makeEntry({ mode: 'completion', events: jsonEvents([{ type: 'mystery' }]) })
    expect(find(diagnose(entry), 'ui-chunk-unknown-type')).toBeDefined()
  })

  it('chat-text / raw では判定しない', () => {
    for (const mode of ['chat-text', 'raw'] as const) {
      const entry = makeEntry({ mode, events: jsonEvents([{ type: 'mystery' }]) })
      expect(find(diagnose(entry), 'ui-chunk-unknown-type')).toBeUndefined()
    }
  })
})

describe('buildDiagnostics: ui-chunk-order', () => {
  const order = (chunks: Chunk[]) => find(diagnose(uiEntry(chunks)), 'ui-chunk-order')

  it('正しい順序なら出さない', () => {
    expect(order(HELLO)).toBeUndefined()
  })

  it('text-delta が text-start より前なら error', () => {
    const d = order([
      { type: 'start' },
      { type: 'text-delta', id: 't1', delta: 'x' },
      { type: 'text-start', id: 't1' },
      { type: 'text-end', id: 't1' },
    ])
    expect(d?.level).toBe('error')
    expect(d?.detail).toContain('#1')
    expect(d?.detail).toContain('text-delta')
    expect(d?.detail).toContain('text-start')
  })

  it('start の無い text-end は error', () => {
    expect(order([{ type: 'text-end', id: 'zz' }])?.level).toBe('error')
  })

  it('別の id の start では満たされない', () => {
    const d = order([
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'b', delta: 'x' },
    ])
    expect(d?.level).toBe('error')
    expect(d?.detail).toContain('b')
  })

  it('end のあとの delta は error（SDK は end でパートを閉じる）', () => {
    const d = order([
      { type: 'text-start', id: 'a' },
      { type: 'text-end', id: 'a' },
      { type: 'text-delta', id: 'a', delta: 'late' },
    ])
    expect(d?.level).toBe('error')
  })

  it('end の二重送信は error', () => {
    const d = order([
      { type: 'text-start', id: 'a' },
      { type: 'text-end', id: 'a' },
      { type: 'text-end', id: 'a' },
    ])
    expect(d?.level).toBe('error')
  })

  it('同じ id を再利用して start し直せば OK', () => {
    expect(
      order([
        { type: 'text-start', id: 'a' },
        { type: 'text-end', id: 'a' },
        { type: 'text-start', id: 'a' },
        { type: 'text-delta', id: 'a', delta: 'x' },
        { type: 'text-end', id: 'a' },
      ]),
    ).toBeUndefined()
  })

  it('end の無いまま終わる text は順序違反ではない', () => {
    expect(
      order([
        { type: 'text-start', id: 'a' },
        { type: 'text-delta', id: 'a', delta: 'x' },
      ]),
    ).toBeUndefined()
  })

  it('reasoning も同じ規則', () => {
    const d = order([
      { type: 'reasoning-delta', id: 'r', delta: 'x' },
      { type: 'reasoning-end', id: 'r' },
    ])
    expect(d?.level).toBe('error')
    expect(d?.detail).toContain('reasoning-start')
    expect(
      order([
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: 'x' },
        { type: 'reasoning-end', id: 'r' },
      ]),
    ).toBeUndefined()
  })

  it('text と reasoning は別の名前空間（同じ id でも相互に満たさない）', () => {
    const d = order([
      { type: 'text-start', id: 'a' },
      { type: 'reasoning-delta', id: 'a', delta: 'x' },
    ])
    expect(d?.level).toBe('error')
  })

  it('tool-input-delta が tool-input-start より前なら error', () => {
    const d = order([
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'w' },
    ])
    expect(d?.level).toBe('error')
    expect(d?.detail).toContain('tool-input-start')
  })

  it('tool-input-available / tool-input-error は start が無くても OK（SDK がパートを作る）', () => {
    expect(
      order([
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'w', input: {} },
        { type: 'tool-output-available', toolCallId: 'c1', output: 1 },
        { type: 'tool-input-error', toolCallId: 'c2', toolName: 'w', input: {}, errorText: 'e' },
        { type: 'tool-output-error', toolCallId: 'c2', errorText: 'e' },
      ]),
    ).toBeUndefined()
  })

  it('tool-input-available のあとの tool-input-delta は error（start が無い）', () => {
    const d = order([
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'w', input: {} },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{' },
    ])
    expect(d?.level).toBe('error')
  })

  it('未知の toolCallId への出力・承認要求・拒否は断定できないので warn', () => {
    for (const chunk of [
      { type: 'tool-output-available', toolCallId: 'old', output: 1 },
      { type: 'tool-output-error', toolCallId: 'old', errorText: 'e' },
      { type: 'tool-output-denied', toolCallId: 'old' },
      { type: 'tool-approval-request', toolCallId: 'old', approvalId: 'a1' },
    ] as Chunk[]) {
      const d = order([chunk])
      expect(d?.level).toBe('warn')
      expect(d?.detail).toContain('old')
      expect(d?.detail).toContain('前回の応答から続く')
    }
  })

  it('既知の承認 ID への tool-approval-response は OK、未知なら warn', () => {
    const tool: Chunk = { type: 'tool-input-available', toolCallId: 'c1', toolName: 'w', input: {} }
    expect(
      order([
        tool,
        { type: 'tool-approval-request', toolCallId: 'c1', approvalId: 'a1' },
        { type: 'tool-approval-response', approvalId: 'a1', approved: true },
        { type: 'tool-output-available', toolCallId: 'c1', output: 1 },
      ]),
    ).toBeUndefined()
    const d = order([tool, { type: 'tool-approval-response', approvalId: 'a9', approved: true }])
    expect(d?.level).toBe('warn')
    expect(d?.detail).toContain('a9')
  })

  it('確実な違反と断定できない参照が混在すれば error', () => {
    const d = order([
      { type: 'tool-output-available', toolCallId: 'old', output: 1 },
      { type: 'text-delta', id: 'x', delta: 'a' },
    ])
    expect(d?.level).toBe('error')
    expect(d?.title).toContain('2 件')
  })

  it('reset-step は進行中の text を無かったことにする', () => {
    const d = order([
      { type: 'start-step' },
      { type: 'text-start', id: 'a' },
      { type: 'reset-step' },
      { type: 'text-delta', id: 'a', delta: 'x' },
    ])
    expect(d?.level).toBe('error')
  })

  it('reset-step は現在のステップのツール呼び出しも破棄する', () => {
    const d = order([
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'w', input: {} },
      { type: 'reset-step' },
      { type: 'tool-output-available', toolCallId: 'c1', output: 1 },
    ])
    expect(d?.level).toBe('warn')
  })

  it('前のステップのツール呼び出しは、次のステップの出力から参照できる', () => {
    expect(
      order([
        { type: 'start-step' },
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'w', input: {} },
        { type: 'finish-step' },
        { type: 'start-step' },
        { type: 'tool-output-available', toolCallId: 'c1', output: 1 },
        { type: 'finish-step' },
      ]),
    ).toBeUndefined()
  })

  it('件数が多いときは先頭だけ列挙する', () => {
    const chunks: Chunk[] = Array.from({ length: 8 }, (_, i) => ({
      type: 'text-delta',
      id: `x${i}`,
      delta: 'a',
    }))
    const d = order(chunks)
    expect(d?.title).toContain('8 件')
    expect(d?.detail).toContain('ほか 3 件')
  })

  it('completion では順序を検証しない（SDK は text-delta と error しか見ない）', () => {
    const entry = makeEntry({
      mode: 'completion',
      events: jsonEvents([{ type: 'text-delta', id: 'x', delta: 'a' }]),
    })
    expect(find(diagnose(entry), 'ui-chunk-order')).toBeUndefined()
  })

  it('SSE でない chat-text / raw でも検証しない', () => {
    for (const mode of ['chat-text', 'raw'] as const) {
      const entry = makeEntry({ mode, events: jsonEvents([{ type: 'text-end', id: 'x' }]) })
      expect(find(diagnose(entry), 'ui-chunk-order')).toBeUndefined()
    }
  })
})

describe('buildDiagnostics: ui-stream-error-chunk', () => {
  it('error chunk を error にし、errorText を detail に含める', () => {
    const entry = uiEntry([
      { type: 'start' },
      { type: 'error', errorText: 'Rate limit exceeded' },
      { type: 'finish' },
    ])
    const list = diagnose(entry)
    const d = find(list, 'ui-stream-error-chunk')
    expect(d?.level).toBe('error')
    expect(d?.detail).toContain('Rate limit exceeded')
    expect(d?.detail).toContain('#1')
    // エラー診断があるので summary は出さない
    expect(find(list, 'summary')).toBeUndefined()
  })

  it('複数あれば件数を示す', () => {
    const d = find(
      diagnose(
        uiEntry([
          { type: 'error', errorText: 'a' },
          { type: 'error', errorText: 'b' },
          { type: 'finish' },
        ]),
      ),
      'ui-stream-error-chunk',
    )
    expect(d?.title).toContain('2 件')
  })

  it('completion（SSE）でも判定する', () => {
    const entry = makeEntry({
      mode: 'completion',
      events: jsonEvents([{ type: 'error', errorText: 'boom' }]),
    })
    expect(find(diagnose(entry), 'ui-stream-error-chunk')?.detail).toContain('boom')
  })

  it('error chunk が無ければ出さない', () => {
    expect(find(diagnose(uiEntry(HELLO)), 'ui-stream-error-chunk')).toBeUndefined()
  })
})

describe('buildDiagnostics: ストリームの終わり方', () => {
  it('finish が無ければ warn（ui-stream-no-finish）', () => {
    const list = diagnose(uiEntry(HELLO.slice(0, 6)))
    expect(find(list, 'ui-stream-no-finish')?.level).toBe('warn')
    // エラーではないので summary は出る
    expect(find(list, 'summary')?.level).toBe('ok')
  })

  it('finish の代わりに abort chunk で終わっていれば info', () => {
    const list = diagnose(uiEntry([...HELLO.slice(0, 6), { type: 'abort', reason: 'x' }]))
    expect(find(list, 'ui-stream-no-finish')?.level).toBe('info')
  })

  it('[DONE] が無ければ info（ui-stream-no-done）', () => {
    const list = diagnose(uiEntry(HELLO, {}, { done: false }))
    expect(find(list, 'ui-stream-no-done')?.level).toBe('info')
    expect(find(list, 'ui-stream-no-finish')).toBeUndefined()
    expect(find(list, 'summary')?.level).toBe('ok')
  })

  it('完了していなければ finish / [DONE] の有無は指摘しない（受信中）', () => {
    for (const state of ['pending', 'streaming'] as const) {
      const list = diagnose(uiEntry(HELLO.slice(0, 4), { state }, { done: false }))
      expect(ids(list)).not.toContain('ui-stream-no-finish')
      expect(ids(list)).not.toContain('ui-stream-no-done')
      expect(ids(list)).not.toContain('summary')
    }
  })

  it('受信中でも、受信済みの chunk の問題は指摘する', () => {
    const list = diagnose(
      uiEntry(
        [{ type: 'text-delta', id: 'x', delta: 'a' }],
        { state: 'streaming' },
        { done: false },
      ),
    )
    expect(find(list, 'ui-chunk-order')?.level).toBe('error')
  })

  it('切断（state error で finish 無し）は error（ui-stream-truncated）で、network-error は重ねない', () => {
    const entry = uiEntry(
      HELLO.slice(0, 4),
      { state: 'error', error: { name: 'TypeError', message: 'terminated' } },
      { done: false },
    )
    const list = diagnose(entry)
    const d = find(list, 'ui-stream-truncated')
    expect(d?.level).toBe('error')
    expect(d?.detail).toContain('terminated')
    expect(d?.detail).toContain('#3')
    expect(d?.detail).toContain('text-delta')
    expect(find(list, 'network-error')).toBeUndefined()
    expect(find(list, 'summary')).toBeUndefined()
    // 切断されたのだから finish が無いのは当然で、別途 warn を出さない
    expect(find(list, 'ui-stream-no-finish')).toBeUndefined()
  })

  it('1 件も受信できないまま切断された場合も説明する', () => {
    const entry = makeEntry({ state: 'error', error: { name: 'TypeError', message: 'terminated' } })
    expect(find(diagnose(entry), 'ui-stream-truncated')?.detail).toContain(
      '1 件も受信できていません',
    )
  })

  it('finish を受信したあとの切断は truncated にならず network-error になる', () => {
    const entry = uiEntry(
      HELLO,
      { state: 'error', error: { name: 'TypeError', message: 'terminated' } },
      { done: false },
    )
    const list = diagnose(entry)
    expect(find(list, 'ui-stream-truncated')).toBeUndefined()
    expect(find(list, 'network-error')).toBeDefined()
  })

  it('2xx で完了したのにイベントが 0 件なら warn（ui-stream-empty）', () => {
    const list = diagnose(makeEntry())
    expect(find(list, 'ui-stream-empty')?.level).toBe('warn')
    expect(find(list, 'ui-stream-no-finish')).toBeUndefined()
    expect(find(list, 'ui-stream-no-done')).toBeUndefined()
  })

  it('2xx 以外ではイベントが 0 件でも ui-stream-empty は出さない', () => {
    const list = diagnose(makeEntry({ status: 500, responseHeaders: {} }))
    expect(find(list, 'ui-stream-empty')).toBeUndefined()
  })

  it('本文が SSE でない chat-ui は finish / [DONE] の欠落を重ねて指摘しない', () => {
    const entry = makeEntry({
      responseHeaders: { 'content-type': 'application/json' },
      events: [{ index: 0, atMs: 1, kind: 'text-chunk', raw: '{"a":1}' }],
    })
    const list = diagnose(entry)
    expect(find(list, 'content-type')?.level).toBe('warn')
    expect(find(list, 'ui-stream-no-finish')).toBeUndefined()
    expect(find(list, 'ui-stream-no-done')).toBeUndefined()
    expect(find(list, 'ui-stream-empty')).toBeUndefined()
  })

  it('completion（SSE）にも finish / [DONE] / empty の判定を適用する', () => {
    const entry = makeEntry({
      mode: 'completion',
      events: jsonEvents([{ type: 'text-delta', id: 'a', delta: 'x' }]),
    })
    const list = diagnose(entry)
    expect(find(list, 'ui-stream-no-finish')?.level).toBe('warn')
    expect(find(list, 'ui-stream-no-done')?.level).toBe('info')
    expect(find(diagnose(makeEntry({ mode: 'completion' })), 'ui-stream-empty')?.level).toBe('warn')
  })
})

describe('buildDiagnostics: SSE 前提ではないモード', () => {
  const sseLike: StreamEvent[] = [
    { index: 0, atMs: 1, kind: 'text-chunk', raw: 'data: {"type":"x"}\n\n' },
  ]

  it('chat-text / raw / completion(text) は SSE 前提の診断を出さない', () => {
    const cases: Array<Partial<NetworkLogEntry>> = [
      { mode: 'chat-text', responseHeaders: { 'content-type': 'text/plain' } },
      { mode: 'raw', responseHeaders: {} },
      { mode: 'completion', responseHeaders: { 'content-type': 'text/plain' } },
    ]
    for (const over of cases) {
      const list = diagnose(makeEntry({ ...over, events: sseLike }))
      expect(ids(list).sort()).toEqual(['http-status', 'summary'])
    }
  })

  it('空のレスポンスでも ui-stream-* は出さない', () => {
    const list = diagnose(makeEntry({ mode: 'chat-text', responseHeaders: {} }))
    expect(ids(list).sort()).toEqual(['http-status', 'summary'])
  })

  it('エラーステータスなら summary は出さない', () => {
    const list = diagnose(makeEntry({ mode: 'raw', status: 500, responseHeaders: {} }))
    expect(find(list, 'summary')).toBeUndefined()
    expect(find(list, 'http-status')?.level).toBe('error')
  })
})

describe('buildDiagnostics: ui-chunk-schema-invalid（SDK のスキーマ検証に落ちる chunk）', () => {
  /** 指定した index のイベントに schemaError を付ける（network-log が非同期の検証のあとで付けるもの） */
  const withSchemaErrors = (
    entry: NetworkLogEntry,
    errors: Record<number, string>,
  ): NetworkLogEntry => ({
    ...entry,
    events: entry.events.map((event) =>
      errors[event.index] === undefined ? event : { ...event, schemaError: errors[event.index] },
    ),
  })

  const textWith = (delta: Chunk): Chunk[] => [
    { type: 'start' },
    { type: 'text-start', id: 't1' },
    delta,
    { type: 'text-end', id: 't1' },
    { type: 'finish' },
  ]

  it('schemaError のある chunk を error にし、どの chunk の何が合わないかを示す', () => {
    const entry = withSchemaErrors(
      uiEntry(textWith({ type: 'text-delta', id: 't1', textDelta: 'hi' })),
      { 2: '「delta」がありません（string が必要）' },
    )
    const list = diagnose(entry)
    const d = find(list, 'ui-chunk-schema-invalid')
    expect(d?.level).toBe('error')
    expect(d?.title).toContain('1 件')
    expect(d?.detail).toContain('#2: text-delta: 「delta」がありません')
    expect(d?.detail).toContain('AI_TypeValidationError')
    // エラー診断があるので、緑の完了表示は出さない
    expect(find(list, 'summary')).toBeUndefined()
    expect(list[0]?.level).toBe('error')
  })

  it('schemaError が無ければ出さない（summary は出る）', () => {
    const list = diagnose(uiEntry(HELLO))
    expect(find(list, 'ui-chunk-schema-invalid')).toBeUndefined()
    expect(find(list, 'summary')).toBeDefined()
  })

  it('受信中でも、検証が済んだ chunk の問題は指摘する', () => {
    const entry = withSchemaErrors(
      uiEntry(textWith({ type: 'text-delta', id: 't1', textDelta: 'hi' }).slice(0, 3), {
        state: 'streaming',
      }),
      { 2: 'x' },
    )
    expect(find(diagnose(entry), 'ui-chunk-schema-invalid')?.level).toBe('error')
  })

  it('未知の type は ui-chunk-unknown-type が説明するので、スキーマ違反として重ねない', () => {
    const entry = withSchemaErrors(uiEntry([...HELLO, { type: 'mystery' }]), {
      8: 'type「mystery」は UIMessageChunk にありません',
    })
    const list = diagnose(entry)
    expect(find(list, 'ui-chunk-unknown-type')).toBeDefined()
    expect(find(list, 'ui-chunk-schema-invalid')).toBeUndefined()
  })

  it('data-* の chunk も対象にする', () => {
    const entry = withSchemaErrors(uiEntry([...HELLO, { type: 'data-weather', id: 1 }]), {
      8: '「id」が number（1）です（string が必要）',
    })
    expect(find(diagnose(entry), 'ui-chunk-schema-invalid')?.detail).toContain('data-weather')
  })

  it('空行で終わらず SDK に届いていないイベントは対象にしない', () => {
    const entry = uiEntry(HELLO.slice(0, 7))
    const events: StreamEvent[] = [
      ...entry.events.slice(0, 7),
      {
        index: 7,
        atMs: 70,
        kind: 'sse-json',
        type: 'text-delta',
        data: { type: 'text-delta', id: 't1', textDelta: 'x' },
        raw: '{}',
        incomplete: true,
        schemaError: 'x',
      },
    ]
    expect(find(diagnose({ ...entry, events }), 'ui-chunk-schema-invalid')).toBeUndefined()
  })

  it('件数が多いときは先頭だけ列挙して残りは件数で示す', () => {
    const chunks: Chunk[] = [
      { type: 'start' },
      ...Array.from({ length: 7 }, () => ({ type: 'abort', reason: 1 })),
      { type: 'finish' },
    ]
    const errors = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i + 1, '「reason」']))
    const d = find(diagnose(withSchemaErrors(uiEntry(chunks), errors)), 'ui-chunk-schema-invalid')
    expect(d?.title).toContain('7 件')
    expect(d?.detail).toContain('ほか 2 件')
  })

  it('completion（SSE）でも判定し、chat-text / raw では判定しない', () => {
    const events = jsonEvents([{ type: 'text-delta', id: 't1', textDelta: 'x' }]).map((event) => ({
      ...event,
      schemaError: 'x',
    }))
    expect(
      find(diagnose(makeEntry({ mode: 'completion', events })), 'ui-chunk-schema-invalid'),
    ).toBeDefined()
    for (const mode of ['chat-text', 'raw'] as const) {
      expect(find(diagnose(makeEntry({ mode, events })), 'ui-chunk-schema-invalid')).toBeUndefined()
    }
  })
})

describe('buildDiagnostics: sse-unterminated-event（最後のイベントの後に空行が無い）', () => {
  /** HELLO の最後の finish だけ、空行で終わらなかった（end() が救済した）ことにする。 */
  function unterminatedFinish(over: Partial<NetworkLogEntry> = {}): NetworkLogEntry {
    const entry = uiEntry(HELLO, over, { done: false })
    const events = entry.events.map((event) =>
      event.type === 'finish' ? { ...event, incomplete: true } : event,
    )
    return { ...entry, events }
  }

  it('warn にし、SDK が受け取らないイベントと対処を示す', () => {
    const d = find(diagnose(unterminatedFinish()), 'sse-unterminated-event')
    expect(d?.level).toBe('warn')
    expect(d?.detail).toContain('#7: finish（SDK 未受信）')
    expect(d?.detail).toContain('空行')
    expect(d?.detail).toContain('onFinish')
  })

  it('救済した finish は finish の受信と数えない（ui-stream-no-finish を出す）', () => {
    const list = diagnose(unterminatedFinish())
    expect(find(list, 'ui-stream-no-finish')?.level).toBe('warn')
  })

  it('「ストリームは正常に完了しました」とは表示しない（warn と食い違うため）', () => {
    expect(find(diagnose(unterminatedFinish()), 'summary')).toBeUndefined()
  })

  it('finish 以外のイベントが未終端でも、完了の表示は出さない', () => {
    const entry = uiEntry(HELLO, {}, { done: false })
    const events: StreamEvent[] = [
      ...entry.events,
      { index: 8, atMs: 80, kind: 'sse-done', raw: '[DONE]', incomplete: true },
    ]
    const list = diagnose({ ...entry, events })
    expect(find(list, 'sse-unterminated-event')?.detail).toContain('#8')
    // finish は受信済みなので no-finish ではなく、救済した [DONE] は数えないので no-done
    expect(find(list, 'ui-stream-no-finish')).toBeUndefined()
    expect(find(list, 'ui-stream-no-done')).toBeDefined()
    expect(find(list, 'summary')).toBeUndefined()
  })

  it('SDK が受け取らないイベントは、順序・未知の type・不正 JSON の診断から除く', () => {
    const entry = uiEntry(HELLO, {}, { done: false })
    const rescued: StreamEvent[] = [
      {
        index: 8,
        atMs: 80,
        kind: 'sse-json',
        type: 'text-delta',
        data: { type: 'text-delta', id: 'never-started', delta: 'x' },
        raw: '{}',
        incomplete: true,
      },
      {
        index: 9,
        atMs: 90,
        kind: 'sse-json',
        type: 'mystery',
        data: { type: 'mystery' },
        raw: '{}',
        incomplete: true,
      },
      {
        index: 10,
        atMs: 100,
        kind: 'sse-text',
        raw: '{"type":"text-de',
        parseError: 'Unexpected end of JSON input',
        incomplete: true,
      },
    ]
    const list = diagnose({ ...entry, events: [...entry.events, ...rescued] })
    expect(find(list, 'ui-chunk-order')).toBeUndefined()
    expect(find(list, 'ui-chunk-unknown-type')).toBeUndefined()
    expect(find(list, 'sse-invalid-json')).toBeUndefined()
    expect(find(list, 'sse-unterminated-event')?.detail).toContain('#10')
  })

  it('空行で終わったイベントだけなら出さない', () => {
    const list = diagnose(uiEntry(HELLO))
    expect(find(list, 'sse-unterminated-event')).toBeUndefined()
    expect(find(list, 'summary')).toBeDefined()
  })

  it('completion（SSE）にも適用する', () => {
    const entry = unterminatedFinish({ mode: 'completion' })
    expect(find(diagnose(entry), 'sse-unterminated-event')).toBeDefined()
    expect(find(diagnose(entry), 'summary')).toBeUndefined()
  })
})

describe('buildDiagnostics: request-headers-dropped（ブラウザが送らないヘッダー）', () => {
  it('指定されたが送られなかったヘッダー名を warn で示す', () => {
    const d = find(
      diagnose(makeEntry({ mode: 'raw', responseHeaders: {}, droppedHeaders: ['origin', 'host'] })),
      'request-headers-dropped',
    )
    expect(d?.level).toBe('warn')
    expect(d?.title).toContain('origin, host')
    expect(d?.detail).toContain('cURL')
    // Cookie 以外には Cookie 専用の案内を付けない
    expect(d?.detail).not.toContain('credentials')
  })

  it('Cookie には credentials: include の案内を添える', () => {
    const d = find(
      diagnose(makeEntry({ mode: 'raw', responseHeaders: {}, droppedHeaders: ['cookie'] })),
      'request-headers-dropped',
    )
    expect(d?.detail).toContain('credentials')
    expect(d?.detail).toContain('include')
  })

  it('droppedHeaders が無い・空なら出さない', () => {
    expect(find(diagnose(makeEntry({ mode: 'raw' })), 'request-headers-dropped')).toBeUndefined()
    expect(
      find(diagnose(makeEntry({ mode: 'raw', droppedHeaders: [] })), 'request-headers-dropped'),
    ).toBeUndefined()
  })

  it('401 / 403 で Cookie を送れていなかったなら、原因の候補として添える', () => {
    for (const status of [401, 403]) {
      const d = find(
        diagnose(
          makeEntry({ mode: 'raw', status, responseHeaders: {}, droppedHeaders: ['cookie'] }),
        ),
        'http-status',
      )
      expect(d?.detail).toContain('Cookie ヘッダーはブラウザの仕様で送信されていません')
    }
  })

  it('Cookie 以外が落ちただけの 401 や、401 / 403 以外には添えない', () => {
    const only = (status: number, droppedHeaders: string[]) =>
      find(
        diagnose(makeEntry({ mode: 'raw', status, responseHeaders: {}, droppedHeaders })),
        'http-status',
      )?.detail
    expect(only(401, ['origin'])).not.toContain('Cookie')
    expect(only(500, ['cookie'])).not.toContain('Cookie ヘッダー')
  })
})

describe('buildDiagnostics: stream-cancelled（SDK が読み取りを打ち切った）', () => {
  const cancelled = (over: Partial<NetworkLogEntry> = {}) =>
    uiEntry(
      HELLO.slice(0, 4),
      {
        state: 'error',
        error: {
          name: STREAM_CANCELLED_ERROR,
          message: 'クライアントがレスポンスの読み取りをキャンセルしました',
        },
        ...over,
      },
      { done: false },
    )

  it('サーバー側の切断ではなく、SDK の打ち切りとして error で説明する', () => {
    const list = diagnose(cancelled())
    const d = find(list, 'stream-cancelled')
    expect(d?.level).toBe('error')
    expect(d?.title).toContain('クライアント')
    expect(d?.detail).toContain('キャンセル')
    expect(d?.detail).toContain('サーバーやプロキシが接続を切ったのではありません')
  })

  it('途中切断（ui-stream-truncated / network-error）とは重ねず、完了の表示も出さない', () => {
    const list = diagnose(cancelled())
    expect(find(list, 'ui-stream-truncated')).toBeUndefined()
    expect(find(list, 'network-error')).toBeUndefined()
    expect(find(list, 'summary')).toBeUndefined()
  })

  it('chat-text など SSE でないモードでも、ネットワークエラーとは言わない', () => {
    const list = diagnose(cancelled({ mode: 'chat-text', events: [] }))
    expect(find(list, 'stream-cancelled')).toBeDefined()
    expect(find(list, 'network-error')).toBeUndefined()
  })

  it('別の名前のエラーなら、従来どおり途中切断として扱う', () => {
    const list = diagnose(cancelled({ error: { name: 'TypeError', message: 'terminated' } }))
    expect(find(list, 'stream-cancelled')).toBeUndefined()
    expect(find(list, 'ui-stream-truncated')).toBeDefined()
  })
})

describe('buildDiagnostics: プロキシの呼び名', () => {
  const viaProxy = (over: Partial<NetworkLogEntry> = {}) =>
    makeEntry({ mode: 'raw', viaProxy: true, responseHeaders: {}, ...over })

  it('proxy-unavailable / proxy-error の見出しに、画面と同じ呼び名を使う', () => {
    const unavailable = find(diagnose(viaProxy({ status: 404 })), 'proxy-unavailable')
    expect(unavailable?.title).toContain(PROXY_NAME)
    const error = find(
      diagnose(
        viaProxy({
          status: 502,
          responseHeaders: { 'x-proxy-error': '1' },
          rawBody: '{"error":"proxy_error","message":"m"}',
        }),
      ),
      'proxy-error',
    )
    expect(error?.title).toContain(PROXY_NAME)
  })

  it('どの診断も、トグルと食い違う「開発プロキシ」「dev プロキシ」とは書かない', () => {
    const failed = (over: Partial<NetworkLogEntry>) =>
      makeEntry({
        state: 'error',
        status: undefined,
        responseHeaders: undefined,
        error: { name: 'TypeError', message: 'Failed to fetch' },
        ...over,
      })
    const entries = [
      failed({ targetUrl: 'http://localhost:28787/api/chat' }),
      failed({ targetUrl: 'http://localhost:28787/api/chat', viaProxy: true }),
      viaProxy({ status: 404 }),
      viaProxy({
        status: 502,
        responseHeaders: { 'x-proxy-error': '1' },
        rawBody: '{"error":"redirect_error","message":"m"}',
      }),
      viaProxy({
        status: 403,
        responseHeaders: { 'x-proxy-error': '1' },
        rawBody: '{"error":"forbidden","message":"m"}',
      }),
    ]
    for (const entry of entries) {
      for (const d of diagnose(entry, 'http://localhost:5173')) {
        const text = `${d.title}\n${d.detail ?? ''}`
        expect(text).not.toMatch(/開発プロキシ|dev プロキシ/)
      }
    }
  })

  it('転送先ごとのヒントが示す /__proxy は PROXY_PATH と同じ', () => {
    const d = find(diagnose(viaProxy({ status: 404 })), 'proxy-unavailable')
    expect(d?.detail).toContain(PROXY_PATH)
  })
})

describe('buildDiagnostics: ui-chunk-order（継続リクエスト。承認応答・クライアントツール出力のあとの再送）', () => {
  const userMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: '#approval' }] }
  const assistantWith = (...parts: unknown[]) => ({ id: 'a1', role: 'assistant', parts })
  const approvedTool = {
    type: 'tool-deleteFile',
    toolCallId: 'call_1',
    state: 'approval-responded',
    input: { path: '/tmp/report.txt' },
    approval: { id: 'approval_1', approved: true },
  }
  const bodyOf = (...messages: unknown[]) => JSON.stringify({ id: 'chat-1', messages })

  /** モックの #approval の 2 回目（承認すると、ツール出力と本文が同じメッセージに続く）。 */
  const APPROVED_CONTINUATION: Chunk[] = [
    { type: 'start' },
    { type: 'tool-output-available', toolCallId: 'call_1', output: { deleted: true } },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: '削除しました' },
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish' },
  ]
  const WITH_APPROVAL_BODY = bodyOf(
    userMessage,
    assistantWith({ type: 'step-start' }, approvedTool),
  )

  const run = (chunks: Chunk[], requestBody: string | undefined, over = {}) =>
    diagnose(uiEntry(chunks, { ...(requestBody === undefined ? {} : { requestBody }), ...over }))
  const order = (chunks: Chunk[], requestBody: string | undefined, over = {}) =>
    find(run(chunks, requestBody, over), 'ui-chunk-order')

  it('リクエストの最後のアシスタントメッセージが持つツール呼び出しへの出力は、警告しない', () => {
    const list = run(APPROVED_CONTINUATION, WITH_APPROVAL_BODY)
    expect(find(list, 'ui-chunk-order')).toBeUndefined()
    // 継続リクエストの正常な応答は、ok の診断だけになる
    expect(ids(list).sort()).toEqual(['http-status', 'summary', 'ui-stream-header'])
  })

  it('リクエスト body が無ければ、継続かどうか分からないので従来どおり warn', () => {
    const d = order(APPROVED_CONTINUATION, undefined)
    expect(d?.level).toBe('warn')
    expect(d?.detail).toContain('前回の応答から続く')
    expect(d?.detail).toContain('call_1')
  })

  it('承認応答（tool-approval-response）が、リクエスト内のメッセージの approval.id を参照していれば警告しない', () => {
    const chunks: Chunk[] = [
      { type: 'start' },
      { type: 'tool-approval-response', approvalId: 'approval_1', approved: true },
      { type: 'tool-output-available', toolCallId: 'call_1', output: 1 },
      { type: 'finish' },
    ]
    expect(order(chunks, WITH_APPROVAL_BODY)).toBeUndefined()
    expect(order(chunks, undefined)?.level).toBe('warn')
  })

  it('クライアントツールの出力を返したあとの再送も、前のメッセージのツール呼び出しを参照できる', () => {
    const body = bodyOf(
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '#client-tool' }] },
      assistantWith(
        { type: 'step-start' },
        {
          type: 'tool-askForConfirmation',
          toolCallId: 'call_c1',
          state: 'output-available',
          input: { message: '実行してよいですか？' },
          output: 'Yes',
        },
      ),
    )
    const chunks: Chunk[] = [
      { type: 'start' },
      { type: 'tool-output-available', toolCallId: 'call_c1', output: 'Yes' },
      { type: 'finish' },
    ]
    expect(order(chunks, body)).toBeUndefined()
    expect(order(chunks, undefined)?.level).toBe('warn')
  })

  it('dynamic-tool（MCP など）のパートの toolCallId も既知として扱う', () => {
    const body = bodyOf(
      userMessage,
      assistantWith({
        type: 'dynamic-tool',
        toolName: 'mcp_search',
        toolCallId: 'call_d1',
        state: 'output-available',
        input: {},
        output: 1,
      }),
    )
    const chunks: Chunk[] = [
      { type: 'start' },
      { type: 'tool-output-available', toolCallId: 'call_d1', output: 2 },
      { type: 'finish' },
    ]
    expect(order(chunks, body)).toBeUndefined()
  })

  it('最後のアシスタントメッセージ以外（前の会話）のツール呼び出しは既知にしない', () => {
    const body = bodyOf(
      userMessage,
      assistantWith(approvedTool),
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: '続き' }] },
      assistantWith({ ...approvedTool, toolCallId: 'call_2', approval: { id: 'approval_2' } }),
    )
    const d = order([{ type: 'tool-output-available', toolCallId: 'call_1', output: 1 }], body)
    expect(d?.level).toBe('error')
  })

  it('最後のメッセージがユーザーなら新しい応答になるので、既知のツール呼び出しは無い', () => {
    const body = bodyOf(assistantWith(approvedTool), userMessage)
    const d = order(APPROVED_CONTINUATION, body)
    expect(d?.level).toBe('error')
  })

  it('リクエストにもストリームにも無い toolCallId / approvalId の参照だけを error にする', () => {
    const unknownTool = order(
      [{ type: 'tool-output-available', toolCallId: 'call_zzz', output: 1 }],
      WITH_APPROVAL_BODY,
    )
    expect(unknownTool?.level).toBe('error')
    expect(unknownTool?.title).toContain('存在しないツール呼び出し')
    expect(unknownTool?.detail).toContain('リクエストの最後のアシスタントメッセージにも')
    expect(unknownTool?.detail).toContain('call_zzz')

    const unknownApproval = order(
      [{ type: 'tool-approval-response', approvalId: 'approval_zzz', approved: true }],
      WITH_APPROVAL_BODY,
    )
    expect(unknownApproval?.level).toBe('error')
    expect(unknownApproval?.detail).toContain('approval_zzz')
  })

  it('既知の参照と未知の参照が混ざれば、未知のものだけを列挙する', () => {
    const d = order(
      [
        { type: 'tool-output-available', toolCallId: 'call_1', output: 1 },
        { type: 'tool-output-available', toolCallId: 'call_zzz', output: 1 },
      ],
      WITH_APPROVAL_BODY,
    )
    expect(d?.title).toContain('1 件')
    expect(d?.detail).toContain('call_zzz')
    expect(d?.detail).not.toContain('call_1')
  })

  it('start より前の delta など、継続でも確実な違反は error のまま', () => {
    const d = order(
      [
        { type: 'tool-output-available', toolCallId: 'call_1', output: 1 },
        { type: 'text-delta', id: 'x', delta: 'a' },
      ],
      WITH_APPROVAL_BODY,
    )
    expect(d?.level).toBe('error')
    expect(d?.title).toContain('順序が不正')
  })

  it('前のステップのツール呼び出しも、継続メッセージの中にあれば参照できる', () => {
    const body = bodyOf(
      userMessage,
      assistantWith(
        { ...approvedTool, toolCallId: 'call_old', approval: { id: 'approval_old' } },
        { type: 'step-start' },
        { ...approvedTool, toolCallId: 'call_new', approval: { id: 'approval_new' } },
      ),
    )
    const chunks: Chunk[] = [
      { type: 'tool-output-available', toolCallId: 'call_old', output: 1 },
      { type: 'tool-output-available', toolCallId: 'call_new', output: 1 },
    ]
    expect(order(chunks, body)).toBeUndefined()
  })

  it.each([
    ['body が JSON ではない', 'not json'],
    ['JSON だが messages が無い', '{"id":"chat-1"}'],
    ['messages が配列ではない', '{"messages":"x"}'],
    ['JSON がオブジェクトではない', '[]'],
  ])('%s ときは継続かどうか分からないので warn に倒す', (_label, requestBody) => {
    expect(order(APPROVED_CONTINUATION, requestBody)?.level).toBe('warn')
  })

  it('body をログの保持上限で切り詰めていたら、たまたま JSON として読めても使わず warn に倒す', () => {
    const d = order(APPROVED_CONTINUATION, WITH_APPROVAL_BODY, { requestBodyTruncated: true })
    expect(d?.level).toBe('warn')
    expect(d?.detail).toContain('前回の応答から続く')
  })

  it('completion では順序を見ないので、body があっても何も出さない', () => {
    const entry = makeEntry({
      mode: 'completion',
      events: jsonEvents(APPROVED_CONTINUATION),
      requestBody: WITH_APPROVAL_BODY,
    })
    expect(find(diagnose(entry), 'ui-chunk-order')).toBeUndefined()
  })

  describe('SDK の実際の判定と一致する', () => {
    /** messages の最後がアシスタントなら、SDK はそのメッセージに応答を続ける。 */
    async function sdkRejectsFor(messages: unknown[], chunks: Chunk[]): Promise<boolean> {
      const last = messages.at(-1) as { role?: string } | undefined
      return sdkRejects(chunks, last?.role === 'assistant' ? last : undefined)
    }
    const analyzerErrors = (messages: unknown[], chunks: Chunk[]): boolean =>
      order(chunks, bodyOf(...messages))?.level === 'error'

    const toolPart = (toolCallId: string, approvalId?: string) => ({
      type: 'tool-deleteFile',
      toolCallId,
      state: approvalId === undefined ? 'output-available' : 'approval-responded',
      input: {},
      ...(approvalId === undefined
        ? { output: 1 }
        : { approval: { id: approvalId, approved: true } }),
    })

    const PRIORS: Array<[string, unknown[]]> = [
      [
        '承認済みのツール呼び出しを持つ',
        [userMessage, assistantWith({ type: 'step-start' }, toolPart('call_1', 'approval_1'))],
      ],
      [
        '前のステップと現在のステップにツール呼び出しを持つ',
        [
          userMessage,
          assistantWith(
            toolPart('call_1', 'approval_1'),
            { type: 'step-start' },
            toolPart('call_2', 'approval_2'),
          ),
        ],
      ],
      ['ツール呼び出しの無い', [userMessage, assistantWith({ type: 'text', text: 'hi' })]],
      ['ユーザー発言で終わる', [userMessage]],
    ]

    it.each(PRIORS)('決まった例: リクエストが %s 会話のとき', async (_label, messages) => {
      const refs: Chunk[][] = [
        APPROVED_CONTINUATION,
        [{ type: 'tool-output-available', toolCallId: 'call_2', output: 1 }],
        [{ type: 'tool-approval-response', approvalId: 'approval_2', approved: true }],
        [{ type: 'tool-approval-response', approvalId: 'approval_zzz', approved: true }],
        [
          { type: 'start-step' },
          { type: 'tool-output-denied', toolCallId: 'call_1' },
          { type: 'finish-step' },
        ],
        [
          { type: 'start-step' },
          { type: 'tool-input-available', toolCallId: 'call_1', toolName: 'w', input: {} },
          { type: 'tool-output-available', toolCallId: 'call_1', output: 1 },
        ],
        [
          { type: 'reset-step' },
          { type: 'tool-output-available', toolCallId: 'call_2', output: 1 },
        ],
      ]
      for (const chunks of refs) {
        const sdk = await sdkRejectsFor(messages, chunks)
        expect(analyzerErrors(messages, chunks), JSON.stringify(chunks)).toBe(sdk)
      }
    })

    it('乱択した chunk 列でも、継続の初期状態ごと SDK と一致する（誤検知・見落としなし）', async () => {
      let seed = 20260105
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296
        return seed / 4294967296
      }
      const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T
      const tools = ['call_1', 'call_2', 'call_x']
      const approvals = ['approval_1', 'approval_2', 'approval_x']
      const factories: Array<() => Chunk> = [
        () => ({ type: 'tool-output-available', toolCallId: pick(tools), output: 1 }),
        () => ({ type: 'tool-output-error', toolCallId: pick(tools), errorText: 'e' }),
        () => ({ type: 'tool-output-denied', toolCallId: pick(tools) }),
        () => ({
          type: 'tool-approval-request',
          toolCallId: pick(tools),
          approvalId: pick(approvals),
        }),
        () => ({ type: 'tool-approval-response', approvalId: pick(approvals), approved: true }),
        () => ({ type: 'tool-input-available', toolCallId: pick(tools), toolName: 'w', input: {} }),
        () => ({ type: 'start-step' }),
        () => ({ type: 'finish-step' }),
        () => ({ type: 'reset-step' }),
      ]
      let rejected = 0
      let accepted = 0
      const mismatches: string[] = []
      for (let n = 0; n < 600; n++) {
        const [, messages] = pick(PRIORS)
        const chunks: Chunk[] = [{ type: 'start' }]
        for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) chunks.push(pick(factories)())
        chunks.push({ type: 'finish' })
        const sdk = await sdkRejectsFor(messages, chunks)
        const flagged = analyzerErrors(messages, chunks)
        if (sdk) rejected++
        else accepted++
        if (sdk !== flagged) {
          mismatches.push(`sdk=${sdk} flagged=${flagged}: ${JSON.stringify({ messages, chunks })}`)
        }
      }
      expect(rejected).toBeGreaterThan(50)
      expect(accepted).toBeGreaterThan(50)
      expect(mismatches).toEqual([])
    })
  })
})

describe('buildDiagnostics: 純粋性', () => {
  it('entry を変更せず、呼ぶたびに同じ結果を返す', () => {
    const entry = uiEntry([...HELLO, { type: 'mystery' }])
    const snapshot = structuredClone(entry)
    const first = diagnose(entry)
    const second = diagnose(entry)
    expect(first).toEqual(second)
    expect(entry).toEqual(snapshot)
  })

  it('ctx を省略しても動く', () => {
    expect(() => buildDiagnostics(uiEntry(HELLO))).not.toThrow()
  })
})

/**
 * ui-chunk-order が AI SDK 本体（process-ui-message-stream）の判定と食い違っていないかを、実物で確かめる。
 * 検証コードの条件は SDK のバージョンで変わりうるので、更新時に気づけるよう乱択で突き合わせておく。
 */
describe('buildDiagnostics: ui-chunk-order は AI SDK の実際の判定と一致する', () => {
  /** 正しい chunk 列を作ってから、0〜1 か所だけ壊す（削除 / 重複 / 入れ替え）。 */
  function randomSequence(rnd: () => number): Chunk[] {
    const pick = (n: number) => Math.floor(rnd() * n)
    const chunks: Chunk[] = [{ type: 'start' }]
    for (let step = 0; step < 1 + pick(3); step++) {
      chunks.push({ type: 'start-step' })
      for (let block = 0; block < 1 + pick(3); block++) {
        const id = `i${pick(3)}`
        const tool = `t${pick(3)}`
        const approval = `ap${pick(2)}`
        switch (pick(4)) {
          case 0:
            chunks.push(
              { type: 'text-start', id },
              { type: 'text-delta', id, delta: 'x' },
              { type: 'text-end', id },
            )
            break
          case 1:
            chunks.push(
              { type: 'reasoning-start', id },
              { type: 'reasoning-delta', id, delta: 'x' },
              { type: 'reasoning-end', id },
            )
            break
          case 2:
            chunks.push(
              { type: 'tool-input-start', toolCallId: tool, toolName: 'w' },
              { type: 'tool-input-delta', toolCallId: tool, inputTextDelta: '{' },
              { type: 'tool-input-available', toolCallId: tool, toolName: 'w', input: {} },
              { type: 'tool-output-available', toolCallId: tool, output: 1 },
            )
            break
          default:
            chunks.push(
              { type: 'tool-input-available', toolCallId: tool, toolName: 'w', input: {} },
              { type: 'tool-approval-request', toolCallId: tool, approvalId: approval },
              { type: 'tool-approval-response', approvalId: approval, approved: true },
              { type: 'tool-output-denied', toolCallId: tool },
            )
        }
        if (rnd() < 0.1) chunks.push({ type: 'reset-step' })
      }
      chunks.push({ type: 'finish-step' })
    }
    chunks.push({ type: 'finish' })

    if (rnd() < 0.6) {
      const i = 1 + pick(chunks.length - 1)
      const j = 1 + pick(chunks.length - 1)
      const kind = pick(3)
      if (kind === 0) chunks.splice(i, 1)
      else if (kind === 1) chunks.splice(i, 0, chunks[i] as Chunk)
      else [chunks[i], chunks[j]] = [chunks[j] as Chunk, chunks[i] as Chunk]
    }
    return chunks
  }

  it('乱択した chunk 列で、SDK がエラーにする列だけを指摘する（誤検知・見落としなし）', async () => {
    let seed = 20240607
    // 再現できるよう線形合同法で乱数を作る
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    const mismatches: string[] = []
    let rejected = 0
    let accepted = 0
    for (let n = 0; n < 1500; n++) {
      const chunks = randomSequence(rnd)
      const sdk = await sdkRejects(chunks)
      const flagged = find(diagnose(uiEntry(chunks)), 'ui-chunk-order') !== undefined
      if (sdk) rejected++
      else accepted++
      if (sdk !== flagged)
        mismatches.push(`sdk=${sdk} flagged=${flagged}: ${JSON.stringify(chunks)}`)
    }
    // 偏りすぎて片側しか確かめていない、という状態を防ぐ
    expect(rejected).toBeGreaterThan(100)
    expect(accepted).toBeGreaterThan(100)
    expect(mismatches).toEqual([])
  })
})
