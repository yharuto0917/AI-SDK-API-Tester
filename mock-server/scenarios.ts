/**
 * モックバックエンドの応答シナリオ（チャンク列の生成）。
 * ここは HTTP に触れない純粋なロジックで、app.ts が ScenarioPlan を解釈して実際に書き出す。
 */
import { randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { UIMessageChunk } from 'ai'
import { createGradientPngDataUrl, MARKDOWN_SAMPLE } from './fixtures.ts'

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** app.ts がパースしたリクエスト。 */
export interface MockRequest {
  method: string
  /** クエリを除いたパス */
  path: string
  /** クエリ込みのリクエスト URL */
  url: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  rawBody: string
  /** JSON オブジェクトとしてパースできたときだけ入る */
  body: Record<string, unknown> | undefined
}

export interface ScenarioContext extends MockRequest {
  /** body.messages を緩く読んだもの（useChat の既定ボディ想定） */
  messages: LooseMessage[]
  /** 最後のユーザーメッセージ（なければ body.prompt）の本文。`#シナリオ名` トークンは除去済み */
  userText: string
}

export interface LooseMessage {
  id?: string
  role: string
  parts: Record<string, unknown>[]
}

/** SSE（UI Message Stream）に書き出す 1 ステップ。delayMs は書く前の待ち時間。 */
export type SseStep = { delayMs?: number } & (
  | { chunk: UIMessageChunk }
  /** `data: <raw>` をそのまま書く（不正な JSON を混ぜる用） */
  | { raw: string }
  /** `: <comment>` 形式の SSE コメント行 */
  | { comment: string }
  /** ソケットを切断する */
  | { destroy: true }
)

/** プレーンテキストストリームに書き出す 1 ステップ。 */
export type TextStep = { delayMs?: number } & ({ text: string } | { destroy: true })

export interface SsePlan {
  format: 'sse'
  steps: SseStep[]
  /** x-vercel-ai-ui-message-stream ヘッダーを付けない */
  omitStreamHeader?: boolean
  /** 末尾の `data: [DONE]` を付けない */
  omitDone?: boolean
}

export interface TextPlan {
  format: 'text'
  steps: TextStep[]
}

export interface JsonPlan {
  format: 'json'
  status: number
  headers?: Record<string, string>
  body: unknown
}

export type ScenarioPlan = SsePlan | TextPlan | JsonPlan

export interface ChatScenario {
  name: string
  description: string
  build: (ctx: ScenarioContext) => ScenarioPlan
}

/** 1 回に流す文字列。 */
export interface Piece {
  text: string
  delayMs?: number
}

export type SimpleOutcome =
  | {
      format: 'pieces'
      pieces: Piece[]
      /** 途中で失敗する。SSE ではエラーチャンク、プレーンテキストでは接続切断になる */
      fail?: boolean
    }
  | JsonPlan

/** /api/text と /api/completion で共有する、テキストだけのシナリオ。 */
export interface SimpleScenario {
  name: string
  description: string
  build: (ctx: ScenarioContext) => SimpleOutcome
}

// ---------------------------------------------------------------------------
// リクエストの読み取り
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readMessages(body: Record<string, unknown> | undefined): LooseMessage[] {
  const raw = body?.messages
  if (!Array.isArray(raw)) return []
  const messages: LooseMessage[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.role !== 'string') continue
    let parts: Record<string, unknown>[] = []
    if (Array.isArray(item.parts)) {
      parts = item.parts.filter(isRecord)
    } else if (typeof item.content === 'string') {
      // 旧形式（content 文字列）のクライアントも受け付ける
      parts = [{ type: 'text', text: item.content }]
    }
    messages.push({
      role: item.role,
      parts,
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
    })
  }
  return messages
}

