/**
 * インスペクタのテスト専用の部品。製品コードからは import しない。
 * 偽の NetworkLogEntry と、shiki を使わない CodeBlock の代役を提供する。
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { createNetworkLog } from '@/lib/network-log'
import type { Diagnostic, NetworkLogEntry, StreamEvent } from '@/types'

/** 完了済みの POST /chat を表す、最小限の NetworkLogEntry。 */
export function makeEntry(overrides: Partial<NetworkLogEntry> = {}): NetworkLogEntry {
  return {
    id: 'req-1',
    mode: 'chat-ui',
    startedAt: new Date(2026, 0, 2, 3, 4, 5, 6).getTime(),
    method: 'POST',
    targetUrl: 'https://api.example.com/api/chat',
    viaProxy: false,
    requestHeaders: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-live-abcdef1234567890',
    },
    requestBody: '{"messages":[{"role":"user","content":"hi"}]}',
    state: 'done',
    status: 200,
    statusText: 'OK',
    responseHeaders: {
      'content-type': 'text/event-stream',
      'x-vercel-ai-ui-message-stream': 'v1',
      'cache-control': 'no-cache',
    },
    ttfbMs: 120,
    totalMs: 1500,
    events: [],
    eventsTruncated: false,
    rawBody: '',
    rawBodyTruncated: false,
    bytesReceived: 2048,
    diagnostics: [],
    ...overrides,
  }
}

export function diagnostic(
  id: string,
  level: Diagnostic['level'],
  title = id,
  detail?: string,
): Diagnostic {
  return detail === undefined ? { id, level, title } : { id, level, title, detail }
}

/** type 付きの SSE JSON イベント。 */
export function jsonEvent(
  index: number,
  data: Record<string, unknown>,
  extra: Partial<StreamEvent> = {},
): StreamEvent {
  return {
    index,
    atMs: index * 5,
    kind: 'sse-json',
    data,
    raw: JSON.stringify(data),
    ...(typeof data.type === 'string' ? { type: data.type } : {}),
    ...extra,
  }
}

/** start / text-start / text-delta × (count - 4) / text-end / finish の SSE イベント列。 */
export function makeTextStreamEvents(count: number): StreamEvent[] {
  const events: StreamEvent[] = [
    jsonEvent(0, { type: 'start' }),
    jsonEvent(1, { type: 'text-start', id: 't1' }),
  ]
  for (let i = 2; i < count - 2; i++) {
    events.push(jsonEvent(i, { type: 'text-delta', id: 't1', delta: `chunk-${i} ` }))
  }
  events.push(jsonEvent(events.length, { type: 'text-end', id: 't1' }))
  events.push(jsonEvent(events.length, { type: 'finish' }))
  return events
}

/**
 * 本物のネットワークログ（createNetworkLog）で記録した完了済みエントリ。
 * 診断（summary など）まで本物と同じものが入る。
 */
export function recordSseEntry(
  opts: { events?: number; headers?: Record<string, string>; status?: number } = {},
): NetworkLogEntry {
  let clock = 0
  const log = createNetworkLog({
    now: () => (clock += 10),
    schedule: (callback) => {
      callback()
      return () => {}
    },
    pageOrigin: () => 'http://localhost:5199',
    maxEvents: 10_000,
  })
  const id = log.begin({
    mode: 'chat-ui',
    method: 'POST',
    targetUrl: 'https://api.example.com/api/chat',
    viaProxy: false,
    requestHeaders: opts.headers ?? { Authorization: 'Bearer sk-live-abcdef1234567890' },
    requestBody: '{"messages":[]}',
  })
  log.recordHead(id, {
    status: opts.status ?? 200,
    statusText: 'OK',
    responseHeaders: {
      'Content-Type': 'text/event-stream',
      'x-vercel-ai-ui-message-stream': 'v1',
    },
  })
  const count = opts.events ?? 6
  const lines = makeTextStreamEvents(count).map((event) => `data: ${event.raw}\n\n`)
  log.recordText(id, lines.join('') + 'data: [DONE]\n\n', { sse: true })
  log.finish(id, { state: 'done' })
  const entry = log.getEntry(id)
  if (entry === undefined) throw new Error('エントリを記録できませんでした')
  return entry
}

interface CodeBlockMockProps {
  code: string
  language: string
  children?: ReactNode
}

/**
 * ai-elements/code-block の差し替え。shiki を読み込まず、整形後のテキストをそのまま pre に出す。
 * vi.mock('@/components/ai-elements/code-block', async (importOriginal) =>
 *   (await import('@/components/inspector/test-fixtures')).mockCodeBlock(await importOriginal()))
 */
export function mockCodeBlock<T extends object>(actual: T): T {
  return {
    ...actual,
    CodeBlock: ({ code, language, children }: CodeBlockMockProps) =>
      createElement(
        'div',
        { 'data-testid': 'code-block', 'data-language': language },
        children,
        createElement('pre', null, code),
      ),
  }
}
