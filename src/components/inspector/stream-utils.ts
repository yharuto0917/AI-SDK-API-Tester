import { truncate } from '@/lib/format'
import { clipText, countLines, formatJsonValue } from '@/components/inspector/json-utils'
import { prettyPrintJson } from '@/components/raw/raw-utils'
import type { StreamEvent, StreamEventKind } from '@/types'

// ---------------------------------------------------------------------------
// 種別・色のファミリー
// ---------------------------------------------------------------------------

/** バッジの色分け用。実際のクラスは tone-classes.ts にある。 */
export type EventFamily =
  'text' | 'tool' | 'data' | 'error' | 'lifecycle' | 'control' | 'chunk' | 'other'

const KIND_LABELS: Readonly<Record<StreamEventKind, string>> = {
  'sse-json': 'json',
  'sse-text': 'sse-text',
  'sse-done': '[DONE]',
  'sse-comment': 'comment',
  'text-chunk': 'chunk',
}

/** 種別 Select の選択肢の表示名。 */
export const KIND_FILTER_LABELS: Readonly<Record<StreamEventKind, string>> = {
  'sse-json': 'SSE (JSON)',
  'sse-text': 'SSE (非JSON)',
  'sse-done': 'SSE [DONE]',
  'sse-comment': 'SSE コメント',
  'text-chunk': 'テキストチャンク',
}

export const KIND_FILTER_ORDER: readonly StreamEventKind[] = [
  'sse-json',
  'sse-text',
  'sse-done',
  'sse-comment',
  'text-chunk',
]

/** バッジに出す文字列。type があればそれ、無ければ種別名。 */
export function eventLabel(event: Pick<StreamEvent, 'kind' | 'type'>): string {
  return event.type ?? KIND_LABELS[event.kind]
}

/** start / finish / finish-step / start-step / reset-step / abort など、ストリームの区切り。 */
function isLifecycleType(type: string): boolean {
  return (
    type === 'start' ||
    type === 'finish' ||
    type === 'abort' ||
    type === 'start-step' ||
    type === 'finish-step' ||
    type === 'reset-step'
  )
}

/** イベントを色のファミリーに分類する。 */
export function eventFamily(event: Pick<StreamEvent, 'kind' | 'type' | 'parseError'>): EventFamily {
  switch (event.kind) {
    case 'sse-done':
    case 'sse-comment':
      return 'control'
    case 'text-chunk':
      return 'chunk'
    case 'sse-text':
      // JSON として壊れている SSE は不具合の疑いが強いので赤にする
      return event.parseError !== undefined ? 'error' : 'other'
    case 'sse-json':
      break
  }
  const type = event.type
  if (type === undefined) return 'other'
  if (type === 'error') return 'error'
  if (isLifecycleType(type)) return 'lifecycle'
  if (type.startsWith('text-') || type.startsWith('reasoning-')) {
    // reasoning-file はファイルなのでテキスト系の色にはしない
    return type === 'reasoning-file' ? 'other' : 'text'
  }
  if (type.startsWith('tool-')) return 'tool'
  if (type.startsWith('data-')) return 'data'
  return 'other'
}

// ---------------------------------------------------------------------------
// 注記（行のバッジ・展開時の説明）
// ---------------------------------------------------------------------------

export type EventNoteId = 'schemaError' | 'incomplete' | 'rawTruncated' | 'parseSkipped'

/** warn は「バックエンドの不具合の疑い」、muted は「表示側の都合・補足」。 */
export type EventNoteTone = 'muted' | 'warn'

export interface EventNote {
  id: EventNoteId
  /** 行のバッジに出す短い文言 */
  label: string
  /** バッジの title と、展開したときの説明に出す日本語の文 */
  description: string
  tone: EventNoteTone
}

type NoteSource = Pick<StreamEvent, 'schemaError' | 'incomplete' | 'rawTruncated' | 'parseSkipped'>

/**
 * イベントに付ける注記。行の幅が足りずに右端が切れても重要なものが残るよう、warn（スキーマ不一致）を先頭にする。
 * 該当するフラグが無ければ空配列。
 */
export function eventNotes(event: NoteSource): EventNote[] {
  const notes: EventNote[] = []
  if (event.schemaError !== undefined) {
    notes.push({
      id: 'schemaError',
      label: 'スキーマ不一致',
      description:
        event.schemaError === ''
          ? 'SDK のスキーマ（UIMessageChunk）に合いません'
          : `SDK のスキーマ（UIMessageChunk）に合いません: ${event.schemaError}`,
      tone: 'warn',
    })
  }
  if (event.incomplete === true) {
    notes.push({
      id: 'incomplete',
      label: '未完了・SDK未受信',
      description:
        '末尾が空行で終わっていないイベントです。クライアントの SDK は受け取りません（ストリーム終了時にデバッグ用として表示しています）',
      tone: 'muted',
    })
  }
  if (event.rawTruncated === true) {
    notes.push({
      id: 'rawTruncated',
      label: '切り詰め',
      description:
        '1 件あたりの保持上限を超えたため、本文（raw）と data を途中までしか保持していません',
      tone: 'muted',
    })
  }
  if (event.parseSkipped === true) {
    notes.push({
      id: 'parseSkipped',
      label: '巨大のためJSON判定を省略',
      description:
        '巨大なため JSON かどうかの判定を省略しました（JSON として壊れているとは限りません）',
      tone: 'muted',
    })
  }
  return notes
}