function messageText(target: LooseMessage): string {
  return target.parts
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/** 最後のユーザーメッセージの本文。メッセージがなければ body.prompt（useCompletion）を使う。 */
export function readUserText(
  body: Record<string, unknown> | undefined,
  messages: LooseMessage[],
): string {
  const lastUser = messages.findLast((m) => m.role === 'user')
  if (lastUser !== undefined) return messageText(lastUser)
  return typeof body?.prompt === 'string' ? body.prompt : ''
}

/** 末尾が assistant メッセージのとき（= 継続リクエスト）、そのツールパートを返す。 */
function findContinuationToolPart(
  messages: LooseMessage[],
  toolName: string,
): Record<string, unknown> | undefined {
  const last = messages.at(-1)
  if (last?.role !== 'assistant') return undefined
  return last.parts.findLast((part) => part.type === `tool-${toolName}`)
}

// ---------------------------------------------------------------------------
// シナリオ選択
// ---------------------------------------------------------------------------

export type ScenarioSource = 'body' | 'query' | 'token' | 'default'

export type ScenarioSelection<T> =
  | { ok: true; scenario: T; source: ScenarioSource; userText: string }
  | { ok: false; requested: string; source: 'body' | 'query' }

const TOKEN_PATTERN = /^\s*#([A-Za-z0-9_-]+)(?:\s+|$)/

/**
 * シナリオの選択。優先順は body.scenario → ?scenario= → 本文先頭の `#名前` → 既定。
 * body / query で明示した名前が未知ならエラー、`#` トークンは未知なら普通の文字として扱う（`#hashtag` を送れるように）。
 */
export function selectScenario<T extends { name: string }>(options: {
  scenarios: readonly T[]
  defaultName: string
  body: Record<string, unknown> | undefined
  query: URLSearchParams
  userText: string
}): ScenarioSelection<T> {
  const { scenarios, defaultName, body, query, userText } = options
  const find = (name: string) => scenarios.find((s) => s.name === name)

  const explicit: { name: string; source: 'body' | 'query' } | undefined =
    typeof body?.scenario === 'string' && body.scenario !== ''
      ? { name: body.scenario, source: 'body' }
      : (query.get('scenario') ?? '') !== ''
        ? { name: query.get('scenario') ?? '', source: 'query' }
        : undefined
  if (explicit !== undefined) {
    const scenario = find(explicit.name)
    return scenario === undefined
      ? { ok: false, requested: explicit.name, source: explicit.source }
      : { ok: true, scenario, source: explicit.source, userText }
  }

  const token = TOKEN_PATTERN.exec(userText)
  const tokenScenario = token?.[1] === undefined ? undefined : find(token[1])
  if (token !== null && tokenScenario !== undefined) {
    return {
      ok: true,
      scenario: tokenScenario,
      source: 'token',
      userText: userText.slice(token[0].length),
    }
  }

  const fallback = find(defaultName)
  if (fallback === undefined) throw new Error(`既定のシナリオ ${defaultName} が見つかりません`)
  return { ok: true, scenario: fallback, source: 'default', userText }
}

// ---------------------------------------------------------------------------
// チャンク組み立てのヘルパー
// ---------------------------------------------------------------------------

const TEXT_ID = 'text-1'

const segmenter = new Intl.Segmenter('ja', { granularity: 'word' })

/** 単語（日本語は ICU の分かち書き）ごとに分割する。空白は直前の単語に付ける。連結すると元の文字列に戻る。 */
export function splitWords(text: string): string[] {
  const words: string[] = []
  for (const { segment } of segmenter.segment(text)) {
    const previous = words.at(-1)
    if (previous !== undefined && segment.trim() === '') {
      words[words.length - 1] = previous + segment
    } else {
      words.push(segment)
    }
  }
  return words
}

function splitEvenly(text: string, count: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / count))
  const parts: string[] = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts
}

function textParts(text: string, delayMs: number, id = TEXT_ID): SseStep[] {
  return [
    { chunk: { type: 'text-start', id } },
    ...splitWords(text).map((delta): SseStep => ({
      delayMs,
      chunk: { type: 'text-delta', id, delta },
    })),
    { chunk: { type: 'text-end', id } },
  ]
}

function reasoningParts(text: string, delayMs: number, id = 'reasoning-1'): SseStep[] {
  return [
    { chunk: { type: 'reasoning-start', id } },
    ...splitWords(text).map((delta): SseStep => ({
      delayMs,
      chunk: { type: 'reasoning-delta', id, delta },
    })),
    { chunk: { type: 'reasoning-end', id } },
  ]
}

/** start-step 〜 finish-step で囲む（1 回の LLM 呼び出し相当）。 */
function step(inner: SseStep[]): SseStep[] {
  return [{ chunk: { type: 'start-step' } }, ...inner, { chunk: { type: 'finish-step' } }]
}

