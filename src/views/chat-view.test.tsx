// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatActionsContext } from '@/components/chat/chat-context'
import type { ChatActions } from '@/components/chat/chat-context'
import { ChatMessage } from '@/components/chat/chat-message'
import { TooltipProvider } from '@/components/ui/tooltip'
import { networkLog } from '@/lib/network-log'
import { createDefaultSettings, newHeaderEntry } from '@/lib/settings'
import { settingsStore } from '@/lib/settings-store'
import { ChatView } from '@/views/chat-view'
import type { ChatViewMode } from '@/views/chat-view'

// Markdown 描画（Streamdown と各プラグイン）と shiki は jsdom では重く不安定なので差し替える
vi.mock('streamdown', async () => {
  const React = await import('react')
  return {
    Streamdown: ({ children }: { children?: ReactNode }) =>
      React.createElement('div', { 'data-testid': 'streamdown' }, children),
  }
})
vi.mock('@streamdown/cjk', () => ({ cjk: {} }))
vi.mock('@streamdown/code', () => ({ code: {} }))
vi.mock('@streamdown/math', () => ({ math: {} }))
vi.mock('@streamdown/mermaid', () => ({ mermaid: {} }))
// ハイライト結果を返さない → CodeBlock は即時表示の生トークンのまま動く
vi.mock('shiki', () => ({ createHighlighter: () => new Promise(() => {}) }))

// ---------------------------------------------------------------------------
// テスト用の fetch と SSE
// ---------------------------------------------------------------------------

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'x-vercel-ai-ui-message-stream': 'v1',
}
const ENDPOINTS = {
  'chat-ui': 'http://mock.test/api/chat',
  'chat-text': 'http://mock.test/api/text',
}

type Chunk = Record<string, unknown>

function encodeSse(chunks: Chunk[], done = true): string {
  return (
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
  )
}

function sseResponse(chunks: Chunk[], init: ResponseInit = {}): Response {
  return new Response(encodeSse(chunks), { status: 200, headers: SSE_HEADERS, ...init })
}

/** start 〜 finish で囲む。継続リクエストの応答は messageId を付けない（既存メッセージへ追記される）。 */
function messageChunks(inner: Chunk[], finishReason = 'stop'): Chunk[] {
  return [{ type: 'start' }, ...inner, { type: 'finish', finishReason }]
}

function stepChunks(inner: Chunk[]): Chunk[] {
  return [{ type: 'start-step' }, ...inner, { type: 'finish-step' }]
}

function textChunks(text: string, id = 't1'): Chunk[] {
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
  ]
}

function textReply(text: string): Response {
  return sseResponse(messageChunks(stepChunks(textChunks(text))))
}

/** クライアントツールの呼び出しで終わる応答（出力待ち）。 */
function clientToolReply(toolCallId = 'call_c1'): Response {
  return sseResponse(
    messageChunks(
      stepChunks([
        { type: 'tool-input-start', toolCallId, toolName: 'askForConfirmation' },
        {
          type: 'tool-input-available',
          toolCallId,
          toolName: 'askForConfirmation',
          input: { message: '実行してよいですか？' },
        },
      ]),
      'tool-calls',
    ),
  )
}

function approvalReply(toolCallId = 'call_a1', approvalId = 'approval_1'): Response {
  return sseResponse(
    messageChunks(
      stepChunks([
        {
          type: 'tool-input-available',
          toolCallId,
          toolName: 'deleteFile',
          input: { path: '/tmp/report.txt' },
        },
        { type: 'tool-approval-request', approvalId, toolCallId },
      ]),
      'tool-calls',
    ),
  )
}

/** 最初のチャンクだけ流して、中断されるまで閉じない応答。 */
function hangingReply(init: RequestInit, chunks: Chunk[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(encodeSse(chunks, false)))
      init.signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'))
        } catch {
          // すでに閉じている
        }
      })
    },
  })
  return new Response(stream, { status: 200, headers: SSE_HEADERS })
}

/** 応答が来ないまま待ち続け、中断されたら AbortError で終わる（status: submitted のまま止めたいとき）。 */
function pendingUntilAbort(init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    )
  })
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

let fetchMock: ReturnType<typeof vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>>

/** 呼び出し順に handler を割り当てる（最後の handler は以降も使い回す）。blob: は添付の data URL 変換用。 */
function stubFetch(...handlers: Handler[]): void {
  let call = 0
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('blob:')) {
      // jsdom の FileReader は Node 標準の Blob を読めないので、jsdom の Blob を返す Response 風オブジェクトにする
      const blob = new Blob(['abc'], { type: 'image/png' })
      return { blob: async () => blob } as unknown as Response
    }
    const handler = handlers[Math.min(call, handlers.length - 1)]
    call += 1
    if (handler === undefined) throw new Error('handler が未指定です')
    return handler(url, init ?? {})
  })
  vi.stubGlobal('fetch', fetchMock)
}

function chatCalls(): Array<[string, RequestInit]> {
  return fetchMock.mock.calls
    .filter(([input]) => !String(input).startsWith('blob:'))
    .map(([input, init]) => [String(input), init ?? {}])
}

interface SentMessage {
  id: string
  role: string
  parts: Array<Record<string, unknown>>
}

function sentBody(callIndex: number): { id?: string; messages: SentMessage[]; trigger?: string } {
  const call = chatCalls()[callIndex]
  if (call === undefined) throw new Error(`${callIndex + 1} 回目のリクエストがありません`)
  const body = call[1].body
  if (typeof body !== 'string') throw new Error('body が文字列ではありません')
  return JSON.parse(body) as { id?: string; messages: SentMessage[]; trigger?: string }
}

function headersOf(callIndex: number): Record<string, string> {
  const call = chatCalls()[callIndex]
  return (call?.[1].headers ?? {}) as Record<string, string>
}

// ---------------------------------------------------------------------------
// 画面操作
// ---------------------------------------------------------------------------

function renderChat(mode: ChatViewMode = 'chat-ui') {
  return render(
    <StrictMode>
      <TooltipProvider>
        <div style={{ height: 600 }}>
          <ChatView mode={mode} />
        </div>
      </TooltipProvider>
    </StrictMode>,
  )
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'メッセージ' }) as HTMLTextAreaElement
}

async function sendText(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(textbox(), text)
  await user.click(screen.getByRole('button', { name: '送信' }))
}

const LONG = { timeout: 5000 }

/** Reasoning / Tool などは自動で開閉することがあるので、閉じているときだけ開く。 */
async function expand(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  if (trigger.getAttribute('aria-expanded') !== 'true') await user.click(trigger)
}

function statusBadge(): HTMLElement {
  const badge = document.querySelector('[data-status]')
  if (!(badge instanceof HTMLElement)) throw new Error('状態バッジが見つかりません')
  return badge
}

