import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  DefaultChatTransport,
  TextStreamChatTransport,
  UI_MESSAGE_STREAM_HEADERS,
  callCompletionApi,
  isFileUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockServer, type MockLogEntry, type MockServerOptions } from './app.ts'
import { CHAT_SCENARIOS, SIMPLE_SCENARIOS } from './scenarios.ts'

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

interface Started {
  url: string
  logs: MockLogEntry[]
  close: () => Promise<void>
}

async function startServer(options: MockServerOptions = {}): Promise<Started> {
  const logs: MockLogEntry[] = []
  const server: Server = createMockServer({
    delayScale: 0,
    ...options,
    onLog: (entry) => logs.push(entry),
  })
  // localhost は ::1 に解決され得るので 127.0.0.1 に固定し、ポートは OS に割り当てさせる
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    logs,
    close: () => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function userMessage(text: string, id = 'user-1'): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

async function readChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return chunks
    chunks.push(value)
  }
}

function streamOf(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

/** チャンク列を ai のクライアント側パーサーに通し、最終的な UIMessage を得る。処理エラーは throw する。 */
async function toMessage(chunks: UIMessageChunk[], previous?: UIMessage): Promise<UIMessage> {
  let last: UIMessage | undefined
  for await (const message of readUIMessageStream({
    stream: streamOf(chunks),
    message: previous,
    terminateOnError: true,
  })) {
    last = message
  }
  if (last === undefined) throw new Error('メッセージが 1 件も得られませんでした')
  return last
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join('')
}

function messageParts<T extends UIMessage['parts'][number]['type']>(message: UIMessage, type: T) {
  return message.parts.filter((part) => part.type === type)
}

describe('モックバックエンド', () => {
  let mock: Started
  let noCors: Started

  beforeAll(async () => {
    mock = await startServer()
    noCors = await startServer({ cors: false })
  })

  afterAll(async () => {
    await Promise.all([mock.close(), noCors.close()])
  })

  /** useChat と同じ経路（DefaultChatTransport）で /api/chat にリクエストし、チャンク列を得る。 */
  async function chatChunks(
    options: {
      text?: string
      messages?: UIMessage[]
      path?: string
      headers?: Record<string, string>
      body?: Record<string, unknown>
      server?: Started
    } = {},
  ): Promise<UIMessageChunk[]> {
    const transport = new DefaultChatTransport({
      api: `${(options.server ?? mock).url}${options.path ?? '/api/chat'}`,
      headers: options.headers,
    })
    const stream = await transport.sendMessages({
      chatId: 'chat-1',
      messages: options.messages ?? [userMessage(options.text ?? 'こんにちは')],
      trigger: 'submit-message',
      messageId: undefined,
      abortSignal: undefined,
      body: options.body,
    })
    return readChunks(stream)
  }

  async function chatMessage(
    scenario: string,
    options: Parameters<typeof chatChunks>[0] = {},
  ): Promise<{ chunks: UIMessageChunk[]; message: UIMessage }> {
    const chunks = await chatChunks({ ...options, body: { scenario, ...options.body } })
    return { chunks, message: await toMessage(chunks) }
  }

  const postJson = (path: string, body: unknown, init: RequestInit = {}) =>
    fetch(`${mock.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(body),
      ...init,
    })

  // -------------------------------------------------------------------------
  describe('基本エンドポイント', () => {
    it('GET /health', async () => {
      const res = await fetch(`${mock.url}/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    })

    it('GET /api/scenarios は全シナリオを説明つきで返す', async () => {
      const res = await fetch(`${mock.url}/api/scenarios`)
      expect(res.status).toBe(200)
      const json = (await res.json()) as Record<string, { name: string; description: string }[]>
      expect(json.chat?.map((s) => s.name)).toEqual(CHAT_SCENARIOS.map((s) => s.name))
      expect(json.text?.map((s) => s.name)).toEqual(SIMPLE_SCENARIOS.map((s) => s.name))
      expect(json.completion?.map((s) => s.name)).toEqual(SIMPLE_SCENARIOS.map((s) => s.name))
      for (const scenario of [...(json.chat ?? []), ...(json.text ?? [])]) {
        expect(scenario.description, scenario.name).not.toBe('')
      }
      // 仕様で挙げられたシナリオは全部ある
      expect(json.chat?.map((s) => s.name)).toEqual(
        expect.arrayContaining([
          'text',
          'markdown',
          'reasoning',
          'tool',
          'tool-error',
          'client-tool',
          'approval',
          'sources',
          'file',
          'data',
          'metadata',
          'echo',
          'slow',
          'error',
          'abort',
          'no-header',
          'bad-json',
          'no-done',
          'http-500',
          'http-401',
          'auth',
        ]),
      )
    })

    it('未知のパスは 404 の JSON', async () => {
      const res = await fetch(`${mock.url}/nope`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toBe('not_found')
    })

    it('許可されないメソッドは 405', async () => {
      const res = await fetch(`${mock.url}/api/chat`)
      expect(res.status).toBe(405)
    })

    it('未知のシナリオ名は 400 でエラーを返す', async () => {
      const res = await postJson('/api/chat', { scenario: 'does-not-exist', messages: [] })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('unknown_scenario')
    })

    it('GET /api/chat/:id/stream（resume）は 204', async () => {
      const res = await fetch(`${mock.url}/api/chat/abc/stream`)
      expect(res.status).toBe(204)
    })
  })

  // -------------------------------------------------------------------------
  describe('シナリオの選択', () => {
    const scenarioOf = (res: Response) => res.headers.get('x-mock-scenario')

    it('既定は text', async () => {
      expect(scenarioOf(await postJson('/api/chat', { messages: [userMessage('hi')] }))).toBe(
        'text',
      )
    })

    it('優先順は body.scenario → ?scenario= → 本文先頭の #名前', async () => {
      const messages = [userMessage('#tool 天気')]
      expect(
        scenarioOf(await postJson('/api/chat?scenario=slow', { scenario: 'echo', messages })),
      ).toBe('echo')
      expect(scenarioOf(await postJson('/api/chat?scenario=slow', { messages }))).toBe('slow')
      expect(scenarioOf(await postJson('/api/chat', { messages }))).toBe('tool')
    })

    it('#名前 は本文から取り除いて扱う', async () => {
      const message = await toMessage(
        await chatChunks({ messages: [userMessage('#text こんにちは世界')] }),
      )
      expect(textOf(message)).toContain('「こんにちは世界」')
      expect(textOf(message)).not.toContain('#text')
    })

    it('未知の #トークンは普通の文字として扱う（#hashtag を送れる）', async () => {
      const res = await postJson('/api/chat', { messages: [userMessage('#nope こんにちは')] })
      expect(scenarioOf(res)).toBe('text')
      await res.body?.cancel()

      const message = await toMessage(
        await chatChunks({ messages: [userMessage('#nope こんにちは')] }),
      )
      expect(textOf(message)).toContain('「#nope こんにちは」')
    })
  })

  // -------------------------------------------------------------------------
  describe('UI Message Stream（ai のクライアント実装で検証）', () => {
    it('SSE のヘッダーは ai の UI_MESSAGE_STREAM_HEADERS と一致する', async () => {
      const res = await postJson('/api/chat', { messages: [userMessage('hi')] })
      for (const [name, value] of Object.entries(UI_MESSAGE_STREAM_HEADERS)) {
        expect(res.headers.get(name), name).toBe(value)
      }
      await res.body?.cancel()
    })

    it('ワイヤー形式は data: {JSON} の行と末尾の data: [DONE]', async () => {
      const text = await (await postJson('/api/chat', { messages: [userMessage('hi')] })).text()
      const events = text.split('\n\n').filter((e) => e !== '')
      expect(events.length).toBeGreaterThan(5)
      for (const event of events) expect(event.startsWith('data: ')).toBe(true)
      expect(events.at(-1)).toBe('data: [DONE]')
      for (const event of events.slice(0, -1)) {
        expect(() => JSON.parse(event.slice('data: '.length)), event).not.toThrow()
      }
      expect(text.endsWith('\n\n')).toBe(true)
    })

    it.each([
      'text',
      'markdown',
      'reasoning',
      'tool',
      'tool-error',
      'sources',
      'file',
      'data',
      'metadata',
      'echo',
      'slow',
      'keepalive',
      'no-header',
      'no-done',
    ])('%s は start で始まり finish で終わり、パーサーでエラーなく処理できる', async (scenario) => {
      const { chunks, message } = await chatMessage(scenario)
      expect(chunks.at(0)?.type).toBe('start')
      expect(chunks.at(-1)?.type).toBe('finish')
      expect(chunks.some((c) => c.type === 'error')).toBe(false)
      expect(message.role).toBe('assistant')
      expect(message.parts.length).toBeGreaterThan(0)
    })

    it('text: 日本語 / 英語が単語ごとに流れ、受信した本文を含む', async () => {
      const { chunks, message } = await chatMessage('text', { text: 'テスト入力' })
      expect(chunks.filter((c) => c.type === 'text-delta').length).toBeGreaterThan(10)
      const text = textOf(message)
      expect(text).toContain('こんにちは')
      expect(text).toContain('テスト入力')
      expect(text).toContain('word by word')
      expect(message.parts.filter(isTextUIPart).every((p) => p.state === 'done')).toBe(true)
    })

    it('markdown: 見出し・リスト・コードブロック・表を含む', async () => {
      const text = textOf((await chatMessage('markdown')).message)
      expect(text).toMatch(/^# /m)
      expect(text).toMatch(/^- /m)
      expect(text).toMatch(/^1\. /m)
      expect(text).toContain('```ts')
      expect(text).toContain('| シナリオ | 用途 | 特徴 |')
      expect(text).toContain('| --- | --- | --- |')
    })

    it('reasoning: reasoning パートの後に本文が来る', async () => {
      const { message } = await chatMessage('reasoning')
      const types = message.parts.map((p) => p.type)
      const reasoningIndex = types.indexOf('reasoning')
      const textIndex = types.indexOf('text')
      expect(reasoningIndex).toBeGreaterThanOrEqual(0)
      expect(textIndex).toBeGreaterThan(reasoningIndex)
      const reasoning = message.parts.filter(isReasoningUIPart)[0]
      expect(reasoning?.state).toBe('done')
      expect(reasoning?.text.length).toBeGreaterThan(10)
    })

    it('tool: getWeather が 2 ステップ構成で実行される', async () => {
      const { chunks, message } = await chatMessage('tool')
      expect(chunks.map((c) => c.type)).toEqual(
        expect.arrayContaining([
          'tool-input-start',
          'tool-input-delta',
          'tool-input-available',
          'tool-output-available',
        ]),
      )
      expect(chunks.filter((c) => c.type === 'start-step')).toHaveLength(2)
      const tool = message.parts.filter(isToolUIPart)[0]
      expect(tool?.type).toBe('tool-getWeather')
      expect(tool?.state).toBe('output-available')
      expect(tool?.input).toEqual({ city: 'Tokyo' })
      expect(tool?.output).toMatchObject({ city: 'Tokyo', temperatureC: 22 })
      // tool-input-delta をつなげると入力 JSON になる
      const streamed = chunks
        .flatMap((c) => (c.type === 'tool-input-delta' ? [c.inputTextDelta] : []))
        .join('')
      expect(JSON.parse(streamed)).toEqual({ city: 'Tokyo' })
      expect(textOf(message)).toContain('晴れ')
      expect(messageParts(message, 'step-start')).toHaveLength(2)
    })

    it('tool-error: tool-output-error でツールが失敗状態になり、本文は続く', async () => {
      const { message } = await chatMessage('tool-error')
      const tool = message.parts.filter(isToolUIPart)[0]
      expect(tool?.state).toBe('output-error')
      expect(tool?.errorText).toContain('タイムアウト')
      expect(textOf(message)).not.toBe('')
    })

    it('sources: source-url と source-document を含む', async () => {
      const { message } = await chatMessage('sources')
      expect(messageParts(message, 'source-url')).toHaveLength(2)
      expect(messageParts(message, 'source-document')).toHaveLength(1)
    })

    it('file: data URL の PNG 画像を返す', async () => {
      const { message } = await chatMessage('file')
      const file = message.parts.filter(isFileUIPart)[0]
      expect(file?.mediaType).toBe('image/png')
      expect(file?.url.startsWith('data:image/png;base64,')).toBe(true)
      const png = Buffer.from(file?.url.slice('data:image/png;base64,'.length) ?? '', 'base64')
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
      expect(png.readUInt32BE(16)).toBe(96) // IHDR の幅
      expect(png.readUInt32BE(20)).toBe(64) // IHDR の高さ
      expect(png.length).toBeLessThan(20_000)
    })

    it('data: data-* は同じ id で更新され、transient はメッセージに残らない', async () => {
      const { chunks, message } = await chatMessage('data')
      const weather = message.parts.filter((p) => p.type === 'data-weather')
      expect(weather).toHaveLength(1)
      expect(weather[0]).toMatchObject({
        id: 'weather-1',
        data: { status: 'done', temperatureC: 22 },
      })
      expect(chunks.some((c) => c.type === 'data-notification' && c.transient === true)).toBe(true)
      expect(message.parts.some((p) => p.type === 'data-notification')).toBe(false)
    })

    it('metadata: start / finish の messageMetadata がマージされる', async () => {
      const { message } = await chatMessage('metadata')
      expect(message.metadata).toMatchObject({
        model: 'mock-model',
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
      })
    })

    it('echo: メソッド・追加ヘッダー・Bearer・extraBody・最後のみ送信が届いたことを確認できる', async () => {
      const { message } = await chatMessage('echo', {
        messages: [userMessage('最後のメッセージだけ')],
        headers: { 'x-custom-header': 'custom-value', authorization: 'Bearer my-secret' },
        body: { sessionId: 'session-42', nested: { a: 1 } },
      })
      const text = textOf(message)
      expect(text).toContain('**メソッド**: POST')
      expect(text).toContain('/api/chat')
      expect(text).toContain('"x-custom-header": "custom-value"')
      expect(text).toContain('"authorization": "Bearer my-secret"')
      expect(text).toContain('"content-type": "application/json"')
      expect(text).toContain('**messages**: 1 件')
      expect(text).toContain('**trigger**: submit-message')
      expect(text).toContain('sessionId')
      expect(text).toContain('"sessionId": "session-42"')
      expect(text).toContain('最後のメッセージだけ')
      // 接続単位のヘッダーは出さない
      expect(text).not.toContain('"connection"')
    })

    it('slow: 約 400ms/トークンで 20 トークン流す', () => {
      const plan = CHAT_SCENARIOS.find((s) => s.name === 'slow')?.build({
        method: 'POST',
        path: '/api/chat',
        url: '/api/chat',
        query: new URLSearchParams(),
        headers: {},
        rawBody: '',
        body: undefined,
        messages: [],
        userText: '',
      })
      expect(plan?.format).toBe('sse')
      const deltas =
        plan?.format === 'sse'
          ? plan.steps.filter((s) => 'chunk' in s && s.chunk.type === 'text-delta')
          : []
      expect(deltas).toHaveLength(20)
      expect(deltas.every((s) => s.delayMs === 400)).toBe(true)
    })

    it('keepalive: SSE コメント行が混ざり、クライアントは無視して処理できる', async () => {
      const text = await (
        await postJson('/api/chat', { scenario: 'keepalive', messages: [] })
      ).text()
      expect(text).toContain(': ping\n\n')
    })

    it('ストリームは逐次届く（全チャンクを書き終える前に最初のチャンクが届く）', async () => {
      const slowMock = await startServer({ delayScale: 1 })
      try {
        const startedAt = Date.now()
        const res = await fetch(`${slowMock.url}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scenario: 'text', messages: [] }),
        })
        const reader = res.body?.getReader()
        await reader?.read()
        const firstAt = Date.now() - startedAt
        while (!(await reader?.read())?.done) {
          // 最後まで読む
        }
        const endAt = Date.now() - startedAt
        expect(endAt - firstAt).toBeGreaterThan(300)
      } finally {
        await slowMock.close()
      }
    })

    it('slow: クライアントが切断したらサーバーは残りを流さず止まる', async () => {
      const slowMock = await startServer({ delayScale: 1 })
      try {
        const controller = new AbortController()
        const startedAt = Date.now()
        const res = await fetch(`${slowMock.url}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scenario: 'slow', messages: [] }),
          signal: controller.signal,
        })
        await res.body?.getReader().read()
        controller.abort()

        // 全部流すと 8 秒かかる。切断を検知して早期に終わる
        await vi.waitFor(() => expect(slowMock.logs).toHaveLength(1), { timeout: 2000 })
        expect(slowMock.logs[0]).toMatchObject({ scenario: 'slow', outcome: 'client-closed' })
        expect(Date.now() - startedAt).toBeLessThan(2500)
      } finally {
        await slowMock.close()
      }
    })
  })

  // -------------------------------------------------------------------------
  describe('継続リクエスト（クライアントツール / 承認）', () => {
    /** 1 回目のストリームを処理して assistant メッセージを得る。 */
    async function firstTurn(scenario: string) {
      const user = userMessage(`#${scenario}`)
      const { chunks, message } = await chatMessage(scenario, { messages: [user] })
      return { user, chunks, assistant: message }
    }

    it('client-tool: 入力だけで終了し、出力つきで再送すると同じメッセージに最終テキストが続く', async () => {
      const { user, chunks, assistant } = await firstTurn('client-tool')
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'tool-calls' })
      expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(false)
      const tool = assistant.parts.filter(isToolUIPart)[0]
      expect(tool?.type).toBe('tool-askForConfirmation')
      expect(tool?.state).toBe('input-available')

      // addToolOutput 相当: ツール出力を入れて、履歴ごと再送する
      const answered: UIMessage = {
        ...assistant,
        id: 'assistant-1',
        parts: assistant.parts.map((part) =>
          isToolUIPart(part)
            ? { ...part, state: 'output-available', output: { confirmed: true } }
            : part,
        ) as UIMessage['parts'],
      }
      const second = await chatChunks({
        messages: [user, answered],
        body: { scenario: 'client-tool' },
      })
      // 新しい messageId を返すと、クライアントで assistant メッセージが二重になる
      expect(second[0]).toEqual({ type: 'start' })
      const final = await toMessage(second, answered)
      expect(final.id).toBe('assistant-1')
      expect(final.parts.filter(isToolUIPart)[0]?.state).toBe('output-available')
      expect(textOf(final)).toContain('confirmed')
    })

    it('client-tool: 前のターンで完了済みでも、新しいユーザー発言なら最初からやり直す', async () => {
      const { user, assistant } = await firstTurn('client-tool')
      const done: UIMessage = {
        ...assistant,
        parts: assistant.parts.map((part) =>
          isToolUIPart(part) ? { ...part, state: 'output-available', output: true } : part,
        ) as UIMessage['parts'],
      }
      const again = await toMessage(
        await chatChunks({
          messages: [user, done, userMessage('#client-tool もう一度', 'user-2')],
        }),
      )
      expect(again.parts.filter(isToolUIPart)[0]?.state).toBe('input-available')
    })

    it('approval: 承認要求で終了し、承認つきで再送するとツール出力と本文が続く', async () => {
      const { user, chunks, assistant } = await firstTurn('approval')
      expect(chunks.some((c) => c.type === 'tool-approval-request')).toBe(true)
      const tool = assistant.parts.filter(isToolUIPart)[0]
      expect(tool?.type).toBe('tool-deleteFile')
      expect(tool?.state).toBe('approval-requested')
      expect(tool?.approval?.id).toBeTruthy()

      const approved: UIMessage = {
        ...assistant,
        id: 'assistant-1',
        parts: assistant.parts.map((part) =>
          isToolUIPart(part) && part.approval !== undefined
            ? {
                ...part,
                state: 'approval-responded',
                approval: { ...part.approval, approved: true },
              }
            : part,
        ) as UIMessage['parts'],
      }
      const second = await chatChunks({
        messages: [user, approved],
        body: { scenario: 'approval' },
      })
      expect(second[0]).toEqual({ type: 'start' })
      const final = await toMessage(second, approved)
      expect(final.id).toBe('assistant-1')
      const finalTool = final.parts.filter(isToolUIPart)[0]
      expect(finalTool?.state).toBe('output-available')
      expect(finalTool?.output).toMatchObject({ deleted: true })
      expect(textOf(final)).toContain('削除しました')
    })

    it('approval: 拒否つきで再送すると output-denied と本文が続く', async () => {
      const { user, assistant } = await firstTurn('approval')
      const denied: UIMessage = {
        ...assistant,
        id: 'assistant-1',
        parts: assistant.parts.map((part) =>
          isToolUIPart(part) && part.approval !== undefined
            ? {
                ...part,
                state: 'approval-responded',
                approval: { ...part.approval, approved: false },
              }
            : part,
        ) as UIMessage['parts'],
      }
      const second = await chatChunks({ messages: [user, denied], body: { scenario: 'approval' } })
      expect(second.map((c) => c.type)).toContain('tool-output-denied')
      const final = await toMessage(second, denied)
      expect(final.parts.filter(isToolUIPart)[0]?.state).toBe('output-denied')
      expect(textOf(final)).toContain('拒否')
    })
  })

  // -------------------------------------------------------------------------
  describe('意図的に壊れたシナリオ', () => {
    it('no-header: 正常なストリームだが x-vercel-ai-ui-message-stream がない', async () => {
      const res = await postJson('/api/chat', { scenario: 'no-header', messages: [] })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBeNull()
      expect(await res.text()).toMatch(/data: \[DONE\]\n\n$/)
    })

    it('no-done: 末尾の [DONE] がない（ヘッダーはある）', async () => {
      const res = await postJson('/api/chat', { scenario: 'no-done', messages: [] })
      expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
      const text = await res.text()
      expect(text).not.toContain('[DONE]')
      expect(text).toContain('"type":"finish"')
    })

    it('bad-json: 壊れた JSON 行が混ざり、クライアントのパースが失敗する', async () => {
      const text = await (
        await postJson('/api/chat', { scenario: 'bad-json', messages: [] })
      ).text()
      const payloads = text
        .split('\n\n')
        .filter((e) => e !== '')
        .map((e) => e.slice('data: '.length))
      const broken = payloads.filter((p) => {
        if (p === '[DONE]') return false
        try {
          JSON.parse(p)
          return false
        } catch {
          return true
        }
      })
      expect(broken).toHaveLength(1)
      // 壊れた行の前後には正常なチャンクがある
      expect(payloads.indexOf(broken[0] ?? '')).toBeGreaterThan(2)

      await expect(chatChunks({ body: { scenario: 'bad-json' } })).rejects.toThrow()
    })

    it('error: 本文の途中で type:"error" チャンクが来て、処理がエラーになる', async () => {
      const chunks = await chatChunks({ body: { scenario: 'error' } })
      expect(chunks.at(-1)).toMatchObject({ type: 'error' })
      expect(chunks.filter((c) => c.type === 'text-delta').length).toBeGreaterThan(0)
      await expect(toMessage(chunks)).rejects.toThrow('ストリームの途中で失敗しました')
    })

    it('abort: 途中でソケットが切断され、body の読み取りが失敗する', async () => {
      const res = await postJson('/api/chat', { scenario: 'abort', messages: [] })
      expect(res.status).toBe(200)
      await expect(res.text()).rejects.toThrow()
      await vi.waitFor(() =>
        expect(mock.logs.some((l) => l.scenario === 'abort' && l.outcome === 'destroyed')).toBe(
          true,
        ),
      )
      await expect(chatChunks({ body: { scenario: 'abort' } })).rejects.toThrow()
    })

    it.each([
      ['http-500', 500],
      ['http-401', 401],
    ])(
      '%s: HTTP %i の JSON を返し、クライアントは APICallError にする',
      async (scenario, status) => {
        const res = await postJson('/api/chat', { scenario, messages: [] })
        expect(res.status).toBe(status)
        expect(res.headers.get('content-type')).toContain('application/json')
        expect(((await res.json()) as { error: string }).error).toBeTruthy()

        await expect(chatChunks({ body: { scenario } })).rejects.toMatchObject({
          statusCode: status,
        })
      },
    )

    it('http-401: WWW-Authenticate を返す', async () => {
      const res = await postJson('/api/chat', { scenario: 'http-401', messages: [] })
      expect(res.headers.get('www-authenticate')).toContain('Bearer')
    })

    it('auth: Bearer test-token がなければ 401、あれば成功', async () => {
      const without = await postJson('/api/chat', { scenario: 'auth', messages: [] })
      expect(without.status).toBe(401)

      const wrong = await postJson(
        '/api/chat',
        { scenario: 'auth', messages: [] },
        { headers: { authorization: 'Bearer nope', 'content-type': 'application/json' } },
      )
      expect(wrong.status).toBe(401)

      const basic = await postJson(
        '/api/chat',
        { scenario: 'auth', messages: [] },
        {
          headers: { authorization: 'Basic dGVzdC10b2tlbg==', 'content-type': 'application/json' },
        },
      )
      expect(basic.status).toBe(401)

      const { message } = await chatMessage('auth', {
        headers: { authorization: 'Bearer test-token' },
      })
      expect(textOf(message)).toContain('認証に成功')

      const lower = await chatMessage('auth', { headers: { authorization: 'bearer test-token' } })
      expect(textOf(lower.message)).toContain('認証に成功')
    })
  })

  // -------------------------------------------------------------------------
  describe('POST /api/text（Text Stream）', () => {
    async function textMessage(
      scenario: string | undefined,
      options: { text?: string; headers?: Record<string, string> } = {},
    ): Promise<UIMessage> {
      const query = scenario === undefined ? '' : `?scenario=${scenario}`
      const transport = new TextStreamChatTransport({
        api: `${mock.url}/api/text${query}`,
        headers: options.headers,
      })
      const stream = await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage(options.text ?? 'こんにちは')],
        trigger: 'submit-message',
        messageId: undefined,
        abortSignal: undefined,
      })
      return toMessage(await readChunks(stream))
    }

    it('既定: プレーンテキストを単語ずつ流す', async () => {
      const res = await postJson('/api/text', { messages: [userMessage('やあ')] })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBeNull()
      expect(await res.text()).toContain('「やあ」')

      expect(textOf(await textMessage(undefined, { text: 'テキスト入力' }))).toContain(
        '「テキスト入力」',
      )
    })

    it('slow: 20 トークン', async () => {
      const text = textOf(await textMessage('slow'))
      expect(text).toContain('トークン1 ')
      expect(text).toContain('トークン20 ')
    })

    it('empty: 本文が空', async () => {
      const res = await postJson('/api/text?scenario=empty', { messages: [] })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')
      expect(textOf(await textMessage('empty'))).toBe('')
    })

    it('echo: 受信したリクエストを返す', async () => {
      const text = textOf(await textMessage('echo', { headers: { 'x-trace': 'abc' } }))
      expect(text).toContain('/api/text?scenario=echo')
      expect(text).toContain('"x-trace": "abc"')
    })

    it('error: 途中で接続が切れる', async () => {
      const res = await postJson('/api/text?scenario=error', { messages: [] })
      expect(res.status).toBe(200)
      await expect(res.text()).rejects.toThrow()
    })

    it('http-500 / auth', async () => {
      expect((await postJson('/api/text?scenario=http-500', {})).status).toBe(500)
      expect((await postJson('/api/text?scenario=auth', {})).status).toBe(401)
      expect(
        textOf(await textMessage('auth', { headers: { authorization: 'Bearer test-token' } })),
      ).toContain('認証に成功')
    })
  })

  // -------------------------------------------------------------------------
  describe('POST /api/completion（useCompletion）', () => {
    async function complete(options: {
      query?: string
      protocol?: 'data' | 'text'
      prompt?: string
      body?: Record<string, unknown>
      headers?: Record<string, string>
    }) {
      const completions: string[] = []
      const errors: Error[] = []
      const result = await callCompletionApi({
        api: `${mock.url}/api/completion${options.query ?? ''}`,
        prompt: options.prompt ?? 'こんにちは',
        credentials: undefined,
        headers: options.headers,
        body: options.body ?? {},
        streamProtocol: options.protocol ?? 'data',
        setCompletion: (value) => completions.push(value),
        setLoading: () => {},
        setError: (error) => {
          if (error !== undefined) errors.push(error)
        },
        setAbortController: () => {},
        onFinish: undefined,
        onError: undefined,
        fetch: undefined,
      })
      return { result, completion: completions.at(-1) ?? '', errors }
    }

    it('data プロトコル（既定）: text-delta が連結されて completion になる', async () => {
      const { result, completion, errors } = await complete({ prompt: 'プロンプト' })
      expect(errors).toEqual([])
      expect(result).toContain('「プロンプト」')
      expect(completion).toBe(result)
    })

    it('data プロトコル: SSE のヘッダーと [DONE] がある', async () => {
      const res = await postJson('/api/completion', { prompt: 'x' })
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
      expect(await res.text()).toMatch(/data: \[DONE\]\n\n$/)
    })

    it('text プロトコル: プレーンテキストの completion になる', async () => {
      const { result, errors } = await complete({
        query: '?protocol=text',
        protocol: 'text',
        prompt: 'テキスト',
      })
      expect(errors).toEqual([])
      expect(result).toContain('「テキスト」')
      const res = await postJson('/api/completion?protocol=text', { prompt: 'x' })
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    })

    it('slow: 20 トークン', async () => {
      const { result } = await complete({ query: '?scenario=slow' })
      expect(result).toContain('トークン20 ')
    })

    it('empty: completion は空文字', async () => {
      expect((await complete({ query: '?scenario=empty' })).result).toBe('')
    })

    it('error（data）: 途中まで流れてから error チャンクで失敗する', async () => {
      const { completion, errors } = await complete({ query: '?scenario=error' })
      expect(completion).toBe('ここまでは 順調でした。')
      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).toContain('ストリームの途中で失敗しました')
    })

    it('error（text）: 接続切断で失敗する', async () => {
      const { errors } = await complete({
        query: '?protocol=text&scenario=error',
        protocol: 'text',
      })
      expect(errors).toHaveLength(1)
    })

    it('echo: prompt と追加ボディ・ヘッダーが届いたことを確認できる', async () => {
      const { result } = await complete({
        query: '?scenario=echo',
        prompt: 'エコー対象',
        body: { temperature: 0.5 },
        headers: { 'x-extra': 'yes' },
      })
      expect(result).toContain('"prompt": "エコー対象"')
      expect(result).toContain('"temperature": 0.5')
      expect(result).toContain('"x-extra": "yes"')
      expect(result).toContain('追加ボディキー**: temperature')
    })

    it('不正な protocol は 400', async () => {
      const res = await postJson('/api/completion?protocol=xml', { prompt: 'x' })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('unknown_protocol')
    })

    it('http-401 は APICallError 相当のエラーになる', async () => {
      const { errors } = await complete({ query: '?scenario=http-401' })
      expect(errors).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  describe('ANY /api/json（Raw HTTP 用エコー）', () => {
    it('メソッド・パス・クエリ・ヘッダー・パース済み JSON body を返す', async () => {
      const res = await postJson(
        '/api/json?a=1&tag=x&tag=y',
        { hello: 'world', n: 1 },
        { headers: { 'x-test': 'v', 'content-type': 'application/json' } },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const json = (await res.json()) as Record<string, unknown>
      expect(json).toMatchObject({
        method: 'POST',
        path: '/api/json',
        query: { a: '1', tag: ['x', 'y'] },
        body: { hello: 'world', n: 1 },
      })
      expect((json.headers as Record<string, string>)['x-test']).toBe('v')
      expect(Number.isNaN(Date.parse(String(json.receivedAt)))).toBe(false)
    })

    it.each(['GET', 'PUT', 'PATCH', 'DELETE'])('%s も受け付ける', async (method) => {
      const res = await fetch(`${mock.url}/api/json`, {
        method,
        ...(method === 'GET'
          ? {}
          : { body: 'plain text body', headers: { 'content-type': 'text/plain' } }),
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { method: string; body: unknown }
      expect(json.method).toBe(method)
      expect(json.body).toBe(method === 'GET' ? '' : 'plain text body')
    })

    it('JSON でない body は文字列のまま返す', async () => {
      const res = await fetch(`${mock.url}/api/json`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'a=1&b=2',
      })
      expect(((await res.json()) as { body: unknown }).body).toBe('a=1&b=2')
    })

    it('壊れた JSON は文字列のまま返す', async () => {
      const res = await postJson('/api/json', undefined, { body: '{"broken":' })
      expect(((await res.json()) as { body: unknown }).body).toBe('{"broken":')
    })

    it('?status= でステータスを強制できる', async () => {
      const res = await fetch(`${mock.url}/api/json?status=418`)
      expect(res.status).toBe(418)
      expect(((await res.json()) as { method: string }).method).toBe('GET')
    })

    it('?status=204 は body なし', async () => {
      const res = await fetch(`${mock.url}/api/json?status=204`)
      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')
    })

    it.each(['abc', '99', '600', '200.5'])('?status=%s は 400', async (status) => {
      const res = await fetch(`${mock.url}/api/json?status=${status}`)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('invalid_status')
    })

    it('?delay= で応答を遅らせる', async () => {
      const startedAt = Date.now()
      const res = await fetch(`${mock.url}/api/json?delay=150`)
      expect(res.status).toBe(200)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140)
    })

    it.each(['-1', 'abc', '999999'])('?delay=%s は 400', async (delay) => {
      const res = await fetch(`${mock.url}/api/json?delay=${delay}`)
      expect(res.status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  describe('CORS', () => {
    it('有効: Origin を許可し、ストリームヘッダーを公開する', async () => {
      const res = await fetch(`${mock.url}/health`, {
        headers: { origin: 'http://localhost:5173' },
      })
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
      expect(res.headers.get('vary')).toContain('Origin')
      const expose = res.headers.get('access-control-expose-headers') ?? ''
      expect(expose).toContain('x-vercel-ai-ui-message-stream')
      expect(expose).toContain('content-type')
    })

    it('有効: Origin がなければ * を返す', async () => {
      const res = await fetch(`${mock.url}/health`)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    })

    it('有効: OPTIONS プリフライトは 204 で、要求されたヘッダーをそのまま許可する', async () => {
      const res = await fetch(`${mock.url}/api/chat`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type, authorization, x-anything',
          'access-control-request-private-network': 'true',
        },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
      expect(res.headers.get('access-control-allow-methods')).toContain('POST')
      expect(res.headers.get('access-control-allow-headers')).toBe(
        'content-type, authorization, x-anything',
      )
      expect(res.headers.get('access-control-allow-private-network')).toBe('true')
      expect(await res.text()).toBe('')
    })

    it('有効: 401 / 404 / 500 のエラー応答にも CORS ヘッダーが付く（ブラウザが本来のステータスを読める）', async () => {
      const origin = 'http://localhost:5173'
      for (const [path, status] of [
        ['/api/chat?scenario=http-401', 401],
        ['/api/chat?scenario=http-500', 500],
        ['/api/chat?scenario=auth', 401],
        ['/nope', 404],
      ] as const) {
        const res = await fetch(`${mock.url}${path}`, {
          method: path === '/nope' ? 'GET' : 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: path === '/nope' ? undefined : '{}',
        })
        expect(res.status, path).toBe(status)
        expect(res.headers.get('access-control-allow-origin'), path).toBe(origin)
      }
    })

    it('無効: どのレスポンスにも access-control-* を付けない', async () => {
      const origin = 'http://localhost:5173'
      const responses = [
        await fetch(`${noCors.url}/health`, { headers: { origin } }),
        await fetch(`${noCors.url}/api/chat?scenario=http-401`, {
          method: 'POST',
          headers: { origin },
          body: '{}',
        }),
        await fetch(`${noCors.url}/nope`, { headers: { origin } }),
        await fetch(`${noCors.url}/api/chat`, {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST' },
        }),
        await fetch(`${noCors.url}/api/json`, { method: 'OPTIONS', headers: { origin } }),
      ]
      for (const res of responses) {
        const cors = [...res.headers.keys()].filter((name) => name.startsWith('access-control-'))
        expect(cors, `${res.url} ${res.status}`).toEqual([])
        await res.body?.cancel()
      }
      // プリフライトは成功扱いにならない（ブラウザは ACAO がないので弾く）
      expect(responses[3]?.status).toBe(405)
    })

    it('無効でも通常のリクエストは処理できる（サーバー側は CORS を見ていない）', async () => {
      const res = await fetch(`${noCors.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: 'text', messages: [] }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
      await res.body?.cancel()
    })
  })
})