/**
 * start 〜 finish で囲む。messageId は付けない（継続リクエストでは既存の assistant メッセージに追記され、
 * 新規のときはクライアントが採番する。ここで新しい ID を返すと継続時にメッセージが二重になる）。
 */
function message(
  inner: SseStep[],
  options: {
    startMetadata?: unknown
    finishMetadata?: unknown
    finishReason?: 'stop' | 'tool-calls'
  } = {},
): SseStep[] {
  return [
    {
      chunk: {
        type: 'start',
        ...(options.startMetadata === undefined ? {} : { messageMetadata: options.startMetadata }),
      },
    },
    ...inner,
    {
      chunk: {
        type: 'finish',
        finishReason: options.finishReason ?? 'stop',
        ...(options.finishMetadata === undefined
          ? {}
          : { messageMetadata: options.finishMetadata }),
      },
    },
  ]
}

function sse(steps: SseStep[], options: Omit<SsePlan, 'format' | 'steps'> = {}): SsePlan {
  return { format: 'sse', steps, ...options }
}

function newToolCallId(): string {
  return `call_${randomUUID().slice(0, 8)}`
}

/** tool-input-start → tool-input-delta… → tool-input-available。 */
function toolCall(toolCallId: string, toolName: string, input: unknown): SseStep[] {
  return [
    { chunk: { type: 'tool-input-start', toolCallId, toolName } },
    ...splitEvenly(JSON.stringify(input), 3).map((inputTextDelta): SseStep => ({
      delayMs: 60,
      chunk: { type: 'tool-input-delta', toolCallId, inputTextDelta },
    })),
    { chunk: { type: 'tool-input-available', toolCallId, toolName, input } },
  ]
}

function replyText(userText: string): string {
  const quoted = userText.trim() === '' ? '' : `「${userText.trim()}」を受け取りました。`
  return `こんにちは！AI SDK API Tester のモックバックエンドです。${quoted}This reply is streamed word by word, so you can watch it arrive.`
}

// ---------------------------------------------------------------------------
// 認証
// ---------------------------------------------------------------------------

const AUTH_TOKEN = 'test-token'

function isAuthorized(headers: IncomingHttpHeaders): boolean {
  const value = headers.authorization
  if (value === undefined) return false
  const match = /^Bearer\s+(.+)$/i.exec(value.trim())
  return match?.[1] === AUTH_TOKEN
}

function unauthorizedPlan(): JsonPlan {
  return {
    format: 'json',
    status: 401,
    headers: { 'www-authenticate': 'Bearer realm="mock-server"' },
    body: {
      error: 'unauthorized',
      message: `Authorization: Bearer ${AUTH_TOKEN} ヘッダーが必要です`,
    },
  }
}

function http500Plan(): JsonPlan {
  return {
    format: 'json',
    status: 500,
    body: { error: 'internal_server_error', message: 'モックが意図的に返した 500 エラーです' },
  }
}

function http401Plan(): JsonPlan {
  return {
    format: 'json',
    status: 401,
    headers: { 'www-authenticate': 'Bearer realm="mock-server"' },
    body: { error: 'unauthorized', message: 'モックが意図的に返した 401 エラーです' },
  }
}

// ---------------------------------------------------------------------------
// echo（受信したリクエストの内容を返す）
// ---------------------------------------------------------------------------

/** 接続単位の hop-by-hop ヘッダーだけ省き、あとは全部見せる（追加ヘッダーや Bearer の到達確認が目的）。 */
const ECHO_HIDDEN_HEADERS = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
])

const ECHO_BODY_LIMIT = 8000

function clip(text: string): string {
  return text.length > ECHO_BODY_LIMIT
    ? `${text.slice(0, ECHO_BODY_LIMIT)}\n…（${text.length - ECHO_BODY_LIMIT} 文字省略）`
    : text
}