beforeEach(() => {
  const defaults = createDefaultSettings()
  settingsStore.update({ endpoints: { ...defaults.endpoints, ...ENDPOINTS } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  settingsStore.reset()
  networkLog.clear()
})

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('ChatView: 基本の送受信（chat-ui）', () => {
  it('送信するとユーザーの発言とアシスタントの応答が表示され、設定のエンドポイントへ createTesterFetch 経由で送られる', async () => {
    stubFetch(() => textReply('こんにちは、AI です。'))
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'やあ')

    expect(await screen.findByText('こんにちは、AI です。', {}, LONG)).toBeTruthy()
    expect(screen.getByText('やあ')).toBeTruthy()

    // StrictMode の二重実行でも 1 回だけ送る
    expect(chatCalls()).toHaveLength(1)
    const [url, init] = chatCalls()[0] ?? ['', {}]
    expect(url).toBe(ENDPOINTS['chat-ui'])
    expect(init.method).toBe('POST')
    const body = sentBody(0)
    expect(body.trigger).toBe('submit-message')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.parts).toEqual([{ type: 'text', text: 'やあ' }])

    // createTesterFetch を通ったのでネットワークログに残る
    const entries = networkLog.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.targetUrl).toBe(ENDPOINTS['chat-ui'])

    await waitFor(() => expect(statusBadge().dataset.status).toBe('ready'))
    expect(statusBadge().textContent).toContain('待機中')
  })

  it('送信中は状態バッジが変わり、完了すると待機中に戻る', async () => {
    let release: (() => void) | undefined
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(textReply('おまたせ'))
        }),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'こんにちは')
    await waitFor(() => expect(statusBadge().dataset.status).toBe('submitted'))
    expect(screen.getByText('応答を待っています...')).toBeTruthy()
    // 同梱の英語ラベル（Loading）ではなく日本語のラベルになっている
    expect(screen.getByLabelText('送信中')).toBeTruthy()
    expect(screen.queryByLabelText('Loading')).toBeNull()

    release?.()
    expect(await screen.findByText('おまたせ', {}, LONG)).toBeTruthy()
    await waitFor(() => expect(statusBadge().dataset.status).toBe('ready'))
  })

  it('reasoning パートを折りたたみで表示する', async () => {
    stubFetch(() =>
      sseResponse(
        messageChunks(
          stepChunks([
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'まず前提を整理します。' },
            { type: 'reasoning-end', id: 'r1' },
            ...textChunks('結論です。'),
          ]),
        ),
      ),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'なぜ？')
    expect(await screen.findByText('結論です。', {}, LONG)).toBeTruthy()

    const trigger = await screen.findByRole('button', { name: /思考過程|秒間考えました/ })
    await expand(user, trigger)
    expect(await screen.findByText('まず前提を整理します。')).toBeTruthy()
  })

  it('サーバー実行ツールの入力と出力を表示する', async () => {
    stubFetch(() =>
      sseResponse(
        messageChunks([
          ...stepChunks([
            { type: 'tool-input-start', toolCallId: 'call_w1', toolName: 'getWeather' },
            { type: 'tool-input-delta', toolCallId: 'call_w1', inputTextDelta: '{"city":' },
            { type: 'tool-input-delta', toolCallId: 'call_w1', inputTextDelta: '"Tokyo"}' },
            {
              type: 'tool-input-available',
              toolCallId: 'call_w1',
              toolName: 'getWeather',
              input: { city: 'Tokyo' },
            },
            {
              type: 'tool-output-available',
              toolCallId: 'call_w1',
              output: { condition: 'sunny', temperatureC: 22 },
            },
          ]),
          ...stepChunks(textChunks('東京は晴れです。', 't2')),
        ]),
      ),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#tool 東京の天気')
    expect(await screen.findByText('東京は晴れです。', {}, LONG)).toBeTruthy()

    const trigger = screen.getByRole('button', { name: /getWeather/ })
    expect(within(trigger).getByText('完了')).toBeTruthy()
    await expand(user, trigger)
    expect(await screen.findByText(/"city": "Tokyo"/)).toBeTruthy()
    expect(screen.getByText(/"condition": "sunny"/)).toBeTruthy()
    // 2 ステップ目の前に区切りが出る
    expect(screen.getByText('ステップ 2')).toBeTruthy()
  })

  it('ツールがエラーを返したときはエラー状態とメッセージを表示する', async () => {
    stubFetch(() =>
      sseResponse(
        messageChunks(
          stepChunks([
            {
              type: 'tool-input-available',
              toolCallId: 'call_e1',
              toolName: 'getWeather',
              input: { city: 'Atlantis' },
            },
            {
              type: 'tool-output-error',
              toolCallId: 'call_e1',
              errorText: 'API がタイムアウトしました',
            },
          ]),
        ),
      ),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#tool-error x')
    const trigger = await screen.findByRole('button', { name: /getWeather/ }, LONG)
    await waitFor(() => expect(within(trigger).getByText('エラー')).toBeTruthy())
    await expand(user, trigger)
    expect(await screen.findByText('API がタイムアウトしました')).toBeTruthy()
  })
})

