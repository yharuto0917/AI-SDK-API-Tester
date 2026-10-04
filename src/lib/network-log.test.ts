import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNetworkLog, networkLog } from '@/lib/network-log'
import type { BeginLogInit, NetworkLogOptions } from '@/lib/network-log'

const INIT: BeginLogInit = {
  mode: 'chat-ui',
  method: 'POST',
  targetUrl: 'http://localhost:5173/api/chat',
  viaProxy: false,
  requestHeaders: { 'content-type': 'application/json' },
  requestBody: '{"messages":[]}',
}

const HEAD = {
  status: 200,
  statusText: 'OK',
  responseHeaders: { 'Content-Type': 'text/event-stream', 'X-Vercel-AI-UI-Message-Stream': 'v1' },
}

/** 時計とスケジューラーを手動で進められるストア。 */
function setup(opts: NetworkLogOptions = {}) {
  let t = 1000
  const pending = new Set<{ cb: () => void }>()
  const log = createNetworkLog({
    now: () => t,
    schedule: (cb) => {
      const timer = { cb }
      pending.add(timer)
      return () => {
        pending.delete(timer)
      }
    },
    pageOrigin: () => 'http://localhost:5173',
    ...opts,
  })
  const listener = vi.fn()
  log.subscribe(listener)
  return {
    log,
    listener,
    advance: (ms: number) => {
      t += ms
    },
    /** 保留中のスケジュールをすべて実行する */
    flush: () => {
      for (const timer of [...pending]) {
        pending.delete(timer)
        timer.cb()
      }
    },
    pendingCount: () => pending.size,
  }
}

const sse = (...chunks: Array<Record<string, unknown>>) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')

