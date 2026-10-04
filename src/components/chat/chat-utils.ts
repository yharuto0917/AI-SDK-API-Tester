import {
  getToolName,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai'
import type {
  ChatStatus,
  DataUIPart,
  DynamicToolUIPart,
  FileUIPart,
  ReasoningFileUIPart,
  ReasoningUIPart,
  SourceDocumentUIPart,
  SourceUrlUIPart,
  TextUIPart,
  ToolUIPart,
  UIDataTypes,
  UIMessage,
} from 'ai'
import type { Mode } from '@/types'

// ---------------------------------------------------------------------------
// 基本型
// ---------------------------------------------------------------------------

/** ChatView が扱うモード。 */
export type ChatMode = Extract<Mode, 'chat-ui' | 'chat-text'>

export type ToolPart = ToolUIPart | DynamicToolUIPart
export type ToolState = ToolPart['state']
export type SourcePart = SourceUrlUIPart | SourceDocumentUIPart
export type FilePart = FileUIPart | ReasoningFileUIPart

/** 画面上の色味。実際の Tailwind クラスは TONE_BADGE_CLASS で決める。 */
export type Tone = 'success' | 'warning' | 'info' | 'danger' | 'muted'

/** 成功 / 警告 / 情報だけ色を足す。色の直書きを避け、ライト・ダーク両方のクラスを必ず持たせる。 */
export const TONE_BADGE_CLASS: Record<Tone, string> = {
  success: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  info: 'bg-sky-500/10 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400',
  danger: 'bg-destructive/10 text-destructive dark:bg-destructive/20',
  muted: 'bg-muted text-muted-foreground',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// ステータス / ツール状態の表示用メタ情報
// ---------------------------------------------------------------------------

export const CHAT_STATUS_META: Record<ChatStatus, { label: string; tone: Tone }> = {
  ready: { label: '待機中', tone: 'success' },
  submitted: { label: '送信中', tone: 'warning' },
  streaming: { label: '受信中', tone: 'info' },
  error: { label: 'エラー', tone: 'danger' },
}

/** 生成中（送信済みで応答完了前）か。 */
export function isChatBusy(status: ChatStatus): boolean {
  return status === 'submitted' || status === 'streaming'
}

/**
 * ツールパートの状態を日本語ラベルと色に変換する。
 * approved は approval-responded のときだけ意味を持つ（承認 / 拒否のどちらを返したか）。
 * 未知の状態でも落とさず、状態名をそのまま見せる。
 */
export function toolStateMeta(state: string, approved?: boolean): { label: string; tone: Tone } {
  switch (state) {
    case 'input-streaming':
      return { label: '入力受信中', tone: 'info' }
    case 'input-available':
      return { label: '出力待ち', tone: 'warning' }
    case 'approval-requested':
      return { label: '承認待ち', tone: 'warning' }
    case 'approval-responded':
      if (approved === true) return { label: '承認済み', tone: 'info' }
      if (approved === false) return { label: '拒否済み', tone: 'muted' }
      return { label: '応答済み', tone: 'info' }
    case 'output-available':
      return { label: '完了', tone: 'success' }
    case 'output-error':
      return { label: 'エラー', tone: 'danger' }
    case 'output-denied':
      return { label: '実行拒否', tone: 'muted' }
    default:
      return { label: state === '' ? '(状態なし)' : state, tone: 'muted' }
  }
}

/**
 * クライアントが出力を返す必要のあるツールか。
 * 入力は揃っているが出力がまだ無く、プロバイダー側で実行されるものではない。
 */
export function needsManualOutput(part: ToolPart): boolean {
  return part.state === 'input-available' && part.providerExecuted !== true
}

export function toolDisplayName(part: ToolPart): string {
  if (typeof part.title === 'string' && part.title !== '') return part.title
  const name = getToolName(part)
  return name === '' ? '(名前なし)' : name
}

/** 最後のメッセージで、いま実際にストリーミングされているパートか（中断後に残る state: 'streaming' を除く）。 */
export function isPartStreaming(
  part: { state?: string },
  ctx: { chatStatus: ChatStatus | undefined; isLastMessage: boolean },
): boolean {
  return ctx.isLastMessage && ctx.chatStatus === 'streaming' && part.state === 'streaming'
}

/**
 * 最後のメッセージで、入力・出力がいま更新され続けているツールパートか。
 * 更新のたびに JSON を再ハイライトしないため、描画側はこの間だけ素のテキストで見せる。
 * 中断後に残る input-streaming は除く（isPartStreaming と同じ理由）。
 */
export function isToolPartStreaming(
  part: { state?: string; preliminary?: boolean },
  ctx: { chatStatus: ChatStatus | undefined; isLastMessage: boolean },
): boolean {
  if (!ctx.isLastMessage || ctx.chatStatus !== 'streaming') return false
  return (
    part.state === 'input-streaming' ||
    (part.state === 'output-available' && part.preliminary === true)
  )
}

// ---------------------------------------------------------------------------
// パートの分類と描画アイテム化
// ---------------------------------------------------------------------------

export type PartKind =
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'source-url'
  | 'source-document'
  | 'file'
  | 'reasoning-file'
  | 'step-start'
  | 'data'
  | 'unknown'

/**
 * パートの種類を判定する。必須フィールドが欠けた壊れたパートや、SDK の将来のパート型
 * （custom など）はすべて 'unknown' に落とし、描画側はフォールバック表示にする。
 */
export function classifyPart(part: unknown): PartKind {
  if (!isRecord(part) || typeof part.type !== 'string') return 'unknown'
  const { type } = part
  switch (type) {
    case 'text':
      return typeof part.text === 'string' ? 'text' : 'unknown'
    case 'reasoning':
      return typeof part.text === 'string' ? 'reasoning' : 'unknown'
    case 'source-url':
      return typeof part.url === 'string' ? 'source-url' : 'unknown'
    case 'source-document':
      return typeof part.title === 'string' ? 'source-document' : 'unknown'
    case 'file':
      return typeof part.url === 'string' && typeof part.mediaType === 'string' ? 'file' : 'unknown'
    case 'reasoning-file':
      return typeof part.url === 'string' && typeof part.mediaType === 'string'
        ? 'reasoning-file'
        : 'unknown'
    case 'step-start':
      return 'step-start'
    case 'dynamic-tool':
      return typeof part.toolCallId === 'string' && typeof part.state === 'string'
        ? 'tool'
        : 'unknown'
    default:
      if (type.startsWith('tool-')) {
        return typeof part.toolCallId === 'string' && typeof part.state === 'string'
          ? 'tool'
          : 'unknown'
      }
      if (type.startsWith('data-')) return 'data'
      return 'unknown'
  }
}

export type RenderItem =
  | { kind: 'text'; key: string; part: TextUIPart }
  | { kind: 'reasoning'; key: string; part: ReasoningUIPart }
  | { kind: 'tool'; key: string; part: ToolPart }
  | { kind: 'sources'; key: string; parts: SourcePart[] }
  | { kind: 'file'; key: string; part: FilePart }
  | { kind: 'step'; key: string; stepNumber: number }
  | { kind: 'data'; key: string; part: DataUIPart<UIDataTypes> }
  | { kind: 'unknown'; key: string; part: unknown; type: string }

/** 未対応 / 壊れたパートの種類名（表示用）。 */
export function unknownPartType(part: unknown): string {
  return isRecord(part) && typeof part.type === 'string' && part.type !== ''
    ? part.type
    : '(type なし)'
}

/**
 * message.parts を描画アイテムの列に変換する。
 * - source-url / source-document は最初の出現位置の 1 ブロックにまとめる
 * - 最初のステップより前の step-start は出さず、以降の境界に「ステップ N」を振る
 * - 中身が空のテキストパート（text-start 直後など）は出さない
 * key は parts 内の添字（同じメッセージ内で安定）。呼び出し側でメッセージ単位の接頭辞を付ける。
 */
export function buildRenderItems(parts: readonly unknown[]): RenderItem[] {
  const items: RenderItem[] = []
  let sourcesItem: Extract<RenderItem, { kind: 'sources' }> | undefined
  let stepNumber = 1

  parts.forEach((part, index) => {
    const key = String(index)
    switch (classifyPart(part)) {
      case 'text': {
        const text = part as TextUIPart
        if (text.text !== '') items.push({ kind: 'text', key, part: text })
        break
      }
      case 'reasoning':
        items.push({ kind: 'reasoning', key, part: part as ReasoningUIPart })
        break
      case 'tool':
        items.push({ kind: 'tool', key, part: part as ToolPart })
        break
      case 'source-url':
      case 'source-document': {
        const source = part as SourcePart
        if (sourcesItem === undefined) {
          sourcesItem = { kind: 'sources', key, parts: [source] }
          items.push(sourcesItem)
        } else {
          sourcesItem.parts.push(source)
        }
        break
      }
      case 'file':
      case 'reasoning-file':
        items.push({ kind: 'file', key, part: part as FilePart })
        break
      case 'step-start':
        // 最初のステップの前に区切りは要らない
        if (items.length > 0) {
          stepNumber += 1
          items.push({ kind: 'step', key, stepNumber })
        }
        break
      case 'data':
        items.push({ kind: 'data', key, part: part as DataUIPart<UIDataTypes> })
        break
      default:
        items.push({ kind: 'unknown', key, part, type: unknownPartType(part) })
    }
  })
  return items
}

/** メッセージ内のテキストパートを連結したもの（コピー用）。 */
export function messageText(message: UIMessage): string {
  return message.parts
    .map((part) => (classifyPart(part) === 'text' ? (part as TextUIPart).text : ''))
    .join('')
}

// ---------------------------------------------------------------------------
// JSON / URL の安全な扱い
// ---------------------------------------------------------------------------

/** どんな値でも例外を投げずに文字列化する（undefined / BigInt / 循環参照も可）。 */
export function safeJson(value: unknown, space = 2): string {
  if (value === undefined) return 'undefined'
  const replacer = (_key: string, v: unknown): unknown => (typeof v === 'bigint' ? `${v}n` : v)
  try {
    return JSON.stringify(value, replacer, space) ?? String(value)
  } catch {
    // 循環参照など。重複参照を [Circular] に置き換えて再試行する
    const seen = new WeakSet<object>()
    try {
      return (
        JSON.stringify(
          value,
          (key, v: unknown) => {
            if (typeof v === 'object' && v !== null) {
              if (seen.has(v)) return '[Circular]'
              seen.add(v)
            }
            return replacer(key, v)
          },
          space,
        ) ?? String(value)
      )
    } catch {
      return String(value)
    }
  }
}

const DATA_URL_DISPLAY_LIMIT = 256

/** 表示用 JSON では、巨大な data URL（画像の base64 など）を省略してハイライトの負荷を避ける。 */
export function messagesToDisplayJson(messages: readonly unknown[]): string {
  const abbreviate = (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') return `${value}n`
    if (
      typeof value === 'string' &&
      value.startsWith('data:') &&
      value.length > DATA_URL_DISPLAY_LIMIT
    ) {
      return `${value.slice(0, 64)}…（data URL ${value.length} 文字を省略）`
    }
    return value
  }
  try {
    return JSON.stringify(messages, abbreviate, 2) ?? '[]'
  } catch {
    return safeJson(messages)
  }
}

/** http(s) 以外（javascript: など）はリンクにしない。 */
export function safeExternalHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// クライアントツールの出力入力
// ---------------------------------------------------------------------------

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export type ParsedToolOutput =
  | { kind: 'empty' }
  | { kind: 'json'; value: unknown; jsonType: JsonType }
  | { kind: 'text'; value: string }

function jsonTypeOf(value: unknown): JsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'object'
  }
}