/** 展開部で、注記 1 行に収める文字数の見積もり（超えた分は折り返す）。日本語は全角なので狭めに取る。 */
const NOTE_CHARS_PER_LINE = 40

/** 展開部に注記を並べたときの行数の見積もり。高さは固定値で決めるので、折り返しを多めに見て余白を確保する。 */
export function eventNoteLines(notes: readonly EventNote[]): number {
  return notes.reduce(
    (lines, note) => lines + Math.max(1, Math.ceil(note.description.length / NOTE_CHARS_PER_LINE)),
    0,
  )
}

// ---------------------------------------------------------------------------
// プレビュー
// ---------------------------------------------------------------------------

export const PREVIEW_MAX_CHARS = 80

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 改行や連続する空白を 1 つの空白にして 1 行に収める。 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 巨大な payload でも先頭だけを見て文字列化する（行ごとに全文を走査しないため）。 */
function head(text: string, max: number): string {
  return text.length > max * 4 ? text.slice(0, max * 4) : text
}

/** 一覧の 1 行に出すプレビュー。type は Badge に出るので、本文側からは省く。 */
export function eventPreview(event: StreamEvent, max: number = PREVIEW_MAX_CHARS): string {
  switch (event.kind) {
    case 'sse-done':
      return '[DONE]'
    case 'sse-comment':
      return truncate(collapseWhitespace(head(event.raw, max)), max)
    case 'text-chunk':
      // 空白や改行が見えるように JSON 文字列の形で出す
      return truncate(JSON.stringify(head(event.raw, max)), max)
    case 'sse-text':
      return truncate(collapseWhitespace(head(event.raw, max)), max)
    case 'sse-json':
      break
  }
  const data = event.data
  if (!isRecord(data)) {
    return truncate(collapseWhitespace(head(JSON.stringify(data) ?? event.raw, max)), max)
  }
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (key !== 'type') rest[key] = value
  }
  const keys = Object.keys(rest)
  if (keys.length === 0) return ''
  // text-delta / reasoning-delta はテキスト本体が読めるほうが役に立つ
  if (typeof rest.delta === 'string' && keys.every((key) => key === 'delta' || key === 'id')) {
    return truncate(JSON.stringify(head(rest.delta, max)), max)
  }
  return truncate(head(JSON.stringify(rest) ?? '', max), max)
}

// ---------------------------------------------------------------------------
// フィルタ・コピー
// ---------------------------------------------------------------------------

export type KindFilter = 'all' | StreamEventKind

export interface EventFilter {
  /** type（無ければ種別名）・SSE の event 名への部分一致。大文字小文字は区別しない */
  query: string
  kind: KindFilter
}

/** フィルタが何も絞らないか。 */
export function isFilterEmpty(filter: EventFilter): boolean {
  return filter.query.trim() === '' && filter.kind === 'all'
}

/** 何も絞らないときは元の配列をそのまま返す（5000 件のコピーを避ける）。 */
export function filterEvents(
  events: readonly StreamEvent[],
  filter: EventFilter,
): readonly StreamEvent[] {
  if (isFilterEmpty(filter)) return events
  const query = filter.query.trim().toLowerCase()
  return events.filter((event) => {
    if (filter.kind !== 'all' && event.kind !== filter.kind) return false
    if (query === '') return true
    return (
      eventLabel(event).toLowerCase().includes(query) ||
      (event.eventName?.toLowerCase().includes(query) ?? false)
    )
  })
}