const HELLO_WIRE =
  sse(
    { type: 'start', messageId: 'm1' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Hello' },
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish' },
  ) + 'data: [DONE]\n\n'

afterEach(() => {
  vi.useRealTimers()
})

describe('begin', () => {
  it('pending のエントリを作り、自動で選択状態にする', () => {
    const { log, listener } = setup()
    const before = Date.now()
    const id = log.begin(INIT)
    const entry = log.getEntry(id)

    expect(entry).toMatchObject({
      id,
      mode: 'chat-ui',
      method: 'POST',
      targetUrl: 'http://localhost:5173/api/chat',
      viaProxy: false,
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: '{"messages":[]}',
      state: 'pending',
      events: [],
      eventsTruncated: false,
      rawBody: '',
      rawBodyTruncated: false,
      bytesReceived: 0,
      diagnostics: [],
    })
    expect(entry?.startedAt).toBeGreaterThanOrEqual(before)
    expect(entry?.startedAt).toBeLessThanOrEqual(Date.now())
    expect(entry?.status).toBeUndefined()
    expect(log.getSelectedId()).toBe(id)
    expect(log.getEntries()).toEqual([entry])
    // begin は即時通知
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('新しい順に並び、id は重複しない', () => {
    const { log } = setup()
    const a = log.begin(INIT)
    const b = log.begin(INIT)
    const c = log.begin(INIT)
    expect(new Set([a, b, c]).size).toBe(3)
    expect(log.getEntries().map((e) => e.id)).toEqual([c, b, a])
    expect(log.getSelectedId()).toBe(c)
  })

  it('requestBody が無ければキー自体を持たない', () => {
    const { log } = setup()
    const { requestBody: _omitted, ...withoutBody } = INIT
    const entry = log.getEntry(log.begin(withoutBody))
    expect(entry).toBeDefined()
    expect('requestBody' in (entry ?? {})).toBe(false)
  })

  it('requestHeaders は渡した object と共有しない', () => {
    const { log } = setup()
    const headers = { a: '1' }
    const id = log.begin({ ...INIT, requestHeaders: headers })
    headers.a = 'changed'
    expect(log.getEntry(id)?.requestHeaders).toEqual({ a: '1' })
  })

  it('maxEntries を超えたら古いものから捨てる', () => {
    const { log } = setup({ maxEntries: 3 })
    const ids = Array.from({ length: 5 }, () => log.begin(INIT))
    expect(log.getEntries().map((e) => e.id)).toEqual([ids[4], ids[3], ids[2]])
    expect(log.getEntry(ids[0] as string)).toBeUndefined()
    expect(log.getEntry(ids[1] as string)).toBeUndefined()
  })

  it('捨てられたエントリへの記録は無視され、例外にもならない', () => {
    const { log } = setup({ maxEntries: 1 })
    const old = log.begin(INIT)
    log.begin(INIT)
    expect(() => {
      log.recordHead(old, HEAD)
      log.recordText(old, 'x', { sse: false })
      log.finish(old, { state: 'done' })
    }).not.toThrow()
    expect(log.getEntries()).toHaveLength(1)
    expect(log.getEntry(old)).toBeUndefined()
  })

  it('選択中のエントリが捨てられるときは、新しいエントリが選択される', () => {
    const { log } = setup({ maxEntries: 2 })
    const a = log.begin(INIT)
    const b = log.begin(INIT)
    log.select(a)
    const c = log.begin(INIT)
    expect(log.getEntries().map((e) => e.id)).toEqual([c, b])
    expect(log.getSelectedId()).toBe(c)
  })

  it('既定の上限は 200 件', () => {
    const { log } = setup()
    for (let i = 0; i < 205; i++) log.begin(INIT)
    expect(log.getEntries()).toHaveLength(200)
  })
})

describe('select / clear', () => {
  it('select で選択を切り替え、即時通知する', () => {
    const { log, listener } = setup()
    const a = log.begin(INIT)
    log.begin(INIT)
    listener.mockClear()
    log.select(a)
    expect(log.getSelectedId()).toBe(a)
    expect(listener).toHaveBeenCalledTimes(1)
    log.select(null)
    expect(log.getSelectedId()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('同じ値の select は通知しない', () => {
    const { log, listener } = setup()
    const a = log.begin(INIT)
    listener.mockClear()
    log.select(a)
    expect(listener).not.toHaveBeenCalled()
  })

  it('存在しない id は選べない', () => {
    const { log, listener } = setup()
    const a = log.begin(INIT)
    listener.mockClear()
    log.select('nope')
    expect(log.getSelectedId()).toBe(a)
    expect(listener).not.toHaveBeenCalled()
  })

  it('clear で全エントリと選択を消す', () => {
    const { log, listener } = setup()
    log.begin(INIT)
    log.begin(INIT)
    listener.mockClear()
    log.clear()
    expect(log.getEntries()).toEqual([])
    expect(log.getSelectedId()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('空のときの clear は通知せず、参照も変えない', () => {
    const { log, listener } = setup()
    const before = log.getEntries()
    log.clear()
    expect(log.getEntries()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('clear したあとに通信中だったエントリへ記録が来ても無視する', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.clear()
    expect(() => {
      log.recordHead(id, HEAD)
      log.recordText(id, sse({ type: 'start' }), { sse: true })
      log.finish(id, { state: 'done' })
    }).not.toThrow()
    expect(log.getEntries()).toEqual([])
    const next = log.begin(INIT)
    expect(next).not.toBe(id)
    expect(log.getEntries().map((e) => e.id)).toEqual([next])
  })

  it('subscribe の解除後は通知されない', () => {
    const { log } = setup()
    const listener = vi.fn()
    const unsubscribe = log.subscribe(listener)
    log.begin(INIT)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    log.begin(INIT)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('recordHead', () => {
  it('状態を streaming にし、ステータス・小文字化したヘッダー・ttfbMs を入れる', () => {
    const { log, advance } = setup()
    const id = log.begin(INIT)
    advance(120)
    log.recordHead(id, HEAD)
    const entry = log.getEntry(id)
    expect(entry?.state).toBe('streaming')
    expect(entry?.status).toBe(200)
    expect(entry?.statusText).toBe('OK')
    expect(entry?.responseHeaders).toEqual({
      'content-type': 'text/event-stream',
      'x-vercel-ai-ui-message-stream': 'v1',
    })
    expect(entry?.ttfbMs).toBe(120)
    expect(entry?.totalMs).toBeUndefined()
  })

  it('ヘッダー受信時点で分かる診断だけを付ける', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    const ids = log.getEntry(id)?.diagnostics.map((d) => d.id)
    expect(ids?.sort()).toEqual(['http-status', 'ui-stream-header'])
  })

  it('Content-Type の誤りや HTTP エラーはヘッダー時点で診断される', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordHead(id, {
      status: 200,
      statusText: 'OK',
      responseHeaders: { 'content-type': 'application/json' },
    })
    expect(log.getEntry(id)?.diagnostics.find((d) => d.id === 'content-type')?.level).toBe('warn')

    const id2 = log.begin(INIT)
    log.recordHead(id2, { status: 401, statusText: 'Unauthorized', responseHeaders: {} })
    expect(log.getEntry(id2)?.diagnostics.find((d) => d.id === 'http-status')?.level).toBe('error')
  })

  it('ttfbMs は now() の差で、負にならない', () => {
    const { log } = setup({
      now: (() => {
        let n = 100
        return () => (n -= 10)
      })(),
    })
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    expect(log.getEntry(id)?.ttfbMs).toBe(0)
  })

  it('未知の id や完了済みのエントリは無視する', () => {
    const { log, listener } = setup()
    const id = log.begin(INIT)
    log.finish(id, { state: 'done' })
    const finished = log.getEntry(id)
    listener.mockClear()
    log.recordHead(id, HEAD)
    log.recordHead('nope', HEAD)
    expect(log.getEntry(id)).toBe(finished)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('recordText: SSE', () => {
  it('SSE を JSON / [DONE] / コメント / テキストのイベントにする', () => {
    const { log, advance } = setup()
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    advance(30)
    log.recordText(
      id,
      ': ping\n\nevent: custom\ndata: {"type":"text-delta","id":"t","delta":"hi"}\n\ndata: not json\n\ndata: [DONE]\n\n',
      { sse: true },
    )
    const events = log.getEntry(id)?.events ?? []
    expect(events.map((e) => e.kind)).toEqual(['sse-comment', 'sse-json', 'sse-text', 'sse-done'])
    expect(events.map((e) => e.index)).toEqual([0, 1, 2, 3])
    expect(events.every((e) => e.atMs === 30)).toBe(true)

    expect(events[0]).toMatchObject({ raw: 'ping' })
    expect(events[1]).toMatchObject({
      eventName: 'custom',
      type: 'text-delta',
      data: { type: 'text-delta', id: 't', delta: 'hi' },
      raw: '{"type":"text-delta","id":"t","delta":"hi"}',
    })
    expect(events[2]?.raw).toBe('not json')
    expect(events[2]?.parseError).toEqual(expect.any(String))
    expect(events[2]?.data).toBeUndefined()
    expect(events[3]).toMatchObject({ raw: '[DONE]' })
  })

  it('JSON でも type が文字列でなければ type は付けない', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordText(id, 'data: {"type":1}\n\ndata: [1,2]\n\ndata: "x"\n\ndata: null\n\n', {
      sse: true,
    })
    const events = log.getEntry(id)?.events ?? []
    expect(events.map((e) => e.kind)).toEqual(['sse-json', 'sse-json', 'sse-json', 'sse-json'])
    expect(events.every((e) => e.type === undefined)).toBe(true)
    expect(events[3]?.data).toBeNull()
  })

  it('[DONE] は完全一致のみ（前後に空白があれば JSON 以外のテキスト扱い）', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordText(id, 'data: [DONE] \n\n', { sse: true })
    expect(log.getEntry(id)?.events[0]?.kind).toBe('sse-text')
  })

  it('チャンクの境界で割れたイベントも 1 つにまとまり、index は通し番号になる', () => {
    const { log, advance } = setup()
    const id = log.begin(INIT)
    log.recordText(id, 'data: {"type":"sta', { sse: true })
    expect(log.getEntry(id)?.events).toEqual([])
    advance(10)
    log.recordText(id, 'rt"}\n\ndata: {"type":"fin', { sse: true })
    advance(10)
    log.recordText(id, 'ish"}\n\n', { sse: true })
    const events = log.getEntry(id)?.events ?? []
    expect(events.map((e) => [e.index, e.type, e.atMs])).toEqual([
      [0, 'start', 10],
      [1, 'finish', 20],
    ])
  })

  it('rawBody に追記し、bytesReceived は UTF-8 のバイト数で数える', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordText(id, 'data: あ\n\n', { sse: true })
    log.recordText(id, 'data: 😀\n\n', { sse: true })
    const entry = log.getEntry(id)
    expect(entry?.rawBody).toBe('data: あ\n\ndata: 😀\n\n')
    // 'data: ' 6 + 'あ' 3 + '\n\n' 2 = 11、'data: ' 6 + '😀' 4 + '\n\n' 2 = 12
    expect(entry?.bytesReceived).toBe(23)
    expect(entry?.bytesReceived).toBe(new TextEncoder().encode(entry?.rawBody ?? '').length)
  })

  it('対になっていない代用対も TextEncoder と同じバイト数で数える', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    const lone = 'a\ud800b\udc00'
    log.recordText(id, lone, { sse: false })
    expect(log.getEntry(id)?.bytesReceived).toBe(new TextEncoder().encode(lone).length)
  })

  it('pending のまま本文が来たら streaming にする', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordText(id, 'data: {}\n\n', { sse: true })
    expect(log.getEntry(id)?.state).toBe('streaming')
  })

  it('空文字は無視する', () => {
    const { log, listener } = setup()
    const id = log.begin(INIT)
    const before = log.getEntry(id)
    listener.mockClear()
    log.recordText(id, '', { sse: true })
    expect(log.getEntry(id)).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('recordText: 非 SSE', () => {
  it('呼び出しごとに text-chunk イベントを 1 つ作る', () => {
    const { log, advance } = setup()
    const id = log.begin({ ...INIT, mode: 'chat-text' })
    advance(5)
    log.recordText(id, 'Hel', { sse: false })
    advance(5)
    log.recordText(id, 'lo\n\ndata: x', { sse: false })
    const entry = log.getEntry(id)
    expect(entry?.events).toEqual([
      { index: 0, atMs: 5, kind: 'text-chunk', raw: 'Hel' },
      { index: 1, atMs: 10, kind: 'text-chunk', raw: 'lo\n\ndata: x' },
    ])
    expect(entry?.rawBody).toBe('Hello\n\ndata: x')
  })
})

describe('上限と truncated', () => {
  it('maxEvents を超えたら eventsTruncated を立て、超えた分は捨てる（bytesReceived は加算し続ける）', () => {
    const { log } = setup({ maxEvents: 3 })
    const id = log.begin(INIT)
    log.recordText(id, 'data: 1\n\ndata: 2\n\n', { sse: true })
    expect(log.getEntry(id)?.eventsTruncated).toBe(false)
    log.recordText(id, 'data: 3\n\ndata: 4\n\ndata: 5\n\n', { sse: true })
    const entry = log.getEntry(id)
    expect(entry?.events.map((e) => e.raw)).toEqual(['1', '2', '3'])
    expect(entry?.events.map((e) => e.index)).toEqual([0, 1, 2])
    expect(entry?.eventsTruncated).toBe(true)
    expect(entry?.bytesReceived).toBe(new TextEncoder().encode(entry?.rawBody ?? '').length)
    log.recordText(id, 'data: 6\n\n', { sse: true })
    expect(log.getEntry(id)?.events).toHaveLength(3)
    expect(log.getEntry(id)?.bytesReceived).toBeGreaterThan(entry?.bytesReceived ?? 0)
  })

  it('ちょうど上限なら truncated にならない', () => {
    const { log } = setup({ maxEvents: 2 })
    const id = log.begin(INIT)
    log.recordText(id, 'data: 1\n\ndata: 2\n\n', { sse: true })
    expect(log.getEntry(id)?.eventsTruncated).toBe(false)
  })

  it('非 SSE でも maxEvents が効く', () => {
    const { log } = setup({ maxEvents: 2 })
    const id = log.begin(INIT)
    for (const text of ['a', 'b', 'c']) log.recordText(id, text, { sse: false })
    const entry = log.getEntry(id)
    expect(entry?.events.map((e) => e.raw)).toEqual(['a', 'b'])
    expect(entry?.eventsTruncated).toBe(true)
    expect(entry?.rawBody).toBe('abc')
  })

  it('maxEvents を超えたあとの finish でも落ちず、診断が付く', () => {
    const { log } = setup({ maxEvents: 2 })
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    log.recordText(id, HELLO_WIRE, { sse: true })
    log.finish(id, { state: 'done' })
    const entry = log.getEntry(id)
    expect(entry?.events).toHaveLength(2)
    expect(entry?.eventsTruncated).toBe(true)
    expect(entry?.diagnostics.length).toBeGreaterThan(0)
  })

  it('maxBodyChars を超えたら rawBodyTruncated を立て、超えた分は rawBody に入れない', () => {
    const { log } = setup({ maxBodyChars: 10 })
    const id = log.begin(INIT)
    log.recordText(id, '12345', { sse: false })
    expect(log.getEntry(id)?.rawBodyTruncated).toBe(false)
    log.recordText(id, '6789012345', { sse: false })
    const entry = log.getEntry(id)
    expect(entry?.rawBody).toBe('1234567890')
    expect(entry?.rawBodyTruncated).toBe(true)
    expect(entry?.bytesReceived).toBe(15)
    // 切り詰め後に来た分も rawBody には入らないが、bytesReceived には入る
    log.recordText(id, 'abc', { sse: false })
    expect(log.getEntry(id)?.rawBody).toBe('1234567890')
    expect(log.getEntry(id)?.bytesReceived).toBe(18)
  })

  it('ちょうど上限なら rawBodyTruncated にならない', () => {
    const { log } = setup({ maxBodyChars: 5 })
    const id = log.begin(INIT)
    log.recordText(id, '12345', { sse: false })
    expect(log.getEntry(id)?.rawBodyTruncated).toBe(false)
    expect(log.getEntry(id)?.rawBody).toBe('12345')
  })

  it('代用対の途中では切らない', () => {
    const { log } = setup({ maxBodyChars: 3 })
    const id = log.begin(INIT)
    log.recordText(id, 'ab😀', { sse: false })
    const entry = log.getEntry(id)
    expect(entry?.rawBody).toBe('ab')
    expect(entry?.rawBodyTruncated).toBe(true)
    expect(entry?.bytesReceived).toBe(6)
  })

  it('rawBody が上限に達しても SSE のイベントは作り続ける', () => {
    const { log } = setup({ maxBodyChars: 4 })
    const id = log.begin(INIT)
    log.recordText(id, 'data: {"type":"a"}\n\ndata: {"type":"b"}\n\n', { sse: true })
    const entry = log.getEntry(id)
    expect(entry?.rawBodyTruncated).toBe(true)
    expect(entry?.events.map((e) => e.type)).toEqual(['a', 'b'])
  })
})

describe('イミュータブルな更新', () => {
  it('更新のたびにエントリ・events・entries が新しい参照になり、古い参照は変化しない', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    const e0 = log.getEntry(id)
    const list0 = log.getEntries()

    log.recordText(id, 'data: {"type":"a"}\n\n', { sse: true })
    const e1 = log.getEntry(id)
    const list1 = log.getEntries()
    expect(e1).not.toBe(e0)
    expect(e1?.events).not.toBe(e0?.events)
    expect(list1).not.toBe(list0)
    expect(e0?.events).toEqual([])
    expect(e0?.rawBody).toBe('')
    expect(list0[0]).toBe(e0)

    log.recordText(id, 'data: {"type":"b"}\n\n', { sse: true })
    const e2 = log.getEntry(id)
    expect(e2).not.toBe(e1)
    expect(e2?.events).not.toBe(e1?.events)
    expect(e1?.events).toHaveLength(1)
    expect(e2?.events).toHaveLength(2)
    // 既存イベントのオブジェクトは使い回してよい
    expect(e2?.events[0]).toBe(e1?.events[0])
  })

  it('他のエントリは更新されても同じ参照のまま', () => {
    const { log } = setup()
    const a = log.begin(INIT)
    const b = log.begin(INIT)
    const entryA = log.getEntry(a)
    log.recordText(b, 'x', { sse: false })
    expect(log.getEntry(a)).toBe(entryA)
    expect(log.getEntries()[1]).toBe(entryA)
  })

  it('変更が無い間は getEntries が同じ参照を返す', () => {
    const { log } = setup()
    log.begin(INIT)
    expect(log.getEntries()).toBe(log.getEntries())
    expect(log.getEntry(log.getEntries()[0]?.id ?? '')).toBe(log.getEntries()[0])
  })

  it('エントリの順序は更新で変わらない', () => {
    const { log } = setup()
    const a = log.begin(INIT)
    const b = log.begin(INIT)
    log.recordText(a, 'x', { sse: false })
    log.finish(a, { state: 'done' })
    expect(log.getEntries().map((e) => e.id)).toEqual([b, a])
  })
})

describe('通知の間引き', () => {
  it('recordHead / recordText は即時には通知せず、スケジュールを 1 つだけ作る', () => {
    const { log, listener, pendingCount } = setup()
    const id = log.begin(INIT)
    listener.mockClear()

    log.recordHead(id, HEAD)
    log.recordText(id, 'data: 1\n\n', { sse: true })
    log.recordText(id, 'data: 2\n\n', { sse: true })
    log.recordText(id, 'data: 3\n\n', { sse: true })
    expect(listener).not.toHaveBeenCalled()
    expect(pendingCount()).toBe(1)
  })

  it('スケジュールが実行されると 1 回だけ通知し、そのとき最新の状態が読める', () => {
    const { log, listener, flush } = setup()
    const id = log.begin(INIT)
    listener.mockClear()
    for (let i = 0; i < 10; i++) log.recordText(id, `data: ${i}\n\n`, { sse: true })
    flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(log.getEntry(id)?.events).toHaveLength(10)
  })

  it('通知のあとにまた記録すれば、新しいスケジュールが作られる', () => {
    const { log, listener, flush, pendingCount } = setup()
    const id = log.begin(INIT)
    listener.mockClear()
    log.recordText(id, 'a', { sse: false })
    flush()
    expect(pendingCount()).toBe(0)
    log.recordText(id, 'b', { sse: false })
    expect(pendingCount()).toBe(1)
    flush()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('begin / select / clear / finish は即時に通知し、保留中のスケジュールを取り消す', () => {
    const { log, listener, flush, pendingCount } = setup()
    const a = log.begin(INIT)
    const b = log.begin(INIT)

    log.recordText(a, 'x', { sse: false })
    expect(pendingCount()).toBe(1)
    listener.mockClear()
    log.begin(INIT)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(pendingCount()).toBe(0)

    log.recordText(a, 'y', { sse: false })
    listener.mockClear()
    log.select(b)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(pendingCount()).toBe(0)

    log.recordText(a, 'z', { sse: false })
    listener.mockClear()
    log.finish(a, { state: 'done' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(pendingCount()).toBe(0)

    log.recordText(b, 'w', { sse: false })
    listener.mockClear()
    log.clear()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(pendingCount()).toBe(0)

    // 取り消されたスケジュールを実行しても余計な通知は出ない
    flush()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('無視された記録（未知の id・完了後）はスケジュールを作らない', () => {
    const { log, pendingCount } = setup()
    const id = log.begin(INIT)
    log.finish(id, { state: 'done' })
    log.recordText(id, 'x', { sse: false })
    log.recordHead(id, HEAD)
    log.recordText('nope', 'x', { sse: false })
    expect(pendingCount()).toBe(0)
  })

  it('スケジューラーが同期的に cb を呼んでも、以降の通知が止まらない', () => {
    const log = createNetworkLog({ schedule: (cb) => (cb(), () => {}) })
    const listener = vi.fn()
    log.subscribe(listener)
    const id = log.begin(INIT)
    listener.mockClear()
    log.recordText(id, 'a', { sse: false })
    log.recordText(id, 'b', { sse: false })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('既定のスケジューラーは約 50ms に 1 回へ合体する', () => {
    vi.useFakeTimers()
    const log = createNetworkLog()
    const listener = vi.fn()
    log.subscribe(listener)
    const id = log.begin(INIT)
    listener.mockClear()

    log.recordText(id, 'a', { sse: false })
    vi.advanceTimersByTime(49)
    log.recordText(id, 'b', { sse: false })
    expect(listener).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(listener).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('finish', () => {
  it('state と totalMs を確定し、診断を付ける', () => {
    const { log, advance } = setup()
    const id = log.begin(INIT)
    advance(100)
    log.recordHead(id, HEAD)
    advance(400)
    log.recordText(id, HELLO_WIRE, { sse: true })
    advance(500)
    log.finish(id, { state: 'done' })
    const entry = log.getEntry(id)
    expect(entry?.state).toBe('done')
    expect(entry?.ttfbMs).toBe(100)
    expect(entry?.totalMs).toBe(1000)
    expect(entry?.error).toBeUndefined()
    const summary = entry?.diagnostics.find((d) => d.id === 'summary')
    expect(summary?.level).toBe('ok')
    expect(summary?.detail).toContain('チャンク数 8')
    expect(entry?.diagnostics.every((d) => d.level === 'ok')).toBe(true)
  })

  it('末尾の空行が無いまま終わった SSE の最後のイベントは、表示に残しつつ SDK 未受信（incomplete）として診断する', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    log.recordText(id, 'data: {"type":"start"}\n\ndata: {"type":"finish"}', { sse: true })
    expect(log.getEntry(id)?.events).toHaveLength(1)
    log.finish(id, { state: 'done' })
    const entry = log.getEntry(id)
    expect(entry?.events.map((e) => e.type)).toEqual(['start', 'finish'])
    expect(entry?.events[0]).not.toHaveProperty('incomplete')
    expect(entry?.events[1]?.incomplete).toBe(true)
    const ids = entry?.diagnostics.map((d) => d.id) ?? []
    // finish は SDK に届いていないので、finish の受信とは数えない
    expect(ids).toContain('ui-stream-no-finish')
    expect(ids).toContain('sse-unterminated-event')
    expect(ids).not.toContain('summary')
  })

  it('途中で切れた JSON は sse-text（incomplete）として残る。SDK には届いていないので不正 JSON とは診断しない', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    log.recordText(id, 'data: {"type":"text-de', { sse: true })
    log.finish(id, { state: 'error', error: { name: 'TypeError', message: 'terminated' } })
    const entry = log.getEntry(id)
    expect(entry?.events[0]?.kind).toBe('sse-text')
    expect(entry?.events[0]?.incomplete).toBe(true)
    expect(entry?.diagnostics.map((d) => d.id)).not.toContain('sse-invalid-json')
    expect(entry?.diagnostics.map((d) => d.id)).toContain('ui-stream-truncated')
  })

  it('error / aborted では error 情報を保存する（コピーを持つ）', () => {
    const { log } = setup()
    const error = { name: 'TypeError', message: 'Failed to fetch', hint: 'CORS かも' }
    const id = log.begin(INIT)
    log.finish(id, { state: 'error', error })
    expect(log.getEntry(id)?.state).toBe('error')
    expect(log.getEntry(id)?.error).toEqual(error)
    expect(log.getEntry(id)?.error).not.toBe(error)

    const id2 = log.begin(INIT)
    log.finish(id2, { state: 'aborted' })
    expect(log.getEntry(id2)?.state).toBe('aborted')
    expect(log.getEntry(id2)?.diagnostics.map((d) => d.id)).toContain('aborted')
  })

  it('done のときは error が渡されても保存しない', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.finish(id, { state: 'done', error: { name: 'X', message: 'y' } })
    expect(log.getEntry(id)?.error).toBeUndefined()
  })

  it('fetch 失敗の診断では pageOrigin を使ってクロスオリジンを判定する', () => {
    const { log } = setup()
    const id = log.begin({ ...INIT, targetUrl: 'http://localhost:28787/api/chat' })
    log.finish(id, { state: 'error', error: { name: 'TypeError', message: 'Failed to fetch' } })
    const d = log.getEntry(id)?.diagnostics.find((x) => x.id === 'network-error')
    expect(d?.title).toContain('CORS')

    const sameOrigin = log.begin(INIT)
    log.finish(sameOrigin, {
      state: 'error',
      error: { name: 'TypeError', message: 'Failed to fetch' },
    })
    expect(
      log.getEntry(sameOrigin)?.diagnostics.find((x) => x.id === 'network-error')?.title,
    ).not.toContain('CORS')
  })

  it('順序違反の SSE はエラー診断になり、summary は出ない', () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    log.recordText(id, sse({ type: 'text-delta', id: 'x', delta: 'a' }, { type: 'finish' }), {
      sse: true,
    })
    log.finish(id, { state: 'done' })
    const diagnostics = log.getEntry(id)?.diagnostics ?? []
    expect(diagnostics.find((d) => d.id === 'ui-chunk-order')?.level).toBe('error')
    expect(diagnostics.find((d) => d.id === 'summary')).toBeUndefined()
    expect(diagnostics[0]?.level).toBe('error')
  })

  it('body の無いレスポンス（head → finish）でも summary が出る', () => {
    const { log } = setup()
    const id = log.begin({ ...INIT, mode: 'raw' })
    log.recordHead(id, { status: 204, statusText: 'No Content', responseHeaders: {} })
    log.finish(id, { state: 'done' })
    expect(
      log
        .getEntry(id)
        ?.diagnostics.map((d) => d.id)
        .sort(),
    ).toEqual(['http-status', 'summary'])
  })

  it('2 回目の finish と、finish 後の記録は無視する（最初の結果が残る）', () => {
    const { log, listener } = setup()
    const id = log.begin(INIT)
    log.finish(id, { state: 'error', error: { name: 'E', message: 'first' } })
    const finished = log.getEntry(id)
    listener.mockClear()
    log.finish(id, { state: 'done' })
    log.recordText(id, 'late', { sse: false })
    expect(log.getEntry(id)).toBe(finished)
    expect(log.getEntry(id)?.error?.message).toBe('first')
    expect(listener).not.toHaveBeenCalled()
  })

  it('未知の id は無視する', () => {
    const { log, listener } = setup()
    listener.mockClear()
    expect(() => log.finish('nope', { state: 'done' })).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it('通信が並行していても、エントリごとに独立して集計する', () => {
    const { log, advance } = setup()
    const a = log.begin(INIT)
    advance(10)
    const b = log.begin(INIT)
    log.recordText(a, 'data: {"type":"a"}\n\n', { sse: true })
    log.recordText(b, 'data: {"type":"b"}\n\n', { sse: true })
    advance(10)
    log.finish(a, { state: 'done' })
    log.finish(b, { state: 'done' })
    expect(log.getEntry(a)?.events.map((e) => e.type)).toEqual(['a'])
    expect(log.getEntry(b)?.events.map((e) => e.type)).toEqual(['b'])
    expect(log.getEntry(a)?.totalMs).toBe(20)
    expect(log.getEntry(b)?.totalMs).toBe(10)
  })
})

describe('メモリの上限（イベント 1 件・パーサー・ストア全体）', () => {
  const big = (type: string, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ type, ...extra })}\n\n`

  it('1 イベントの raw が上限を超えたら切り詰めて rawTruncated を立て、data は省略版にする', () => {
    const { log } = setup({ maxEventChars: 100 })
    const id = log.begin(INIT)
    const delta = 'あ'.repeat(5000)
    log.recordText(
      id,
      big('text-delta', { id: 't1', delta, providerMetadata: { a: { b: 1 } }, tags: [1, 2, 3] }),
      { sse: true },
    )
    const event = log.getEntry(id)?.events[0]
    expect(event?.kind).toBe('sse-json')
    expect(event?.rawTruncated).toBe(true)
    expect(event?.raw).toHaveLength(100)
    // 診断に必要な type / id は残り、長い文字列・入れ子は小さくなる
    expect(event?.type).toBe('text-delta')
    const data = event?.data as Record<string, unknown>
    expect(data.type).toBe('text-delta')
    expect(data.id).toBe('t1')
    expect(String(data.delta).length).toBeLessThan(1100)
    expect(String(data.delta)).toContain('省略: 全 5000 文字')
    expect(data.providerMetadata).toContain('省略')
    expect(data.tags).toContain('配列 3 件')
  })

  it('上限以内のイベントは raw も data もそのまま', () => {
    const { log } = setup({ maxEventChars: 1000 })
    const id = log.begin(INIT)
    log.recordText(id, big('text-delta', { id: 't1', delta: 'hi', n: { a: 1 } }), { sse: true })
    const event = log.getEntry(id)?.events[0]
    expect(event).not.toHaveProperty('rawTruncated')
    expect(event?.data).toEqual({ type: 'text-delta', id: 't1', delta: 'hi', n: { a: 1 } })
  })

  it('切り詰めたイベントも type は分かるので、巨大な chunk が不正 JSON や未知 type と誤診断されない', () => {
    const { log } = setup({ maxEventChars: 50 })
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    log.recordText(
      id,
      sse({ type: 'start' }) +
        big('file', { url: `data:image/png;base64,${'A'.repeat(20000)}`, mediaType: 'image/png' }) +
        sse({ type: 'finish' }) +
        'data: [DONE]\n\n',
      { sse: true },
    )
    log.finish(id, { state: 'done' })
    const entry = log.getEntry(id)
    expect(entry?.events.map((e) => e.type)).toEqual(['start', 'file', 'finish', undefined])
    const ids = entry?.diagnostics.map((d) => d.id) ?? []
    expect(ids).not.toContain('sse-invalid-json')
    expect(ids).not.toContain('ui-chunk-unknown-type')
    expect(ids).toContain('summary')
  })

  it('CJK や絵文字の途中（代用対）で raw を切らない', () => {
    const { log } = setup({ maxEventChars: 7 })
    const id = log.begin(INIT)
    log.recordText(id, 'data: 😀😀😀\n\n', { sse: true })
    expect(log.getEntry(id)?.events[0]?.raw).toBe('😀😀😀')
    log.recordText(id, 'data: ab😀😀😀\n\n', { sse: true })
    // 7 文字目が代用対の前半になるので 1 文字手前で切る
    expect(log.getEntry(id)?.events[1]?.raw).toBe('ab😀😀')
  })

  it('エントリ全体の raw の予算（maxBodyChars）を使い切ったら、以降のイベントは先頭の少しだけ残す', () => {
    const { log } = setup({ maxBodyChars: 1000, maxEventChars: 600 })
    const id = log.begin(INIT)
    const wire = Array.from({ length: 6 }, (_, i) =>
      big('text-delta', { id: 't', delta: 'x'.repeat(400) + i }),
    )
    log.recordText(id, wire.join(''), { sse: true })
    const events = log.getEntry(id)?.events ?? []
    expect(events).toHaveLength(6)
    // 1000 文字の予算に対し、最初の 2 件で使い切る
    expect(events[0]?.rawTruncated).toBeUndefined()
    const rawLengths = events.map((e) => e.raw.length)
    expect(rawLengths.slice(2).every((n) => n <= 200)).toBe(true)
    expect(events.slice(2).every((e) => e.rawTruncated === true)).toBe(true)
    // type は残るので診断は崩れない
    expect(events.every((e) => e.type === 'text-delta')).toBe(true)
  })

  it('非 SSE の text-chunk にも同じ上限を適用する', () => {
    const { log } = setup({ maxEventChars: 10 })
    const id = log.begin(INIT)
    log.recordText(id, 'x'.repeat(100), { sse: false })
    const event = log.getEntry(id)?.events[0]
    expect(event?.raw).toBe('x'.repeat(10))
    expect(event?.rawTruncated).toBe(true)
    expect(log.getEntry(id)?.rawBody).toHaveLength(100)
  })

  it('パーサーの上限を超えた巨大イベントは、JSON の判定を省略して parseSkipped にする（不正 JSON とは診断しない）', () => {
    const { log } = setup({ maxParseChars: 100 })
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    log.recordText(
      id,
      `data: {"type":"file","url":"${'A'.repeat(5000)}","mediaType":"image/png"}\n\n` +
        sse({ type: 'finish' }),
      { sse: true },
    )
    log.finish(id, { state: 'done' })
    const entry = log.getEntry(id)
    expect(entry?.events[0]).toMatchObject({
      kind: 'sse-text',
      parseSkipped: true,
      rawTruncated: true,
    })
    expect(entry?.events[0]?.raw.length).toBeLessThanOrEqual(100)
    // 後続のイベントは通常どおり解析される
    expect(entry?.events[1]?.type).toBe('finish')
    const ids = entry?.diagnostics.map((d) => d.id) ?? []
    expect(ids).toContain('sse-event-too-large')
    expect(ids).not.toContain('sse-invalid-json')
  })

  it('ストア全体の予算（maxTotalChars）を超えたら、古いエントリから捨てる', () => {
    const { log } = setup({ maxTotalChars: 1000 })
    const body = (n: number) => 'x'.repeat(n)
    const a = log.begin({ ...INIT, requestBody: body(400) })
    const b = log.begin({ ...INIT, requestBody: body(400) })
    expect(log.getEntries().map((e) => e.id)).toEqual([b, a])
    const c = log.begin({ ...INIT, requestBody: body(400) })
    // 1200 > 1000。最も古い a を捨てる（c は新しく書き込み中、選択は c）
    expect(log.getEntries().map((e) => e.id)).toEqual([c, b])
    expect(log.getEntry(a)).toBeUndefined()
  })

  it('書き込み中のエントリのレスポンスが増えたときも、古いエントリを捨てる', () => {
    const { log } = setup({ maxTotalChars: 1000 })
    const a = log.begin({ ...INIT, requestBody: 'x'.repeat(300) })
    const b = log.begin({ ...INIT, requestBody: 'x'.repeat(300) })
    expect(log.getEntries()).toHaveLength(2)
    log.recordText(b, 'y'.repeat(600), { sse: false })
    // b: 300 + 600(rawBody) + 600(text-chunk の raw) だけで予算を超える。a だけが捨てられ、b 自身は残る
    expect(log.getEntry(a)).toBeUndefined()
    expect(log.getEntry(b)).toBeDefined()
  })

  it('選択中のエントリと書き込み中のエントリは、予算を超えても捨てない', () => {
    const { log } = setup({ maxTotalChars: 1000 })
    const a = log.begin({ ...INIT, requestBody: 'x'.repeat(300) })
    const b = log.begin({ ...INIT, requestBody: 'x'.repeat(300) })
    // begin() は新しいエントリを自動で選択する。a を見ている状態にするため、c を作ったあとで選び直す
    const c = log.begin({ ...INIT, requestBody: 'x'.repeat(300) })
    log.select(a)
    // 900 文字は予算内なので、ここまでは何も捨てられていない
    expect(log.getEntries().map((e) => e.id)).toEqual([c, b, a])

    // c への書き込みで予算を超える（rawBody 200 + text-chunk の raw 200 で 1300 文字）。
    // c を書き込み中、a を選択中。どちらも残し、予算のために捨てられるのは b だけ
    log.recordText(c, 'z'.repeat(200), { sse: false })
    expect(log.getEntries().map((e) => e.id)).toEqual([c, a])
    expect(log.getEntry(b)).toBeUndefined()
    expect(log.getEntry(a)).toBeDefined()
    expect(log.getSelectedId()).toBe(a)
  })

  it('選択中のエントリを選び直して外すと、次の書き込みで予算のために捨てられる', () => {
    const { log } = setup({ maxTotalChars: 1000 })
    const a = log.begin({ ...INIT, requestBody: 'x'.repeat(300) })
    const b = log.begin({ ...INIT, requestBody: 'x'.repeat(300) })
    const c = log.begin({ ...INIT, requestBody: 'x'.repeat(300) })
    log.select(a)
    log.select(c)
    log.recordText(c, 'z'.repeat(200), { sse: false })
    // a は選択から外れたので、古い順に a が捨てられる（予算内に収まれば b は残る）
    expect(log.getEntries().map((e) => e.id)).toEqual([c, b])
    expect(log.getEntry(a)).toBeUndefined()
  })

  it('単独で予算を超えるエントリがあっても、それ自身は捨てない', () => {
    const { log } = setup({ maxTotalChars: 100 })
    const a = log.begin({ ...INIT, requestBody: 'x'.repeat(5000) })
    expect(log.getEntry(a)).toBeDefined()
    expect(log.getEntries()).toHaveLength(1)
  })

  it('clear() で予算の数え方もリセットされる（直後の記録が不当に捨てられない）', () => {
    const { log } = setup({ maxTotalChars: 1000 })
    log.begin({ ...INIT, requestBody: 'x'.repeat(900) })
    log.clear()
    const a = log.begin({ ...INIT, requestBody: 'x'.repeat(400) })
    const b = log.begin({ ...INIT, requestBody: 'x'.repeat(400) })
    expect(log.getEntries().map((e) => e.id)).toEqual([b, a])
  })

  it('maxEntries で捨てたエントリの分も予算から引く', () => {
    const { log } = setup({ maxEntries: 1, maxTotalChars: 1000 })
    log.begin({ ...INIT, requestBody: 'x'.repeat(900) })
    log.begin({ ...INIT, requestBody: 'x'.repeat(900) })
    const c = log.begin({ ...INIT, requestBody: 'x'.repeat(900) })
    // 捨てた分が残っていれば、c の時点で予算超過扱いになる。c 自身は常に残る
    expect(log.getEntries().map((e) => e.id)).toEqual([c])
    const d = log.begin({ ...INIT, requestBody: 'x' })
    expect(log.getEntries().map((e) => e.id)).toEqual([d])
  })
})

describe('リクエスト body の保持上限', () => {
  it('既定は 200,000 文字。超えたら先頭だけ残し、requestBodyTruncated を立てる', () => {
    const { log } = setup()
    const body = `{"a":"${'x'.repeat(300_000)}"}`
    const id = log.begin({ ...INIT, requestBody: body })
    const entry = log.getEntry(id)
    expect(entry?.requestBody).toHaveLength(200_000)
    expect(entry?.requestBody).toBe(body.slice(0, 200_000))
    expect(entry?.requestBodyTruncated).toBe(true)
  })

  it('上限ちょうど・以内なら全文のまま、requestBodyTruncated はキーごと無い', () => {
    const { log } = setup({ maxRequestBodyChars: 10 })
    const exact = log.getEntry(log.begin({ ...INIT, requestBody: 'x'.repeat(10) }))
    expect(exact?.requestBody).toBe('x'.repeat(10))
    expect(exact).not.toHaveProperty('requestBodyTruncated')
    const none = log.getEntry(log.begin({ ...INIT, requestBody: undefined }))
    expect(none).not.toHaveProperty('requestBody')
    expect(none).not.toHaveProperty('requestBodyTruncated')
    const empty = log.getEntry(log.begin({ ...INIT, requestBody: '' }))
    expect(empty?.requestBody).toBe('')
    expect(empty).not.toHaveProperty('requestBodyTruncated')
  })

  it('絵文字（代用対）の途中では切らない', () => {
    const { log } = setup({ maxRequestBodyChars: 5 })
    const id = log.begin({ ...INIT, requestBody: 'ab😀😀' })
    // 5 文字目は代用対の前半になるので、1 文字手前で切る
    expect(log.getEntry(id)?.requestBody).toBe('ab😀')
    expect(log.getEntry(id)?.requestBodyTruncated).toBe(true)
  })

  it('切り詰めたあとの文字数だけをメモリの予算に数える', () => {
    const { log } = setup({ maxRequestBodyChars: 100, maxTotalChars: 250 })
    const huge = 'x'.repeat(1_000_000)
    const a = log.begin({ ...INIT, requestBody: huge })
    const b = log.begin({ ...INIT, requestBody: huge })
    // 100 + 100 = 200 は予算内。元の長さで数えていれば、b の時点で a が捨てられる
    expect(log.getEntries().map((e) => e.id)).toEqual([b, a])
    const c = log.begin({ ...INIT, requestBody: huge })
    expect(log.getEntries().map((e) => e.id)).toEqual([c, b])
  })

  it('maxRequestBodyChars は 0 でも動く（body は空文字になる）', () => {
    const { log } = setup({ maxRequestBodyChars: 0 })
    const entry = log.getEntry(log.begin({ ...INIT, requestBody: 'abc' }))
    expect(entry?.requestBody).toBe('')
    expect(entry?.requestBodyTruncated).toBe(true)
  })
})

describe('指定されたがブラウザが送らないヘッダー', () => {
  it('droppedHeaders をエントリに残す（コピーを持つ）', () => {
    const { log } = setup()
    const dropped = ['cookie', 'origin']
    const id = log.begin({ ...INIT, droppedHeaders: dropped })
    expect(log.getEntry(id)?.droppedHeaders).toEqual(['cookie', 'origin'])
    expect(log.getEntry(id)?.droppedHeaders).not.toBe(dropped)
  })

  it('無ければキーごと省く', () => {
    const { log } = setup()
    expect(log.getEntry(log.begin(INIT))).not.toHaveProperty('droppedHeaders')
    expect(log.getEntry(log.begin({ ...INIT, droppedHeaders: [] }))).not.toHaveProperty(
      'droppedHeaders',
    )
  })

  it('診断に警告として出る', () => {
    const { log } = setup()
    const id = log.begin({ ...INIT, droppedHeaders: ['cookie'] })
    log.recordHead(id, HEAD)
    const d = log.getEntry(id)?.diagnostics.find((x) => x.id === 'request-headers-dropped')
    expect(d?.level).toBe('warn')
    expect(d?.title).toContain('cookie')
    expect(d?.detail).toContain('credentials')
  })
})

/** 検証は Promise なので、結果が反映されるまでマイクロタスクを回す。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('chunk のスキーマ検証（SDK の uiMessageChunkSchema）', () => {
  const BAD_DELTA = { type: 'text-delta', id: 't1', textDelta: 'hi' }
  const wireOf = (...chunks: Array<Record<string, unknown>>) => sse(...chunks) + 'data: [DONE]\n\n'

  it('SDK のスキーマに合わない chunk に schemaError が付き、診断が error になって summary が出ない', async () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    log.recordText(
      id,
      wireOf(
        { type: 'start' },
        { type: 'text-start', id: 't1' },
        BAD_DELTA,
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ),
      { sse: true },
    )
    await settle()
    log.finish(id, { state: 'done' })
    const entry = log.getEntry(id)
    expect(entry?.events[2]?.schemaError).toContain('delta')
    expect(entry?.events[0]).not.toHaveProperty('schemaError')
    const d = entry?.diagnostics.find((x) => x.id === 'ui-chunk-schema-invalid')
    expect(d?.level).toBe('error')
    expect(d?.detail).toContain('#2')
    expect(d?.detail).toContain('text-delta')
    expect(entry?.diagnostics.map((x) => x.id)).not.toContain('summary')
  })

  it('検証が finish() より遅れても、完了後に診断をやり直して反映し、通知する', async () => {
    const { log, listener } = setup()
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    // text-start / text-end で挟み、順序の問題が無い（問題はスキーマだけの）ストリームにする
    log.recordText(
      id,
      wireOf(
        { type: 'start' },
        { type: 'text-start', id: 't1' },
        BAD_DELTA,
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ),
      { sse: true },
    )
    // 検証の結果を待たずに完了させる（実際の通信ではあまり起きないが、順序が前後しても最終結果は同じになる）
    log.finish(id, { state: 'done' })
    expect(log.getEntry(id)?.diagnostics.map((x) => x.id)).toContain('summary')
    listener.mockClear()
    await settle()
    const entry = log.getEntry(id)
    expect(entry?.events[2]?.schemaError).toBeDefined()
    expect(entry?.diagnostics.map((x) => x.id)).toContain('ui-chunk-schema-invalid')
    expect(entry?.diagnostics.map((x) => x.id)).not.toContain('summary')
    expect(entry?.state).toBe('done')
    expect(listener).toHaveBeenCalled()
  })

  it('受信中に検証が終わっても、診断は finish() までやり直さない（イベントにだけ付く）', async () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    const before = log.getEntry(id)?.diagnostics
    log.recordText(id, sse(BAD_DELTA), { sse: true })
    await settle()
    expect(log.getEntry(id)?.events[0]?.schemaError).toBeDefined()
    expect(log.getEntry(id)?.diagnostics).toEqual(before)
  })

  it('正しい chunk（HELLO の一連）には schemaError が付かず、summary が出る', async () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    log.recordText(id, HELLO_WIRE, { sse: true })
    await settle()
    log.finish(id, { state: 'done' })
    const entry = log.getEntry(id)
    expect(entry?.events.some((e) => e.schemaError !== undefined)).toBe(false)
    expect(entry?.diagnostics.map((x) => x.id)).toContain('summary')
    expect(entry?.diagnostics.map((x) => x.id)).not.toContain('ui-chunk-schema-invalid')
  })

  it('エントリは新しい参照に差し替わり、古い参照は変化しない', async () => {
    const { log } = setup()
    const id = log.begin(INIT)
    log.recordText(id, sse(BAD_DELTA), { sse: true })
    const before = log.getEntry(id)
    await settle()
    const after = log.getEntry(id)
    expect(after).not.toBe(before)
    expect(before?.events[0]).not.toHaveProperty('schemaError')
    expect(log.getEntries()[0]).toBe(after)
  })

  it('completion（data プロトコル）も検証し、chat-text / raw は検証しない', async () => {
    const validateChunk = vi.fn(async () => 'x')
    for (const [mode, expected] of [
      ['completion', 1],
      ['chat-ui', 1],
      ['chat-text', 0],
      ['raw', 0],
    ] as const) {
      validateChunk.mockClear()
      const { log } = setup({ validateChunk })
      const id = log.begin({ ...INIT, mode })
      log.recordText(id, sse({ type: 'start' }), { sse: true })
      await settle()
      expect(validateChunk).toHaveBeenCalledTimes(expected)
    }
  })

  it('JSON でないイベント・[DONE]・空行で終わらない最後のイベントは検証しない', async () => {
    const validateChunk = vi.fn(async () => undefined)
    const { log } = setup({ validateChunk })
    const id = log.begin(INIT)
    log.recordText(id, 'data: not json\n\ndata: [DONE]\n\ndata: {"type":"finish"}', { sse: true })
    log.finish(id, { state: 'done' })
    await settle()
    expect(validateChunk).not.toHaveBeenCalled()
  })

  it('検証関数が失敗しても、その chunk は問題なしとして扱う（ストアも落ちない）', async () => {
    const validateChunk = vi.fn(async () => {
      throw new Error('検証できない')
    })
    const { log } = setup({ validateChunk })
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    log.recordText(id, HELLO_WIRE, { sse: true })
    log.finish(id, { state: 'done' })
    await settle()
    expect(log.getEntry(id)?.events.some((e) => e.schemaError !== undefined)).toBe(false)
    expect(log.getEntry(id)?.diagnostics.map((x) => x.id)).toContain('summary')
  })

  it('検証の結果が返る前に clear() された場合は、何も反映せず落ちない', async () => {
    const { log, listener } = setup()
    const id = log.begin(INIT)
    log.recordText(id, sse(BAD_DELTA), { sse: true })
    log.clear()
    listener.mockClear()
    await settle()
    expect(log.getEntry(id)).toBeUndefined()
    expect(log.getEntries()).toEqual([])
    expect(listener).not.toHaveBeenCalled()
  })

  it('maxEvents を超えて捨てたイベントは検証しない', async () => {
    const validateChunk = vi.fn(async () => undefined)
    const { log } = setup({ maxEvents: 1, validateChunk })
    const id = log.begin(INIT)
    log.recordText(id, sse({ type: 'start' }, { type: 'start-step' }, { type: 'finish' }), {
      sse: true,
    })
    await settle()
    expect(validateChunk).toHaveBeenCalledTimes(1)
  })
})

describe('既定値', () => {
  it('既定の時計（performance.now）で ttfb / total が数値になる', () => {
    const log = createNetworkLog()
    const id = log.begin(INIT)
    log.recordHead(id, HEAD)
    log.finish(id, { state: 'done' })
    const entry = log.getEntry(id)
    expect(entry?.ttfbMs).toBeGreaterThanOrEqual(0)
    expect(entry?.totalMs).toBeGreaterThanOrEqual(entry?.ttfbMs ?? 0)
  })

  it('シングルトンの networkLog が使える（メソッドは this に依存しない）', () => {
    networkLog.clear()
    const { begin, getEntries, clear } = networkLog
    const id = begin(INIT)
    expect(getEntries().map((e) => e.id)).toEqual([id])
    clear()
    expect(getEntries()).toEqual([])
  })
})