/** textarea の入力を、JSON として解釈できれば JSON 値、できなければ文字列として扱う。 */
export function parseToolOutputText(text: string): ParsedToolOutput {
  if (text.trim() === '') return { kind: 'empty' }
  try {
    const value: unknown = JSON.parse(text)
    return { kind: 'json', value, jsonType: jsonTypeOf(value) }
  } catch {
    return { kind: 'text', value: text }
  }
}

export function describeParsedOutput(parsed: ParsedToolOutput): string {
  switch (parsed.kind) {
    case 'empty':
      return '出力を入力してください'
    case 'json':
      return `JSON（${parsed.jsonType}）として送信します`
    case 'text':
      return '文字列として送信します'
  }
}

export const DEFAULT_TOOL_ERROR_TEXT = 'クライアントツールがエラーを返しました'

// ---------------------------------------------------------------------------
// 継続リクエスト（ツール出力 / 承認応答が揃った状態）
// ---------------------------------------------------------------------------

/** 最後のアシスタントメッセージが、ツール出力または承認応答が揃って再送待ちか。 */
export function hasPendingContinuation(messages: UIMessage[]): boolean {
  return (
    lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
    lastAssistantMessageIsCompleteWithApprovalResponses({ messages })
  )
}

/**
 * 本文なしの再送（引数なしの sendMessage）が、最後のメッセージではなく古いメッセージへ継続してしまう状態か。
 * SDK は末尾から見て最初に approval-responded のツールパートを持つアシスタントメッセージを継続先にする。
 * 最後のメッセージに無く、それより前に残っていると（承認に応答しないサーバーなど）、返答が古いメッセージへ追記され、
 * リクエストの messageId も末尾の内容と食い違う。公開 API には継続先を指定する手段が無い。
 */