export function buildEchoMarkdown(ctx: ScenarioContext): string {
  const headers = Object.fromEntries(
    Object.entries(ctx.headers).filter(([name]) => !ECHO_HIDDEN_HEADERS.has(name)),
  )
  const lines = [
    `## リクエストエコー`,
    '',
    `- **メソッド**: ${ctx.method}`,
    `- **URL**: ${ctx.url}`,
  ]
  if (ctx.messages.length > 0) {
    const last = ctx.messages.at(-1)
    lines.push(`- **messages**: ${ctx.messages.length} 件（最後: ${last?.role ?? '?'}）`)
  }
  if (ctx.body !== undefined) {
    const known = new Set(['id', 'messages', 'trigger', 'messageId', 'prompt'])
    const extra = Object.keys(ctx.body).filter((key) => !known.has(key))
    lines.push(`- **trigger**: ${String(ctx.body.trigger ?? '(なし)')}`)
    lines.push(`- **追加ボディキー**: ${extra.length > 0 ? extra.join(', ') : '(なし)'}`)
  }
  lines.push('', '### ヘッダー', '', '```json', JSON.stringify(headers, null, 2), '```', '')
  lines.push('### ボディ', '')
  if (ctx.rawBody === '') {
    lines.push('(なし)')
  } else {
    const pretty = ctx.body === undefined ? ctx.rawBody : JSON.stringify(ctx.body, null, 2)
    lines.push('```json', clip(pretty), '```')
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// チャット（UI Message Stream）のシナリオ
// ---------------------------------------------------------------------------

export const CHAT_SCENARIOS: readonly ChatScenario[] = [
  {
    name: 'text',
    description: '日本語 / 英語の短い応答を単語ずつ流す（基本確認・既定）',
    build: (ctx) => sse(message(step(textParts(replyText(ctx.userText), 30)))),
  },
  {
    name: 'markdown',
    description: '見出し・リスト・コードブロック・表を含む長めの Markdown 応答',
    build: () => sse(message(step(textParts(MARKDOWN_SAMPLE, 6)))),
  },
  {
    name: 'reasoning',
    description: 'reasoning パート（思考過程）の後に本文を流す',
    build: () =>
      sse(
        message(
          step([
            ...reasoningParts(
              'ユーザーの質問を整理しています。まず前提を確認し、次に答えの構成を考えます。最後に、簡潔にまとめ直します。',
              35,
            ),
            ...textParts(
              '考えた結果、このように回答します。reasoning パートが折りたたみ表示になるか確認してください。',
              30,
            ),
          ]),
        ),
      ),
  },
  {
    name: 'tool',
    description: 'サーバー実行ツール getWeather（入力ストリーム → 出力 → 2 ステップ目の本文）',
    build: () => {
      const toolCallId = newToolCallId()
      return sse(
        message([
          ...step([
            ...toolCall(toolCallId, 'getWeather', { city: 'Tokyo' }),
            {
              delayMs: 400,
              chunk: {
                type: 'tool-output-available',
                toolCallId,
                output: { city: 'Tokyo', condition: 'sunny', temperatureC: 22 },
              },
            },
          ]),
          ...step(textParts('東京の天気は晴れ、気温は 22℃ です。', 30)),
        ]),
      )
    },
  },
  {
    name: 'tool-error',
    description: 'ツール実行が失敗する（tool-output-error）→ 2 ステップ目の本文',
    build: () => {
      const toolCallId = newToolCallId()
      return sse(
        message([
          ...step([
            ...toolCall(toolCallId, 'getWeather', { city: 'Atlantis' }),
            {
              delayMs: 300,
              chunk: {
                type: 'tool-output-error',
                toolCallId,
                errorText: '天気 API がタイムアウトしました（モックの意図的なエラー）',
              },
            },
          ]),
          ...step(
            textParts('天気情報を取得できませんでした。時間をおいてもう一度お試しください。', 30),
          ),
        ]),
      )
    },
  },
  {
    name: 'client-tool',
    description:
      'クライアント実行ツール askForConfirmation（入力で終了。出力つきで再送すると最終テキストを返す）',
    build: (ctx) => {
      const part = findContinuationToolPart(ctx.messages, 'askForConfirmation')
      if (part?.state === 'output-available' || part?.state === 'output-error') {
        const result =
          part.state === 'output-available'
            ? `出力: ${JSON.stringify(part.output)}`
            : `エラー: ${String(part.errorText)}`
        return sse(
          message(
            step(
              textParts(
                `クライアント側ツールの結果を受け取りました（${result}）。続きの処理を行います。`,
                30,
              ),
            ),
          ),
        )
      }
      return sse(
        message(
          step(
            toolCall(newToolCallId(), 'askForConfirmation', {
              message: 'この操作を実行してよろしいですか？',
            }),
          ),
          { finishReason: 'tool-calls' },
        ),
      )
    },
  },
  {
    name: 'approval',
    description:
      'ツール承認フロー deleteFile（承認要求で終了。承認 / 拒否つきで再送すると出力 or denied + 本文を返す）',
    build: (ctx) => {
      const part = findContinuationToolPart(ctx.messages, 'deleteFile')
      if (part?.state === 'approval-responded' && typeof part.toolCallId === 'string') {
        const toolCallId = part.toolCallId
        const approved = isRecord(part.approval) && part.approval.approved === true
        return sse(
          message([
            approved
              ? {
                  chunk: {
                    type: 'tool-output-available',
                    toolCallId,
                    output: { deleted: true, path: '/tmp/report.txt' },
                  },
                }
              : { chunk: { type: 'tool-output-denied', toolCallId } },
            ...step(
              textParts(
                approved
                  ? 'ファイルを削除しました（モックなので実際には何も消えていません）。'
                  : '削除は拒否されたため、何も変更していません。',
                30,
              ),
            ),
          ]),
        )
      }
      const toolCallId = newToolCallId()
      return sse(
        message(
          step([
            ...toolCall(toolCallId, 'deleteFile', { path: '/tmp/report.txt' }),
            {
              chunk: {
                type: 'tool-approval-request',
                approvalId: `approval_${randomUUID().slice(0, 8)}`,
                toolCallId,
              },
            },
          ]),
          { finishReason: 'tool-calls' },
        ),
      )
    },
  },
  {
    name: 'sources',
    description: 'source-url / source-document パートを含む応答',
    build: () =>
      sse(
        message(
          step([
            ...textParts('以下の資料を参考にしました。', 30),
            {
              chunk: {
                type: 'source-url',
                sourceId: 'src-1',
                url: 'https://ai-sdk.dev/docs',
                title: 'AI SDK Documentation',
              },
            },
            {
              chunk: {
                type: 'source-url',
                sourceId: 'src-2',
                url: 'https://developer.mozilla.org/docs/Web/API/Server-sent_events',
                title: 'Server-sent events (MDN)',
              },
            },
            {
              chunk: {
                type: 'source-document',
                sourceId: 'doc-1',
                mediaType: 'application/pdf',
                title: '設計メモ',
                filename: 'design-notes.pdf',
              },
            },
          ]),
        ),
      ),
  },
  {
    name: 'file',
    description: '小さな data URL の画像（PNG）を file パートとして返す',
    build: () =>
      sse(
        message(
          step([
            ...textParts('生成した画像です。', 30),
            { chunk: { type: 'file', url: createGradientPngDataUrl(), mediaType: 'image/png' } },
          ]),
        ),
      ),
  },
  {
    name: 'data',
    description: 'data-weather（同じ id で更新）と transient な data-notification',
    build: () =>
      sse(
        message(
          step([
            {
              chunk: {
                type: 'data-weather',
                id: 'weather-1',
                data: { city: 'Tokyo', status: 'loading' },
              },
            },
            {
              delayMs: 200,
              chunk: {
                type: 'data-notification',
                data: { level: 'info', message: '天気データを取得しています' },
                transient: true,
              },
            },
            ...textParts(
              'data パートはメッセージの parts に残り、transient は onData だけに届きます。',
              30,
            ),
            {
              delayMs: 300,
              chunk: {
                type: 'data-weather',
                id: 'weather-1',
                data: { city: 'Tokyo', status: 'done', temperatureC: 22 },
              },
            },
          ]),
        ),
      ),
  },
  {
    name: 'metadata',
    description: 'start / finish に messageMetadata を含める',
    build: () =>
      sse(
        message(step(textParts('メッセージメタデータつきの応答です。', 30)), {
          startMetadata: { model: 'mock-model', startedAt: new Date().toISOString() },
          finishMetadata: {
            finishedAt: new Date().toISOString(),
            usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
          },
        }),
      ),
  },
  {
    name: 'echo',
    description:
      '受信した method / ヘッダー / body をテキストで返す（追加ヘッダー・extraBody・最後のみ送信・Bearer の確認用）',
    build: (ctx) => sse(message(step(textParts(buildEchoMarkdown(ctx), 4)))),
  },
  {
    name: 'slow',
    description: '約 400ms / トークンで 20 トークン流す（Stop ボタンの確認用。切断を検知して停止）',
    build: () =>
      sse(
        message(
          step([
            { chunk: { type: 'text-start', id: TEXT_ID } },
            ...Array.from({ length: 20 }, (_, i): SseStep => ({
              delayMs: 400,
              chunk: { type: 'text-delta', id: TEXT_ID, delta: `トークン${i + 1} ` },
            })),
            { chunk: { type: 'text-end', id: TEXT_ID } },
          ]),
        ),
      ),
  },
  {
    name: 'keepalive',
    description: '本文の合間に SSE コメント行（": ping"）を挟む',
    build: () => {
      const words = splitWords('SSE のコメント行を挟みながら、本文を少しずつ流します。')
      return sse(
        message(
          step([
            { chunk: { type: 'text-start', id: TEXT_ID } },
            ...words.flatMap((delta): SseStep[] => [
              { delayMs: 60, comment: 'ping' },
              { delayMs: 60, chunk: { type: 'text-delta', id: TEXT_ID, delta } },
            ]),
            { chunk: { type: 'text-end', id: TEXT_ID } },
          ]),
        ),
      )
    },
  },
  {
    name: 'error',
    description: '本文を途中まで流してから type:"error" チャンクを送る',
    build: () =>
      sse([
        { chunk: { type: 'start' } },
        { chunk: { type: 'start-step' } },
        { chunk: { type: 'text-start', id: TEXT_ID } },
        { delayMs: 30, chunk: { type: 'text-delta', id: TEXT_ID, delta: 'ここまでは ' } },
        { delayMs: 30, chunk: { type: 'text-delta', id: TEXT_ID, delta: '順調でした。' } },
        {
          delayMs: 200,
          chunk: { type: 'error', errorText: 'モックのエラー: ストリームの途中で失敗しました' },
        },
      ]),
  },
  {
    name: 'abort',
    description: '本文を途中まで流してからソケットを切断する',
    build: () =>
      sse([
        { chunk: { type: 'start' } },
        { chunk: { type: 'start-step' } },
        { chunk: { type: 'text-start', id: TEXT_ID } },
        { delayMs: 30, chunk: { type: 'text-delta', id: TEXT_ID, delta: '接続が ' } },
        { delayMs: 30, chunk: { type: 'text-delta', id: TEXT_ID, delta: 'このあと切れます…' } },
        { delayMs: 200, destroy: true },
      ]),
  },
  {
    name: 'no-header',
    description: 'x-vercel-ai-ui-message-stream ヘッダーなしで正常なストリームを返す',
    build: (ctx) =>
      sse(message(step(textParts(replyText(ctx.userText), 30))), { omitStreamHeader: true }),
  },
  {
    name: 'bad-json',
    description: '正常なチャンクの間に壊れた JSON の行を混ぜる',
    build: () =>
      sse([
        { chunk: { type: 'start' } },
        { chunk: { type: 'start-step' } },
        { chunk: { type: 'text-start', id: TEXT_ID } },
        { delayMs: 30, chunk: { type: 'text-delta', id: TEXT_ID, delta: '壊れた行の前 ' } },
        { delayMs: 30, raw: '{"type":"text-delta","id":"text-1","delta":"途中で切れた JSON' },
        { delayMs: 30, chunk: { type: 'text-delta', id: TEXT_ID, delta: '壊れた行の後' } },
        { chunk: { type: 'text-end', id: TEXT_ID } },
        { chunk: { type: 'finish-step' } },
        { chunk: { type: 'finish' } },
      ]),
  },
  {
    name: 'no-done',
    description: '正常なストリームだが末尾の data: [DONE] を送らない',
    build: (ctx) => sse(message(step(textParts(replyText(ctx.userText), 30))), { omitDone: true }),
  },
  {
    name: 'http-500',
    description: 'HTTP 500（JSON）を返す',
    build: () => http500Plan(),
  },
  {
    name: 'http-401',
    description: 'HTTP 401（JSON + WWW-Authenticate）を返す',
    build: () => http401Plan(),
  },
  {
    name: 'auth',
    description: 'Authorization: Bearer test-token がなければ 401、あれば正常なストリーム',
    build: (ctx) =>
      isAuthorized(ctx.headers)
        ? sse(
            message(
              step(textParts('認証に成功しました。Bearer トークンが正しく届いています。', 30)),
            ),
          )
        : unauthorizedPlan(),
  },
]

// ---------------------------------------------------------------------------
// テキストのみのシナリオ（/api/text・/api/completion 共通）
// ---------------------------------------------------------------------------

function wordPieces(text: string, delayMs: number): Piece[] {
  return splitWords(text).map((word) => ({ text: word, delayMs }))
}

export const SIMPLE_SCENARIOS: readonly SimpleScenario[] = [
  {
    name: 'text',
    description: '短い応答を単語ずつ流す（既定）',
    build: (ctx) => ({ format: 'pieces', pieces: wordPieces(replyText(ctx.userText), 30) }),
  },
  {
    name: 'slow',
    description: '約 400ms / トークンで 20 トークン流す（Stop の確認用）',
    build: () => ({
      format: 'pieces',
      pieces: Array.from({ length: 20 }, (_, i) => ({ text: `トークン${i + 1} `, delayMs: 400 })),
    }),
  },
  {
    name: 'error',
    description: '途中まで流して失敗する（data プロトコルは error チャンク、text は接続切断）',
    build: () => ({
      format: 'pieces',
      pieces: [
        { text: 'ここまでは ', delayMs: 30 },
        { text: '順調でした。', delayMs: 30 },
      ],
      fail: true,
    }),
  },
  {
    name: 'empty',
    description: '本文が空のレスポンス',
    build: () => ({ format: 'pieces', pieces: [] }),
  },
  {
    name: 'echo',
    description: '受信した method / ヘッダー / body をテキストで返す',
    build: (ctx) => ({ format: 'pieces', pieces: wordPieces(buildEchoMarkdown(ctx), 4) }),
  },
  {
    name: 'http-500',
    description: 'HTTP 500（JSON）を返す',
    build: () => http500Plan(),
  },
  {
    name: 'http-401',
    description: 'HTTP 401（JSON + WWW-Authenticate）を返す',
    build: () => http401Plan(),
  },
  {
    name: 'auth',
    description: 'Authorization: Bearer test-token がなければ 401、あれば正常',
    build: (ctx) =>
      isAuthorized(ctx.headers)
        ? { format: 'pieces', pieces: wordPieces('認証に成功しました。', 30) }
        : unauthorizedPlan(),
  },
]

/** SimpleOutcome を、書き出し形式（プレーンテキスト or SSE）に合わせた ScenarioPlan に変換する。 */
export function simpleOutcomeToPlan(outcome: SimpleOutcome, format: 'text' | 'sse'): ScenarioPlan {
  if (outcome.format === 'json') return outcome

  if (format === 'text') {
    const steps: TextStep[] = outcome.pieces.map((piece) => ({
      text: piece.text,
      ...(piece.delayMs === undefined ? {} : { delayMs: piece.delayMs }),
    }))
    // プレーンテキストにはエラーを載せる場所がないので、接続を切って失敗を表す
    if (outcome.fail === true) steps.push({ delayMs: 200, destroy: true })
    return { format: 'text', steps }
  }

  const inner: SseStep[] = []
  if (outcome.pieces.length > 0) {
    inner.push({ chunk: { type: 'text-start', id: TEXT_ID } })
    for (const piece of outcome.pieces) {
      inner.push({
        ...(piece.delayMs === undefined ? {} : { delayMs: piece.delayMs }),
        chunk: { type: 'text-delta', id: TEXT_ID, delta: piece.text },
      })
    }
    if (outcome.fail !== true) inner.push({ chunk: { type: 'text-end', id: TEXT_ID } })
  }
  if (outcome.fail === true) {
    return sse([
      { chunk: { type: 'start' } },
      { chunk: { type: 'start-step' } },
      ...inner,
      {
        delayMs: 200,
        chunk: { type: 'error', errorText: 'モックのエラー: ストリームの途中で失敗しました' },
      },
    ])
  }
  return sse(message(step(inner)))
}

export function describeScenarios(
  scenarios: readonly { name: string; description: string }[],
): { name: string; description: string }[] {
  return scenarios.map(({ name, description }) => ({ name, description }))
}