describe('ChatView: クライアントツールの手動出力', () => {
  it('出力を返すと addToolOutput され、自動で再送されて続きが表示される', async () => {
    stubFetch(
      () => clientToolReply(),
      () => textReply('出力を受け取りました。'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#client-tool 実行して')
    const field = await screen.findByLabelText(
      'クライアントツールの出力（JSON または文字列）',
      {},
      LONG,
    )
    const trigger = screen.getByRole('button', { name: /askForConfirmation/ })
    expect(within(trigger).getByText('出力待ち')).toBeTruthy()

    await user.click(field)
    await user.paste('{"confirmed": true}')
    expect(screen.getByText(/JSON（object）として送信します/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '出力を返す' }))

    expect(await screen.findByText('出力を受け取りました。', {}, LONG)).toBeTruthy()
    expect(chatCalls()).toHaveLength(2)
    const resent = sentBody(1)
    expect(resent.trigger).toBe('submit-message')
    const assistant = resent.messages.at(-1)
    expect(assistant?.role).toBe('assistant')
    const toolPart = assistant?.parts.find((part) => part.type === 'tool-askForConfirmation')
    expect(toolPart).toMatchObject({
      state: 'output-available',
      toolCallId: 'call_c1',
      output: { confirmed: true },
    })
    // フォームは消え、ツールは完了になる
    expect(screen.queryByLabelText('クライアントツールの出力（JSON または文字列）')).toBeNull()
    expect(
      within(screen.getByRole('button', { name: /askForConfirmation/ })).getByText('完了'),
    ).toBeTruthy()
  })

  it('JSON にならない入力は文字列として送る', async () => {
    stubFetch(
      () => clientToolReply(),
      () => textReply('了解'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#client-tool')
    const field = await screen.findByLabelText(
      'クライアントツールの出力（JSON または文字列）',
      {},
      LONG,
    )
    await user.click(field)
    await user.paste('はい、実行します')
    expect(screen.getByText(/文字列として送信します/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '出力を返す' }))

    await screen.findByText('了解', {}, LONG)
    const toolPart = sentBody(1)
      .messages.at(-1)
      ?.parts.find((p) => p.type === 'tool-askForConfirmation')
    expect(toolPart).toMatchObject({ state: 'output-available', output: 'はい、実行します' })
  })

  it('エラーを返すと output-error + errorText で再送される', async () => {
    stubFetch(
      () => clientToolReply(),
      () => textReply('エラーを受け取りました。'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#client-tool')
    const field = await screen.findByLabelText(
      'クライアントツールの出力（JSON または文字列）',
      {},
      LONG,
    )
    await user.click(field)
    await user.paste('ユーザーが拒否しました')
    await user.click(screen.getByRole('button', { name: 'エラーを返す' }))

    await screen.findByText('エラーを受け取りました。', {}, LONG)
    const toolPart = sentBody(1)
      .messages.at(-1)
      ?.parts.find((p) => p.type === 'tool-askForConfirmation')
    expect(toolPart).toMatchObject({ state: 'output-error', errorText: 'ユーザーが拒否しました' })
  })

  it('入力が空の間は「出力を返す」を押せない', async () => {
    stubFetch(() => clientToolReply())
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#client-tool')
    await screen.findByLabelText('クライアントツールの出力（JSON または文字列）', {}, LONG)
    expect((screen.getByRole('button', { name: '出力を返す' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('自動再送が無効なら送信されず、「結果を送信」で手動再送できる', async () => {
    settingsStore.update({ autoSendAfterToolOutput: false })
    stubFetch(
      () => clientToolReply(),
      () => textReply('手動で再送しました。'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#client-tool')
    const field = await screen.findByLabelText(
      'クライアントツールの出力（JSON または文字列）',
      {},
      LONG,
    )
    await user.click(field)
    await user.paste('"ok"')
    await user.click(screen.getByRole('button', { name: '出力を返す' }))

    const resubmit = await screen.findByRole('button', { name: '結果を送信' })
    expect(screen.getByText('ツールの出力（または承認）が揃っています')).toBeTruthy()
    expect(screen.queryByText('この状態では結果を送信できません')).toBeNull()
    expect(chatCalls()).toHaveLength(1)
    await user.click(resubmit)

    expect(await screen.findByText('手動で再送しました。', {}, LONG)).toBeTruthy()
    expect(chatCalls()).toHaveLength(2)
    expect(screen.queryByRole('button', { name: '結果を送信' })).toBeNull()
  })

  it('自動再送が失敗したら、再試行は同じ出力で継続リクエストを送り直す（再生成ではない）', async () => {
    stubFetch(
      () => clientToolReply(),
      () => new Response('upstream error', { status: 503 }),
      () => textReply('復旧しました。'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#client-tool')
    const field = await screen.findByLabelText(
      'クライアントツールの出力（JSON または文字列）',
      {},
      LONG,
    )
    await user.click(field)
    await user.paste('{"confirmed": true}')
    await user.click(screen.getByRole('button', { name: '出力を返す' }))

    const alert = await screen.findByRole('alert', {}, LONG)
    expect(within(alert).getByText('HTTP 503')).toBeTruthy()
    expect(chatCalls()).toHaveLength(2)

    await user.click(within(alert).getByRole('button', { name: '再試行' }))

    expect(await screen.findByText('復旧しました。', {}, LONG)).toBeTruthy()
    expect(chatCalls()).toHaveLength(3)
    const retried = sentBody(2)
    expect(retried.trigger).toBe('submit-message')
    // ユーザーが返した出力は失われず、ツール呼び出しも 1 つのまま
    const toolParts = retried.messages
      .at(-1)
      ?.parts.filter((p) => p.type === 'tool-askForConfirmation')
    expect(toolParts).toHaveLength(1)
    expect(toolParts?.[0]).toMatchObject({ state: 'output-available', output: { confirmed: true } })
  })

  it('サーバー実行ツールで終わる応答では自動再送しない（ユーザーが出力を返したときだけ再送する）', async () => {
    // 本文のないツール結果で終わる応答。SDK の既定の判定だけだと再送ループになる形
    stubFetch(() =>
      sseResponse(
        messageChunks(
          stepChunks([
            {
              type: 'tool-input-available',
              toolCallId: 'call_s1',
              toolName: 'getWeather',
              input: { city: 'Tokyo' },
            },
            { type: 'tool-output-available', toolCallId: 'call_s1', output: { ok: true } },
          ]),
        ),
      ),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#tool')
    await screen.findByRole('button', { name: /getWeather/ }, LONG)
    await waitFor(() => expect(statusBadge().dataset.status).toBe('ready'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(chatCalls()).toHaveLength(1)
  })

  it('サーバーが同じ状態を返し続けても自動再送は暴走しない', async () => {
    // 継続リクエストに対して、出力つきの同じツール呼び出しだけを返すサーバー（ステップ境界も本文もない）
    const sameState = () =>
      sseResponse(
        messageChunks([
          {
            type: 'tool-output-available',
            toolCallId: 'call_c1',
            output: 'ok',
          },
        ]),
      )
    stubFetch(() => clientToolReply(), sameState)
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#client-tool')
    const field = await screen.findByLabelText(
      'クライアントツールの出力（JSON または文字列）',
      {},
      LONG,
    )
    await user.click(field)
    await user.paste('"ok"')
    await user.click(screen.getByRole('button', { name: '出力を返す' }))

    await waitFor(() => expect(chatCalls()).toHaveLength(2), LONG)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(chatCalls()).toHaveLength(2)
  })
})

describe('ChatView: 届いていない継続の手動再送', () => {
  const OUTPUT_LABEL = 'クライアントツールの出力（JSON または文字列）'

  async function returnOutput(user: ReturnType<typeof userEvent.setup>, text: string) {
    const field = await screen.findByLabelText(OUTPUT_LABEL, {}, LONG)
    await user.click(field)
    await user.paste(text)
    await user.click(screen.getByRole('button', { name: '出力を返す' }))
  }

  it('自動再送の継続リクエストを停止しても、「結果を送信」で同じ出力を送り直せる', async () => {
    stubFetch(
      () => clientToolReply(),
      (_url, init) => pendingUntilAbort(init),
      () => textReply('送り直せました。'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#client-tool')
    await returnOutput(user, '{"confirmed": true}')
    await waitFor(() => expect(chatCalls()).toHaveLength(2), LONG)
    await waitFor(() => expect(statusBadge().dataset.status).toBe('submitted'))

    // 応答待ちの間に停止する。自動再送が有効でも、届いていない出力を手動で送れる手段が出る
    expect(screen.queryByRole('button', { name: '結果を送信' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(statusBadge().dataset.status).toBe('ready'), LONG)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      await screen.findByText('ツールの出力（または承認）がサーバーへ届いていません'),
    ).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '結果を送信' }))

    expect(await screen.findByText('送り直せました。', {}, LONG)).toBeTruthy()
    expect(chatCalls()).toHaveLength(3)
    const toolPart = sentBody(2)
      .messages.at(-1)
      ?.parts.find((p) => p.type === 'tool-askForConfirmation')
    expect(toolPart).toMatchObject({ state: 'output-available', output: { confirmed: true } })
    expect(screen.queryByRole('button', { name: '結果を送信' })).toBeNull()
  })

  it('失敗した継続のエラーバナーを閉じても、「結果を送信」は残る', async () => {
    stubFetch(
      () => clientToolReply(),
      () => new Response('upstream error', { status: 503 }),
      () => textReply('復旧しました。'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#client-tool')
    await returnOutput(user, '"ok"')
    const alert = await screen.findByRole('alert', {}, LONG)
    await user.click(within(alert).getByRole('button', { name: '閉じる' }))
    expect(screen.queryByRole('alert')).toBeNull()

    await user.click(await screen.findByRole('button', { name: '結果を送信' }))
    expect(await screen.findByText('復旧しました。', {}, LONG)).toBeTruthy()
    expect(chatCalls()).toHaveLength(3)
  })

  it('承認を返した直後にストリームを止めても、「結果を送信」で承認を送り直せる', async () => {
    stubFetch(
      (_url, init) =>
        hangingReply(init, [
          { type: 'start' },
          { type: 'start-step' },
          {
            type: 'tool-input-available',
            toolCallId: 'call_a1',
            toolName: 'deleteFile',
            input: { path: '/tmp/a' },
          },
          { type: 'tool-approval-request', approvalId: 'approval_h', toolCallId: 'call_a1' },
        ]),
      () => textReply('承認を送り直しました。'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#approval')
    await screen.findByText('このツールの実行を承認しますか？', {}, LONG)
    await waitFor(() => expect(statusBadge().dataset.status).toBe('streaming'))
    await user.click(screen.getByRole('button', { name: '承認' }))
    await user.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(statusBadge().dataset.status).toBe('ready'), LONG)

    const resubmit = await screen.findByRole('button', { name: '結果を送信' }, LONG)
    expect(chatCalls()).toHaveLength(1)
    await user.click(resubmit)

    expect(await screen.findByText('承認を送り直しました。', {}, LONG)).toBeTruthy()
    const toolPart = sentBody(1)
      .messages.at(-1)
      ?.parts.find((p) => p.type === 'tool-deleteFile')
    expect(toolPart).toMatchObject({
      state: 'approval-responded',
      approval: { id: 'approval_h', approved: true },
    })
  })

  it('自動再送が無効の間に出力を返したら、あとで有効にしても「結果を送信」で送れる', async () => {
    settingsStore.update({ autoSendAfterToolOutput: false })
    stubFetch(
      () => clientToolReply(),
      () => textReply('届きました。'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#client-tool')
    await returnOutput(user, '"ok"')
    await screen.findByRole('button', { name: '結果を送信' }, LONG)

    settingsStore.update({ autoSendAfterToolOutput: true })
    await user.click(await screen.findByRole('button', { name: '結果を送信' }))

    expect(await screen.findByText('届きました。', {}, LONG)).toBeTruthy()
    expect(chatCalls()).toHaveLength(2)
  })

  it('古いメッセージに承認応答が残っていると、誤った宛先へ再送せず再生成を案内する', async () => {
    // 承認に応答しないサーバー: 承認済みのメッセージ A が approval-responded のまま残り、その後にクライアントツール C が続く
    stubFetch(
      () => approvalReply(),
      () => textReply('承認には触れない応答'),
      () => clientToolReply('call_c9'),
      () => textReply('再生成された応答'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#approval')
    await screen.findByText('このツールの実行を承認しますか？', {}, LONG)
    await user.click(screen.getByRole('button', { name: '承認' }))
    await screen.findByText('承認には触れない応答', {}, LONG)
    await waitFor(() => expect(statusBadge().dataset.status).toBe('ready'))
    expect(chatCalls()).toHaveLength(2)

    settingsStore.update({ autoSendAfterToolOutput: false })
    await sendText(user, '#client-tool')
    await returnOutput(user, '"ok"')

    const title = await screen.findByText('この状態では結果を送信できません', {}, LONG)
    const bar = title.closest('[role="status"]') as HTMLElement
    expect(screen.queryByRole('button', { name: '結果を送信' })).toBeNull()
    expect(within(bar).getByText(/approval-responded/)).toBeTruthy()
    expect(chatCalls()).toHaveLength(3)

    await user.click(within(bar).getByRole('button', { name: '再生成' }))

    expect(await screen.findByText('再生成された応答', {}, LONG)).toBeTruthy()
    expect(chatCalls()).toHaveLength(4)
    expect(sentBody(3).trigger).toBe('regenerate-message')
  })
})

describe('ChatView: ツール承認', () => {
  it('承認すると approval-responded で再送される', async () => {
    stubFetch(
      () => approvalReply(),
      () =>
        sseResponse(
          messageChunks([
            { type: 'tool-output-available', toolCallId: 'call_a1', output: { deleted: true } },
            ...stepChunks(textChunks('削除しました。', 't9')),
          ]),
        ),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#approval 削除して')
    expect(await screen.findByText('このツールの実行を承認しますか？', {}, LONG)).toBeTruthy()
    expect(
      within(screen.getByRole('button', { name: /deleteFile/ })).getByText('承認待ち'),
    ).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '承認' }))

    expect(await screen.findByText('削除しました。', {}, LONG)).toBeTruthy()
    expect(chatCalls()).toHaveLength(2)
    const toolPart = sentBody(1)
      .messages.at(-1)
      ?.parts.find((p) => p.type === 'tool-deleteFile')
    expect(toolPart).toMatchObject({
      state: 'approval-responded',
      approval: { id: 'approval_1', approved: true },
    })
    expect(screen.getByText('承認しました')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '拒否' })).toBeNull()
  })

  it('理由つきで拒否すると approved: false と reason が送られ、denied の応答を表示する', async () => {
    stubFetch(
      () => approvalReply('call_a2', 'approval_2'),
      () =>
        sseResponse(
          messageChunks([
            { type: 'tool-output-denied', toolCallId: 'call_a2' },
            ...stepChunks(textChunks('削除は拒否されました。', 't9')),
          ]),
        ),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#approval 削除して')
    await screen.findByText('このツールの実行を承認しますか？', {}, LONG)
    await user.type(
      screen.getByRole('textbox', { name: '承認 / 拒否の理由（任意）' }),
      '本番データだから',
    )
    await user.click(screen.getByRole('button', { name: '拒否' }))

    expect(await screen.findByText('削除は拒否されました。', {}, LONG)).toBeTruthy()
    const toolPart = sentBody(1)
      .messages.at(-1)
      ?.parts.find((p) => p.type === 'tool-deleteFile')
    expect(toolPart).toMatchObject({
      state: 'approval-responded',
      approval: { id: 'approval_2', approved: false, reason: '本番データだから' },
    })
    const trigger = screen.getByRole('button', { name: /deleteFile/ })
    expect(within(trigger).getByText('実行拒否')).toBeTruthy()
    expect(screen.getByText('拒否しました')).toBeTruthy()
  })

  it('ストリームが続いている間に承認しても、ストリーム終了後に自動で再送される', async () => {
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    stubFetch(
      () => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c
            c.enqueue(
              encoder.encode(
                encodeSse(
                  [
                    { type: 'start' },
                    { type: 'start-step' },
                    {
                      type: 'tool-input-available',
                      toolCallId: 'call_a1',
                      toolName: 'deleteFile',
                      input: { path: '/tmp/a' },
                    },
                    {
                      type: 'tool-approval-request',
                      approvalId: 'approval_s',
                      toolCallId: 'call_a1',
                    },
                  ],
                  false,
                ),
              ),
            )
          },
        })
        return new Response(stream, { status: 200, headers: SSE_HEADERS })
      },
      () => textReply('再送されました'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#approval')
    await screen.findByText('このツールの実行を承認しますか？', {}, LONG)
    await waitFor(() => expect(statusBadge().dataset.status).toBe('streaming'))
    await user.click(screen.getByRole('button', { name: '承認' }))
    expect(chatCalls()).toHaveLength(1)

    // サーバーが応答を終えた時点で、承認済みの継続リクエストが送られる
    controller?.enqueue(
      encoder.encode(
        encodeSse([{ type: 'finish-step' }, { type: 'finish', finishReason: 'tool-calls' }], true),
      ),
    )
    controller?.close()

    expect(await screen.findByText('再送されました', {}, LONG)).toBeTruthy()
    expect(chatCalls()).toHaveLength(2)
    const toolPart = sentBody(1)
      .messages.at(-1)
      ?.parts.find((p) => p.type === 'tool-deleteFile')
    expect(toolPart).toMatchObject({
      state: 'approval-responded',
      approval: { id: 'approval_s', approved: true },
    })
  })
})

describe('ChatView: エラー・停止・新しい会話', () => {
  it('HTTP 500 でエラーバナーが出て、再試行で成功すると消える', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'internal_server_error', message: 'モックの 500' }), {
          status: 500,
        }),
      () => textReply('復旧しました。'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'こんにちは')
    const alert = await screen.findByRole('alert', {}, LONG)
    expect(within(alert).getByText('リクエストに失敗しました')).toBeTruthy()
    expect(within(alert).getByText('HTTP 500')).toBeTruthy()
    expect(within(alert).getByTestId('chat-error-message').textContent).toContain('モックの 500')
    expect(within(alert).getByText(/インスペクタの「診断」タブ/)).toBeTruthy()
    expect(statusBadge().dataset.status).toBe('error')

    await user.click(within(alert).getByRole('button', { name: '再試行' }))

    expect(await screen.findByText('復旧しました。', {}, LONG)).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId('chat-error-message')).toBeNull())
    expect(chatCalls()).toHaveLength(2)
    // ユーザーメッセージは重複しない
    expect(screen.getAllByText('こんにちは')).toHaveLength(1)
    expect(sentBody(1).messages).toHaveLength(1)
    expect(sentBody(1).trigger).toBe('regenerate-message')
  })

  it('「閉じる」でエラーバナーを消せる', async () => {
    stubFetch(() => new Response('boom', { status: 502 }))
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'x')
    const alert = await screen.findByRole('alert', {}, LONG)
    await user.click(within(alert).getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(statusBadge().dataset.status).toBe('ready')
  })

  it('停止ボタンでストリームを中断し、それまでの内容は残して待機中に戻る', async () => {
    let signal: AbortSignal | undefined
    stubFetch((_url, init) => {
      signal = init.signal ?? undefined
      return hangingReply(init, [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '途中まで…' },
      ])
    })
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'ゆっくり')
    expect(await screen.findByText('途中まで…', {}, LONG)).toBeTruthy()
    await waitFor(() => expect(statusBadge().dataset.status).toBe('streaming'))

    await user.click(screen.getByRole('button', { name: '停止' }))

    await waitFor(() => expect(statusBadge().dataset.status).toBe('ready'), LONG)
    expect(signal?.aborted).toBe(true)
    expect(screen.getByText('途中まで…')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('生成中に Enter を押しても送信されず、入力も失われない', async () => {
    stubFetch((_url, init) =>
      hangingReply(init, [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '生成中' },
      ]),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'one')
    await screen.findByText('生成中', {}, LONG)
    await user.type(textbox(), 'next')
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(chatCalls()).toHaveLength(1)
    expect(textbox().value).toBe('next')
  })

  it('「新しい会話」でメッセージが消え、空状態に戻る', async () => {
    stubFetch(() => textReply('ひとこと'))
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'こんにちは')
    await screen.findByText('ひとこと', {}, LONG)
    await user.click(screen.getByRole('button', { name: '新しい会話' }))

    await waitFor(() => expect(screen.queryByText('ひとこと')).toBeNull())
    expect(screen.getByText(/で会話を始める/)).toBeTruthy()
    expect(screen.getByText('0 件')).toBeTruthy()
  })

  it('「新しい会話」は次のリクエストの id を新しくする（サーバー側の履歴を引き継がない）', async () => {
    stubFetch(
      () => textReply('a'),
      () => textReply('b'),
      () => textReply('c'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'one')
    await screen.findByText('a', {}, LONG)
    settingsStore.update({ sendLastMessageOnly: true })
    await sendText(user, 'two')
    await screen.findByText('b', {}, LONG)
    await user.click(screen.getByRole('button', { name: '新しい会話' }))
    await waitFor(() => expect(screen.getByText('0 件')).toBeTruthy())
    await sendText(user, 'three')
    await screen.findByText('c', {}, LONG)

    const [first, second, third] = [sentBody(0), sentBody(1), sentBody(2)]
    expect(first.id).toBeTruthy()
    // 同じ会話の間は id が変わらず、「新しい会話」のあとだけ新しい id になる
    expect(second.id).toBe(first.id)
    expect(third.id).toBeTruthy()
    expect(third.id).not.toBe(first.id)
    expect(third.messages).toHaveLength(1)
    expect(third.messages[0]?.parts).toEqual([{ type: 'text', text: 'three' }])
  })

  it('生成中の「新しい会話」は中断してから消す', async () => {
    let signal: AbortSignal | undefined
    stubFetch((_url, init) => {
      signal = init.signal ?? undefined
      return hangingReply(init, [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '流れています' },
      ])
    })
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'こんにちは')
    await screen.findByText('流れています', {}, LONG)
    await user.click(screen.getByRole('button', { name: '新しい会話' }))

    await waitFor(() => expect(screen.getByText('0 件')).toBeTruthy(), LONG)
    await waitFor(() => expect(statusBadge().dataset.status).toBe('ready'), LONG)
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByText('流れています')).toBeNull()
  })

  it('「再生成」はアシスタントの応答を取り直す', async () => {
    stubFetch(
      () => textReply('一回目'),
      () => textReply('二回目'),
    )
    const user = userEvent.setup()
    renderChat()

    const regenerate = screen.getByRole('button', { name: '再生成' }) as HTMLButtonElement
    expect(regenerate.disabled).toBe(true)

    await sendText(user, 'こんにちは')
    await screen.findByText('一回目', {}, LONG)
    await waitFor(() => expect(regenerate.disabled).toBe(false))
    await user.click(regenerate)

    expect(await screen.findByText('二回目', {}, LONG)).toBeTruthy()
    expect(screen.queryByText('一回目')).toBeNull()
    expect(sentBody(1).trigger).toBe('regenerate-message')
  })
})

describe('ChatView: 表示', () => {
  it('Markdown 表示を切り替えると、アシスタントの本文が生テキストになる', async () => {
    stubFetch(() => textReply('**太字** です'))
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'こんにちは')
    await screen.findByText('**太字** です', {}, LONG)
    expect(screen.getAllByTestId('streamdown')).toHaveLength(1)

    const toggle = screen.getByRole('switch', { name: 'Markdown 表示' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await user.click(toggle)

    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByTestId('streamdown')).toBeNull()
    const raw = screen.getByText('**太字** です')
    expect(raw.hasAttribute('data-raw-text')).toBe(true)
    expect(raw.className).toContain('whitespace-pre-wrap')

    await user.click(toggle)
    expect(screen.getAllByTestId('streamdown')).toHaveLength(1)
  })

  it('メッセージ JSON ダイアログに messages が表示される', async () => {
    stubFetch(() => textReply('JSON で確認'))
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'こんにちは')
    await screen.findByText('JSON で確認', {}, LONG)
    await user.click(screen.getByRole('button', { name: 'メッセージ JSON' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('メッセージ JSON', { selector: 'h2' })).toBeTruthy()
    expect(within(dialog).getByText(/"text": "JSON で確認"/)).toBeTruthy()
    expect(within(dialog).getByText(/"role": "assistant"/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'JSON をコピー' })).toBeTruthy()
  })

  it('巨大な JSON（ツール出力・data パート・メッセージ JSON）は色付けせず、全文を素のテキストで見せる', async () => {
    const huge = 'x'.repeat(30_000)
    stubFetch(() =>
      sseResponse(
        messageChunks(
          stepChunks([
            {
              type: 'tool-input-available',
              toolCallId: 'call_big',
              toolName: 'getBigData',
              input: { city: 'Tokyo' },
            },
            { type: 'tool-output-available', toolCallId: 'call_big', output: { blob: huge } },
            { type: 'data-big', id: 'd1', data: { blob: huge } },
            ...textChunks('末尾のメッセージ', 't9'),
          ]),
        ),
      ),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'big')
    await screen.findByText('末尾のメッセージ', {}, LONG)
    await waitFor(() => expect(statusBadge().dataset.status).toBe('ready'))
    await expand(user, await screen.findByRole('button', { name: /getBigData/ }))

    const modes = (root: ParentNode) =>
      Array.from(root.querySelectorAll('[data-json-block]')).map((el) =>
        el.getAttribute('data-json-block'),
      )
    // 小さい入力は色付け、30,000 文字の出力と data パートは素のテキスト
    const conversation = document.querySelector('[data-role="assistant"]') as HTMLElement
    expect(modes(conversation)).toEqual(['highlighted', 'plain', 'plain'])
    expect(conversation.querySelectorAll('[data-json-block=plain] pre span')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'メッセージ JSON' }))
    const dialog = await screen.findByRole('dialog')
    expect(modes(dialog)).toEqual(['plain'])
    expect(within(dialog).getByText(/色付けは省略/)).toBeTruthy()
    // 先頭だけに切り詰めず、最後のメッセージまで読める。コピーも全文
    const shown = dialog.querySelector('pre')?.textContent ?? ''
    expect(shown).toContain('末尾のメッセージ')
    await user.click(within(dialog).getByRole('button', { name: 'JSON をコピー' }))
    expect(await navigator.clipboard.readText()).toBe(shown)
  })

  it('受信中の data パートとツール入力は色付けを止め、止まったあとに色付けする', async () => {
    stubFetch((_url, init) =>
      hangingReply(init, [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'data-weather', id: 'd1', data: { city: 'Tokyo' } },
        { type: 'tool-input-start', toolCallId: 'call_s1', toolName: 'getWeather' },
        { type: 'tool-input-delta', toolCallId: 'call_s1', inputTextDelta: '{"city":"To' },
      ]),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'stream')
    await waitFor(() => expect(statusBadge().dataset.status).toBe('streaming'), LONG)
    await expand(user, await screen.findByRole('button', { name: /getWeather/ }, LONG))

    const modes = () =>
      Array.from(document.querySelectorAll('[data-json-block]')).map((el) =>
        el.getAttribute('data-json-block'),
      )
    await waitFor(() => expect(modes()).toEqual(['plain', 'plain']))

    await user.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(statusBadge().dataset.status).toBe('ready'), LONG)
    // 中断後は input-streaming が残っていても、更新されていないので色付けに戻る
    await waitFor(() => expect(modes()).toEqual(['highlighted', 'highlighted']))
  })

  it('source / data / metadata / file / 複数ステップをまとめて描画できる', async () => {
    const png = `data:image/png;base64,${'A'.repeat(40)}`
    stubFetch(() =>
      sseResponse([
        { type: 'start', messageMetadata: { model: 'mock-model' } },
        ...stepChunks([
          ...textChunks('資料です。'),
          {
            type: 'source-url',
            sourceId: 's1',
            url: 'https://ai-sdk.dev/docs',
            title: 'AI SDK Docs',
          },
          { type: 'source-url', sourceId: 's2', url: 'javascript:alert(1)', title: '怪しいリンク' },
          {
            type: 'source-document',
            sourceId: 'd1',
            mediaType: 'application/pdf',
            title: '設計メモ',
            filename: 'notes.pdf',
          },
          { type: 'data-weather', id: 'w1', data: { city: 'Tokyo', status: 'done' } },
          { type: 'data-weather', id: 'w1', data: { city: 'Tokyo', status: 'updated' } },
          { type: 'data-notification', data: { message: 'transient' }, transient: true },
        ]),
        ...stepChunks([
          { type: 'file', url: png, mediaType: 'image/png' },
          { type: 'file', url: 'data:application/pdf;base64,QUJD', mediaType: 'application/pdf' },
        ]),
        { type: 'finish', finishReason: 'stop', messageMetadata: { usage: { totalTokens: 46 } } },
      ]),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, '#sources')
    await screen.findByText('資料です。', {}, LONG)

    // ソースは 1 ブロックにまとまる（URL 2 件 + ドキュメント 1 件）
    const sourcesTrigger = await screen.findByRole('button', { name: /3 件のソースを参照/ })
    await expand(user, sourcesTrigger)
    const docs = await screen.findByRole('link', { name: 'AI SDK Docs' })
    expect(docs.getAttribute('href')).toBe('https://ai-sdk.dev/docs')
    // javascript: はリンクにしない
    expect(screen.queryByRole('link', { name: '怪しいリンク' })).toBeNull()
    expect(screen.getByText('怪しいリンク')).toBeTruthy()
    expect(screen.getByText('設計メモ')).toBeTruthy()

    // data パートは type 名ラベルつきで、同じ id は 1 つに更新される。transient は残らない
    expect(screen.getAllByText('data-weather')).toHaveLength(1)
    expect(screen.getByText(/"status": "updated"/)).toBeTruthy()
    expect(screen.queryByText(/transient/)).toBeNull()

    // 2 ステップ目の区切りと、画像 / 非画像ファイル
    expect(screen.getByText('ステップ 2')).toBeTruthy()
    const image = document.querySelector('img')
    expect(image?.getAttribute('src')).toBe(png)
    expect(screen.getByText('application/pdf')).toBeTruthy()
    // ファイル名が無いパートは、AI Elements の英語ラベルではなく日本語の既定名で表示する
    expect(screen.getByRole('img', { name: '画像' })).toBeTruthy()
    expect(screen.getByText('ファイル')).toBeTruthy()
    expect(screen.queryByText('Attachment')).toBeNull()

    // メタデータは折りたたみ（start と finish の内容がマージされる）
    const metadata = screen.getByRole('button', { name: 'メタデータ' })
    await expand(user, metadata)
    expect(await screen.findByText(/"model": "mock-model"/)).toBeTruthy()
    expect(screen.getByText(/"totalTokens": 46/)).toBeTruthy()
  })

  it('未知のパート（custom）が来ても落ちず、フォールバック表示になる', async () => {
    stubFetch(() =>
      sseResponse(
        messageChunks(
          stepChunks([
            { type: 'custom', kind: 'acme.widget' },
            ...textChunks('それでも本文は出ます'),
          ]),
        ),
      ),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'こんにちは')
    expect(await screen.findByText('未対応のパート: custom', {}, LONG)).toBeTruthy()
    expect(screen.getByText(/"kind": "acme.widget"/)).toBeTruthy()
    expect(screen.getByText('それでも本文は出ます')).toBeTruthy()
  })
})

describe('ChatMessage: 壊れたパートでも会話全体は落ちない', () => {
  const actions: ChatActions = {
    markdown: true,
    addToolOutput: vi.fn(),
    addToolError: vi.fn(),
    respondToApproval: vi.fn(),
  }

  function renderMessage(parts: unknown[]) {
    return render(
      <ActionsProvider>
        <ChatMessage
          message={{ id: 'm1', role: 'assistant', parts: parts as never }}
          isLastMessage={false}
          chatStatus={undefined}
        />
      </ActionsProvider>,
    )
  }

  function ActionsProvider({ children }: { children: ReactNode }) {
    return <ActionsContextProvider>{children}</ActionsContextProvider>
  }

  function ActionsContextProvider({ children }: { children: ReactNode }) {
    return <ChatActionsContext.Provider value={actions}>{children}</ChatActionsContext.Provider>
  }

  it('SDK にない型のパートは「未対応のパート」として JSON で見せる', () => {
    renderMessage([
      { type: 'future-part', payload: { a: 1 } },
      { type: 'text', text: '本文' },
    ])
    expect(screen.getByText('未対応のパート: future-part')).toBeTruthy()
    expect(screen.getByText(/"payload"/)).toBeTruthy()
    expect(screen.getByText('本文')).toBeTruthy()
  })

  it('必須フィールドが欠けたパートも未対応として扱う', () => {
    renderMessage([{ type: 'tool-foo' }, null, 42])
    expect(screen.getByText('未対応のパート: tool-foo')).toBeTruthy()
    expect(screen.getAllByText('未対応のパート: (type なし)')).toHaveLength(2)
  })

  it('描画中に例外が出たパートはそのパートだけフォールバックになる', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // data パートの id にオブジェクトが入っていると React の子要素として描画できず例外になる
    renderMessage([
      { type: 'data-broken', id: { nested: true }, data: 1 },
      { type: 'text', text: '無事なパート' },
    ])
    expect(screen.getByText('パートの描画に失敗しました')).toBeTruthy()
    expect(screen.getByText('無事なパート')).toBeTruthy()
    consoleError.mockRestore()
  })

  it('中身が空のメッセージには案内を出す', () => {
    renderMessage([{ type: 'step-start' }])
    expect(screen.getByText('（表示できる内容がありません）')).toBeTruthy()
  })
})

describe('ChatView: 入力欄', () => {
  it('Enter で送信し、Shift+Enter では送信しない', async () => {
    stubFetch(() => textReply('ok'))
    renderChat()

    fireEvent.change(textbox(), { target: { value: 'こんにちは' } })
    fireEvent.keyDown(textbox(), { key: 'Enter', shiftKey: true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(chatCalls()).toHaveLength(0)

    fireEvent.keyDown(textbox(), { key: 'Enter' })
    await waitFor(() => expect(chatCalls()).toHaveLength(1))
    expect(sentBody(0).messages[0]?.parts).toEqual([{ type: 'text', text: 'こんにちは' }])
    await screen.findByText('ok', {}, LONG)
    // 送信後は入力欄が空になる
    expect(textbox().value).toBe('')
  })

  it('IME の変換確定 Enter では送信しない（isComposing / compositionstart / keyCode 229）', async () => {
    stubFetch(() => textReply('ok'))
    renderChat()

    fireEvent.change(textbox(), { target: { value: 'にほんご' } })
    fireEvent.keyDown(textbox(), { key: 'Enter', isComposing: true })
    fireEvent.compositionStart(textbox())
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    fireEvent.compositionEnd(textbox())
    // Safari: compositionend の後に isComposing: false の keydown(229) が来る
    fireEvent.keyDown(textbox(), { key: 'Enter', keyCode: 229 })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(chatCalls()).toHaveLength(0)
    expect(textbox().value).toBe('にほんご')

    // 確定後の通常の Enter は送信される
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    await waitFor(() => expect(chatCalls()).toHaveLength(1))
  })

  it('空（空白だけ）のメッセージは送れない', async () => {
    stubFetch(() => textReply('ok'))
    const user = userEvent.setup()
    renderChat()

    const submit = screen.getByRole('button', { name: '送信' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    await user.type(textbox(), '   ')
    expect(submit.disabled).toBe(true)
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(chatCalls()).toHaveLength(0)

    await user.type(textbox(), 'a')
    expect(submit.disabled).toBe(false)
  })

  it('添付ファイルは sendMessage({ text, files }) の file パートとして送られる', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock-attachment')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    stubFetch(() => textReply('画像を受け取りました'))
    const user = userEvent.setup()
    renderChat()

    const file = new File(['abc'], 'photo.png', { type: 'image/png' })
    const input = document.querySelector('input[type="file"]')
    expect(input).toBeInstanceOf(HTMLInputElement)
    if (!(input instanceof HTMLInputElement)) return
    fireEvent.change(input, { target: { files: [file] } })

    expect(await screen.findByText('photo.png')).toBeTruthy()
    // 本文が空でも添付だけで送れる
    const submit = screen.getByRole('button', { name: '送信' }) as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    await user.type(textbox(), 'これは何？')
    await user.click(submit)

    expect(await screen.findByText('画像を受け取りました', {}, LONG)).toBeTruthy()
    const parts = sentBody(0).messages[0]?.parts ?? []
    expect(parts[0]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      filename: 'photo.png',
      url: 'data:image/png;base64,YWJj',
    })
    expect(parts[1]).toEqual({ type: 'text', text: 'これは何？' })
    // 入力欄の添付は消え、送信したメッセージには画像として残る
    expect(screen.queryByText('photo.png')).toBeNull()
    expect(screen.getAllByRole('img', { name: 'photo.png' })).toHaveLength(1)
  })
})

describe('ChatView: サジェスト', () => {
  it('chat-ui のシナリオ用チップをクリックすると #name つきで即送信される', async () => {
    stubFetch(() => textReply('天気です'))
    const user = userEvent.setup()
    renderChat()

    expect(
      screen.getByText('モックサーバー以外では普通のメッセージとして送信されます。'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: '#client-tool' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '#tool' }))

    expect(await screen.findByText('天気です', {}, LONG)).toBeTruthy()
    expect(sentBody(0).messages[0]?.parts).toEqual([
      { type: 'text', text: '#tool 東京の天気を教えて' },
    ])
    // 送信後は空状態のチップが消える
    expect(screen.queryByRole('button', { name: '#tool' })).toBeNull()
  })

  it('一般的な例文もクリックで送信できる', async () => {
    stubFetch(() => textReply('はじめまして'))
    const user = userEvent.setup()
    renderChat()

    await user.click(screen.getByRole('button', { name: '自己紹介をしてください' }))
    await screen.findByText('はじめまして', {}, LONG)
    expect(sentBody(0).messages[0]?.parts).toEqual([
      { type: 'text', text: '自己紹介をしてください' },
    ])
  })
})

describe('ChatView: 設定の反映', () => {
  it('会話を保ったまま、設定変更が次の送信のヘッダー・宛先・追加 body に反映される', async () => {
    stubFetch(
      () => textReply('一回目の応答'),
      () => textReply('二回目の応答'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'one')
    await screen.findByText('一回目の応答', {}, LONG)
    expect(headersOf(0)['x-test']).toBeUndefined()

    settingsStore.update((prev) => ({
      ...prev,
      headers: [newHeaderEntry({ name: 'X-Test', value: 'hello' })],
      bearerToken: 'secret-token',
      extraBody: '{"scenario": "echo"}',
      endpoints: { ...prev.endpoints, 'chat-ui': 'http://other.test/v2/chat' },
    }))

    await sendText(user, 'two')
    await screen.findByText('二回目の応答', {}, LONG)

    expect(chatCalls()[1]?.[0]).toBe('http://other.test/v2/chat')
    expect(headersOf(1)['x-test']).toBe('hello')
    expect(headersOf(1).authorization).toBe('Bearer secret-token')
    const second = sentBody(1) as { messages: SentMessage[]; scenario?: string }
    expect(second.scenario).toBe('echo')
    // 履歴は維持されている（user, assistant, user）
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(screen.getByText('一回目の応答')).toBeTruthy()
  })

  it('「最後の 1 件のみ送信」も次の送信から効く', async () => {
    stubFetch(
      () => textReply('a'),
      () => textReply('b'),
    )
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'one')
    await screen.findByText('a', {}, LONG)
    settingsStore.update({ sendLastMessageOnly: true })
    await sendText(user, 'two')
    await screen.findByText('b', {}, LONG)

    expect(sentBody(1).messages).toHaveLength(1)
    expect(sentBody(1).messages[0]?.parts).toEqual([{ type: 'text', text: 'two' }])
  })

  it('エンドポイントが不正なら送信前の失敗としてエラーバナーに出る', async () => {
    stubFetch(() => textReply('届かない'))
    settingsStore.update((prev) => ({ ...prev, endpoints: { ...prev.endpoints, 'chat-ui': '' } }))
    const user = userEvent.setup()
    renderChat()

    await sendText(user, 'x')
    const alert = await screen.findByRole('alert', {}, LONG)
    expect(within(alert).getByTestId('chat-error-message').textContent).toContain(
      'エンドポイントを入力してください',
    )
    expect(chatCalls()).toHaveLength(0)
  })
})

describe('ChatView: chat-text', () => {
  it('Text Stream のレスポンスをそのままテキストとして表示する', async () => {
    stubFetch(
      () =>
        new Response('こんにちは、テキストストリームです', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    )
    const user = userEvent.setup()
    renderChat('chat-text')

    // chat-text のシナリオは text / slow / echo だけ
    expect(screen.getByRole('button', { name: '#slow' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '#tool' })).toBeNull()
    expect(screen.getByText(/Text Stream は応答をテキストとして/)).toBeTruthy()

    await sendText(user, 'やあ')
    expect(await screen.findByText('こんにちは、テキストストリームです', {}, LONG)).toBeTruthy()
    expect(chatCalls()[0]?.[0]).toBe(ENDPOINTS['chat-text'])
    expect(sentBody(0).messages[0]?.parts).toEqual([{ type: 'text', text: 'やあ' }])
  })

  it('chat-ui と chat-text は独立した会話状態を持つ', async () => {
    stubFetch(() => textReply('UI の応答'))
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <div style={{ height: 400 }} data-testid="ui">
          <ChatView mode="chat-ui" />
        </div>
        <div style={{ height: 400 }} data-testid="text">
          <ChatView mode="chat-text" />
        </div>
      </TooltipProvider>,
    )

    const uiPane = within(screen.getByTestId('ui'))
    const textPane = within(screen.getByTestId('text'))
    await user.type(uiPane.getByRole('textbox', { name: 'メッセージ' }), 'ui だけ')
    await user.click(uiPane.getByRole('button', { name: '送信' }))

    await uiPane.findByText('UI の応答', {}, LONG)
    expect(textPane.queryByText('UI の応答')).toBeNull()
    expect(textPane.getByText('0 件')).toBeTruthy()
  })
})
