import { describe, expect, it } from 'vitest'
import {
  buildEntryExport,
  exportFileName,
  formatFileStamp,
  MASKING_NOTE,
  serializeEntryExport,
} from '@/components/inspector/export-utils'
import type { NetworkLogEntry } from '@/types'

function makeEntry(overrides: Partial<NetworkLogEntry> = {}): NetworkLogEntry {
  return {
    id: 'req-1',
    mode: 'chat-ui',
    startedAt: new Date(2026, 0, 2, 3, 4, 5, 6).getTime(),
    method: 'POST',
    targetUrl: 'https://api.example.com/chat',
    viaProxy: false,
    requestHeaders: {
      Authorization: 'Bearer sk-very-secret-value-9999',
      'Content-Type': 'application/json',
    },
    requestBody: '{"messages":[]}',
    state: 'done',
    status: 200,
    statusText: 'OK',
    responseHeaders: { 'set-cookie': 'session=abcdef123456', 'content-type': 'text/event-stream' },
    events: [],
    eventsTruncated: false,
    rawBody: '',
    rawBodyTruncated: false,
    bytesReceived: 0,
    diagnostics: [],
    ...overrides,
  }
}

describe('buildEntryExport', () => {
  it('秘匿情報を表示しない設定ではリクエスト・レスポンスのヘッダーをマスクする', () => {
    const payload = buildEntryExport(makeEntry(), { revealSecrets: false, now: 0 })
    expect(payload.secretsMasked).toBe(true)
    expect(payload.entry.requestHeaders.Authorization).not.toContain('secret')
    expect(payload.entry.requestHeaders['Content-Type']).toBe('application/json')
    expect(payload.entry.responseHeaders?.['set-cookie']).not.toContain('abcdef123456'.slice(0, 6))
    expect(JSON.stringify(payload)).not.toContain('sk-very-secret-value')
  })

  it('表示する設定ではそのまま出す', () => {
    const payload = buildEntryExport(makeEntry(), { revealSecrets: true, now: 0 })
    expect(payload.secretsMasked).toBe(false)
    expect(payload.entry.requestHeaders.Authorization).toBe('Bearer sk-very-secret-value-9999')
    expect(payload.entry.responseHeaders?.['set-cookie']).toBe('session=abcdef123456')
  })

  it('レスポンスヘッダーは狭い規則で、隠すのは秘密を運ぶ名前だけ（CORS 診断のヘッダーは残す）', () => {
    const payload = buildEntryExport(
      makeEntry({
        responseHeaders: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': 'https://app.example.com',
          'www-authenticate': 'Bearer realm="api"',
          'x-ratelimit-remaining-tokens': '99000',
          'set-cookie': 'session=abcdef1234567890abcdef',
          'x-api-key': 'sk-echoed-key-0123456789',
        },
      }),
      { revealSecrets: false, now: 0 },
    )
    expect(payload.entry.responseHeaders).toEqual({
      'access-control-allow-credentials': 'true',
      'access-control-allow-origin': 'https://app.example.com',
      'www-authenticate': 'Bearer realm="api"',
      'x-ratelimit-remaining-tokens': '99000',
      'set-cookie': '••••cdef',
      'x-api-key': '••••6789',
    })
  })

  it('リクエストヘッダーは広い規則のまま（名前が自由な認証ヘッダーも隠す）', () => {
    const payload = buildEntryExport(
      makeEntry({
        requestHeaders: {
          'x-vercel-protection-bypass': 'bypass-abcdef1234567890xyz',
          'x-custom-token': 'tok-0123456789',
          'content-type': 'application/json',
        },
      }),
      { revealSecrets: false, now: 0 },
    )
    expect(payload.entry.requestHeaders).toEqual({
      'x-vercel-protection-bypass': '••••0xyz',
      'x-custom-token': '••••',
      'content-type': 'application/json',
    })
  })

  it('レスポンスヘッダーにエコーされたリクエストの秘匿値は、名前によらず伏せる', () => {
    const payload = buildEntryExport(
      makeEntry({ responseHeaders: { 'x-echo': 'Bearer sk-very-secret-value-9999' } }),
      { revealSecrets: false, now: 0 },
    )
    expect(JSON.stringify(payload)).not.toContain('sk-very-secret-value')
    expect(payload.entry.responseHeaders?.['x-echo']).toBe('Bearer ••••9999')
  })

  it('元のエントリを書き換えない', () => {
    const entry = makeEntry()
    buildEntryExport(entry, { revealSecrets: false })
    expect(entry.requestHeaders.Authorization).toBe('Bearer sk-very-secret-value-9999')
  })

  it('requestBodyTruncated と droppedHeaders は、マスクの有無にかかわらず JSON に残る', () => {
    const entry = makeEntry({
      requestBody: '{"messages":[],"apiKey":"sk-body-secret-0000000',
      requestBodyTruncated: true,
      droppedHeaders: ['cookie', 'origin'],
    })
    for (const revealSecrets of [false, true]) {
      const parsed: unknown = JSON.parse(serializeEntryExport(entry, { revealSecrets, now: 0 }))
      expect(parsed).toMatchObject({
        entry: { requestBodyTruncated: true, droppedHeaders: ['cookie', 'origin'] },
      })
    }
  })

  it('切り詰められて途中で終わった本文でも、秘匿キーの値を残さない', () => {
    const text = serializeEntryExport(
      makeEntry({
        requestBody: '{"messages":[],"apiKey":"sk-body-secret-0000000',
        requestBodyTruncated: true,
      }),
      { revealSecrets: false, now: 0 },
    )
    expect(text).not.toContain('sk-body-secret-0000000')
  })

  it('切り詰めていないエントリには requestBodyTruncated を足さない', () => {
    const payload = buildEntryExport(makeEntry(), { revealSecrets: false, now: 0 })
    expect('requestBodyTruncated' in payload.entry).toBe(false)
    expect('droppedHeaders' in payload.entry).toBe(false)
  })

  it('レスポンスヘッダーが無いエントリでは responseHeaders を付けない', () => {
    const entry = makeEntry()
    delete entry.responseHeaders
    const payload = buildEntryExport(entry, { revealSecrets: false })
    expect('responseHeaders' in payload.entry).toBe(false)
  })

  it('exportedAt は ISO 形式', () => {
    const payload = buildEntryExport(makeEntry(), { revealSecrets: false, now: 0 })
    expect(payload.exportedAt).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('buildEntryExport のマスク範囲（ヘッダー以外）', () => {
  const TOKEN = 'sk-very-secret-value-9999'
  const URL_KEY = 'sk-live-SECRETSECRET'
  const GOOGLE_KEY = 'AIzaSECRETSECRETSECRET'
  const BODY_KEY = 'sk-body-secret-0000000'
  const ALL_SECRETS = [TOKEN, URL_KEY, GOOGLE_KEY, BODY_KEY]

  function leakyEntry(): NetworkLogEntry {
    const data = { type: 'text-delta', delta: `your token is ${TOKEN}`, apiKey: BODY_KEY }
    return makeEntry({
      targetUrl: `https://api.example.com/v1/chat?api_key=${URL_KEY}&key=${GOOGLE_KEY}&max_tokens=10`,
      requestBody: `{"apiKey":"${BODY_KEY}","messages":[{"role":"user","content":"hi"}]}`,
      rawBody: [
        `data: ${JSON.stringify(data)}`,
        '',
        `data: {"type":"text-delta","delta":"echo ${URL_KEY}"}`,
        '',
      ].join('\n'),
      events: [
        {
          index: 0,
          atMs: 1,
          kind: 'sse-json',
          type: 'text-delta',
          data,
          raw: JSON.stringify(data),
          parseError: `bad ${GOOGLE_KEY}`,
        },
        { index: 1, atMs: 2, kind: 'text-chunk', raw: `plain ${BODY_KEY}` },
      ],
      error: {
        name: 'TypeError',
        message: `Failed to fetch https://api.example.com/v1/chat?key=${GOOGLE_KEY}`,
        hint: `token ${TOKEN}`,
      },
      diagnostics: [
        { id: 'x', level: 'warn', title: `title ${TOKEN}`, detail: `detail ${URL_KEY}` },
      ],
    })
  }

  it('URL のクエリ・リクエスト本文・レスポンス本文・イベント・エラー・診断に秘密を残さない', () => {
    const text = serializeEntryExport(leakyEntry(), { revealSecrets: false, now: 0 })
    for (const secret of ALL_SECRETS) expect(text).not.toContain(secret)
    // 秘密でない部分は残る
    const { entry } = buildEntryExport(leakyEntry(), { revealSecrets: false, now: 0 })
    expect(entry.targetUrl).toContain('max_tokens=10')
    expect(entry.requestBody).toContain('"messages":[{"role":"user","content":"hi"}]')
    expect(entry.events[0]?.type).toBe('text-delta')
    expect(entry.events[0]?.raw).toContain('your token is ')
    expect(entry.status).toBe(200)
  })

  it('マスクした保存では、範囲と限界を maskingNote に書く', () => {
    const payload = buildEntryExport(leakyEntry(), { revealSecrets: false, now: 0 })
    expect(payload.secretsMasked).toBe(true)
    expect(payload.maskingNote).toBe(MASKING_NOTE)
    expect(MASKING_NOTE).toContain('URL')
    expect(MASKING_NOTE).toContain('共有前に内容を確認')
  })

  it('表示する設定では何も加工せず、maskingNote も付けない', () => {
    const entry = leakyEntry()
    const payload = buildEntryExport(entry, { revealSecrets: true, now: 0 })
    expect(payload.secretsMasked).toBe(false)
    expect('maskingNote' in payload).toBe(false)
    expect(payload.entry).toEqual(entry)
    expect(serializeEntryExport(entry, { revealSecrets: true })).toContain(URL_KEY)
  })

  it('元のエントリ（イベントの data を含む）を書き換えない', () => {
    const entry = leakyEntry()
    const before = structuredClone(entry)
    buildEntryExport(entry, { revealSecrets: false })
    expect(entry).toEqual(before)
  })

  it('本文・イベントなどを持たないエントリでも落ちない', () => {
    const entry = makeEntry({ requestBody: undefined })
    delete entry.requestBody
    const payload = buildEntryExport(entry, { revealSecrets: false })
    expect('requestBody' in payload.entry).toBe(false)
    expect('error' in payload.entry).toBe(false)
  })
})

describe('serializeEntryExport', () => {
  it('整形した JSON 文字列を返し、parse して戻せる', () => {
    const text = serializeEntryExport(makeEntry(), { revealSecrets: false, now: 0 })
    expect(text).toContain('\n  "entry"')
    const parsed: unknown = JSON.parse(text)
    expect(parsed).toMatchObject({ entry: { id: 'req-1', method: 'POST' } })
  })
})

describe('formatFileStamp / exportFileName', () => {
  it('ローカル時刻の YYYYMMDD-HHMMSS にする', () => {
    expect(formatFileStamp(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('20260102-030405')
  })

  it('不正な時刻は unknown', () => {
    expect(formatFileStamp(Number.NaN)).toBe('unknown')
  })

  it('ファイル名は id と開始時刻から作り、使えない文字は潰す', () => {
    const startedAt = new Date(2026, 0, 2, 3, 4, 5).getTime()
    expect(exportFileName({ id: 'req-12', startedAt })).toBe(
      'ai-sdk-log_req-12_20260102-030405.json',
    )
    expect(exportFileName({ id: 'a/b c', startedAt })).toBe('ai-sdk-log_a_b_c_20260102-030405.json')
  })
})