export function hasStaleApprovalResponse(messages: readonly UIMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message?.role === 'assistant' &&
      message.parts.some(
        (part) =>
          classifyPart(part) === 'tool' && (part as ToolPart).state === 'approval-responded',
      )
    ) {
      return index !== messages.length - 1
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// エラー表示
// ---------------------------------------------------------------------------

export interface ChatErrorInfo {
  name: string
  /** JSON なら整形済み */
  message: string
  /** APICallError など HTTP ステータスを持つエラーのとき */
  statusCode?: number
}

function prettyIfJson(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return text
  }
}

export function describeChatError(error: unknown): ChatErrorInfo {
  const name = error instanceof Error ? error.name : 'Error'
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.trim() === '' ? '(メッセージなし)' : prettyIfJson(raw)
  const statusCode =
    isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : undefined
  return statusCode === undefined ? { name, message } : { name, message, statusCode }
}

// ---------------------------------------------------------------------------
// サジェスト（モックサーバーのシナリオ切り替え）
// ---------------------------------------------------------------------------

export interface ChatScenario {
  name: string
  /** `#name` の後ろに付けるサンプル本文 */
  sample: string
  description: string
}

export const CHAT_UI_SCENARIOS: readonly ChatScenario[] = [
  { name: 'text', sample: 'こんにちは', description: '短い応答を単語ずつ流す' },
  { name: 'markdown', sample: 'Markdown の例を見せて', description: '見出し・リスト・コード・表' },
  { name: 'reasoning', sample: '考え方を教えて', description: 'reasoning パート（思考過程）' },
  { name: 'tool', sample: '東京の天気を教えて', description: 'サーバー実行ツール' },
  { name: 'tool-error', sample: 'アトランティスの天気は？', description: 'ツール実行エラー' },
  {
    name: 'client-tool',
    sample: '操作を実行して',
    description: 'クライアント実行ツール（手動出力）',
  },
  { name: 'approval', sample: 'report.txt を削除して', description: 'ツール承認フロー' },
  { name: 'sources', sample: '参考資料を教えて', description: 'source-url / source-document' },
  { name: 'file', sample: '画像を生成して', description: 'file パート（画像）' },
  { name: 'data', sample: '天気データを取得して', description: 'data パート' },
  { name: 'metadata', sample: 'メタデータ付きで返して', description: 'message.metadata' },
  { name: 'echo', sample: 'リクエスト内容を返して', description: '受信リクエストのエコー' },
  { name: 'slow', sample: 'ゆっくり返して', description: '約 8 秒かけて流す（停止の確認用）' },
  { name: 'error', sample: 'エラーを起こして', description: 'ストリーム途中の error チャンク' },
]

export const CHAT_TEXT_SCENARIOS: readonly ChatScenario[] = [
  { name: 'text', sample: 'こんにちは', description: '短い応答を単語ずつ流す' },
  { name: 'slow', sample: 'ゆっくり返して', description: '約 8 秒かけて流す（停止の確認用）' },
  { name: 'echo', sample: 'リクエスト内容を返して', description: '受信リクエストのエコー' },
]

export function scenariosFor(mode: ChatMode): readonly ChatScenario[] {
  return mode === 'chat-ui' ? CHAT_UI_SCENARIOS : CHAT_TEXT_SCENARIOS
}

/** 本文先頭の `#name` でモックがシナリオを切り替える。 */
export function scenarioPrompt(scenario: ChatScenario): string {
  return `#${scenario.name} ${scenario.sample}`
}

/** モードに関係なく使える一般的な例文。 */
export const GENERAL_PROMPTS: readonly string[] = [
  'こんにちは',
  '自己紹介をしてください',
  '1 から 5 まで数えてください',
]