/** index が昇順に並んだイベント列から、指定した index の位置を二分探索で探す（無ければ -1）。 */
export function findEventPosition(events: readonly StreamEvent[], index: number): number {
  let lo = 0
  let hi = events.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const value = (events[mid] as StreamEvent).index
    if (value === index) return mid
    if (value < index) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/** 「全イベントをJSONでコピー」用。 */
export function eventsToJson(events: readonly StreamEvent[]): string {
  return JSON.stringify(events, null, 2)
}

// ---------------------------------------------------------------------------
// 展開表示
// ---------------------------------------------------------------------------

/** 展開時に描画するテキストの上限。これを超えた分は省く。 */
export const EVENT_DETAIL_MAX_CHARS = 50_000

export interface EventDetail {
  language: 'json' | 'text'
  code: string
  clipped: boolean
}

/**
 * 展開したときに見せる中身。JSON として読めたものは整形、それ以外は raw のまま。
 * data は parse 済みで桁落ちなどが起きているので、整形は raw の空白だけを組み替えて行う（raw が読めないときだけ data）。
 */
export function eventDetail(event: StreamEvent): EventDetail {
  const useData = event.kind === 'sse-json' && event.data !== undefined
  const full = useData ? (prettyPrintJson(event.raw) ?? formatJsonValue(event.data)) : event.raw
  const { text, clipped } = clipText(full, EVENT_DETAIL_MAX_CHARS)
  return { language: useData ? 'json' : 'text', code: text, clipped }
}

const DETAIL_MIN_HEIGHT = 72
const DETAIL_MAX_HEIGHT = 280
const DETAIL_LINE_HEIGHT = 16
/** メタ情報の行 + 余白 + コードブロックの上下 padding の合計の目安 */
const DETAIL_CHROME = 64

/**
 * 展開部の高さ（px）。行数から決まる固定値で、あふれる分は内側でスクロールする。
 * noteLines は、コードの上に並べる注記の行数（eventNoteLines）。
 */
export function eventDetailHeight(code: string, noteLines = 0): number {
  const height = (countLines(code) + Math.max(0, noteLines)) * DETAIL_LINE_HEIGHT + DETAIL_CHROME
  return Math.min(DETAIL_MAX_HEIGHT, Math.max(DETAIL_MIN_HEIGHT, height))
}

// ---------------------------------------------------------------------------
// 簡易ウィンドウ描画
// ---------------------------------------------------------------------------

export const STREAM_ROW_HEIGHT = 28
export const STREAM_OVERSCAN = 8
/** DOM から高さが取れない（jsdom など）ときに仮定するビューポートの高さ */
export const FALLBACK_VIEWPORT_HEIGHT = 600

/** 行 position の下に追加で挟まる高さ（展開した行の詳細）。 */
export interface VirtualExtra {
  position: number
  height: number
}

export interface VirtualWindowInput {
  total: number
  /** 通常の 1 行の高さ */
  rowHeight: number
  scrollTop: number
  viewportHeight: number
  overscan?: number
  extras?: readonly VirtualExtra[]
}

export interface VirtualWindow {
  /** 描画する先頭の行（含む） */
  start: number
  /** 描画する末尾の行（含まない） */
  end: number
  /** start 行の上端の位置（px）。描画する行の塊をここまで下げる */
  offsetTop: number
  /** 全行を並べたときの高さ（px） */
  totalHeight: number
}

/** 有効な extras だけを position 昇順・重複なしにそろえる。 */
function normalizeExtras(
  extras: readonly VirtualExtra[] | undefined,
  total: number,
): VirtualExtra[] {
  if (extras === undefined || extras.length === 0) return []
  const byPosition = new Map<number, number>()
  for (const { position, height } of extras) {
    if (Number.isInteger(position) && position >= 0 && position < total && height > 0) {
      byPosition.set(position, height)
    }
  }
  return [...byPosition.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([position, height]) => ({ position, height }))
}

/** sorted の中で value 以上になる最初の添字（無ければ sorted.length）。 */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((sorted[mid] as number) < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 固定行高 + 「展開した行だけ追加の高さ」という並びで、スクロール位置から描画すべき行の範囲を求める。
 * 展開した行は少数なので、追加高さの累積和と二分探索で行の位置を引く。
 */
export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const total = Math.max(0, Math.floor(input.total))
  const rowHeight = Math.max(1, input.rowHeight)
  const overscan = Math.max(0, Math.floor(input.overscan ?? STREAM_OVERSCAN))
  const viewport = input.viewportHeight > 0 ? input.viewportHeight : FALLBACK_VIEWPORT_HEIGHT
  const scrollTop = Number.isFinite(input.scrollTop) ? Math.max(0, input.scrollTop) : 0

  const extras = normalizeExtras(input.extras, total)
  const positions = extras.map((extra) => extra.position)
  const cumulative = [0]
  for (const extra of extras) cumulative.push((cumulative.at(-1) as number) + extra.height)

  /** 行 i の上端。i より前にある展開部の高さを足す。 */
  const offsetOf = (i: number): number =>
    i * rowHeight + (cumulative[lowerBound(positions, i)] as number)

  const totalHeight = offsetOf(total)
  if (total === 0) return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 }

  // 下端が scrollTop を超える最初の行
  let lo = 0
  let hi = total - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsetOf(mid + 1) > scrollTop) hi = mid
    else lo = mid + 1
  }
  const first = lo

  // 上端が表示領域の下端以降になる最初の行（これが末尾の次）
  const bottom = scrollTop + viewport
  lo = first + 1
  hi = total
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsetOf(mid) >= bottom) hi = mid
    else lo = mid + 1
  }

  const start = Math.max(0, first - overscan)
  const end = Math.min(total, lo + overscan)
  return { start, end, offsetTop: offsetOf(start), totalHeight }
}
