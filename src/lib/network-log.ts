import { validateUiChunk } from '@/lib/chunk-schema'
import { DEFAULT_SSE_MAX_CHARS, createSseParser } from '@/lib/sse-parser'
import type { SseItem, SseParser } from '@/lib/sse-parser'
import { buildDiagnostics } from '@/lib/stream-analyzer'
import type { LogState, Mode, NetworkLogEntry, StreamEvent } from '@/types'

export interface BeginLogInit {
  mode: Mode
  method: string
  targetUrl: string
  viaProxy: boolean
  requestHeaders: Record<string, string>
  /** 指定されたが、ブラウザの仕様で送信されないヘッダー名（小文字） */
  droppedHeaders?: string[]
  /** 実際に送る body。保持するのは maxRequestBodyChars まで（超えたら先頭だけ残し、requestBodyTruncated を立てる） */
  requestBody?: string
}

export interface NetworkLogStore {
  /** 新しい順。変更が無い限り同じ参照を返す */
  getEntries(): readonly NetworkLogEntry[]
  getEntry(id: string): NetworkLogEntry | undefined
  getSelectedId(): string | null
  select(id: string | null): void
  clear(): void
  subscribe(listener: () => void): () => void
  /** 新しいエントリを作る（自動で選択状態になる） */
  begin(init: BeginLogInit): string
  /** ttfbMs はストア内で計算する */
  recordHead(
    id: string,
    head: { status: number; statusText: string; responseHeaders: Record<string, string> },
  ): void
  /** デコード済みのチャンクを渡す。sse なら SSE イベントに、そうでなければ text-chunk にする */
  recordText(id: string, text: string, opts: { sse: boolean }): void
  finish(
    id: string,
    result: {
      state: 'done' | 'aborted' | 'error'
      error?: { name: string; message: string; hint?: string }
    },
  ): void
}

export interface NetworkLogOptions {
  /** 保持するエントリ数の上限（超えたら古い順に捨てる）。既定 200 */
  maxEntries?: number
  /** 1 エントリが保持するイベント数の上限。既定 5000 */
  maxEvents?: number
  /** 1 エントリが保持する rawBody の文字数の上限。既定 2_000_000。イベントの raw の合計にも同じ予算を使う */
  maxBodyChars?: number
  /** リクエスト body として保持する文字数の上限。既定 200_000（超えたら先頭だけ残し、requestBodyTruncated を立てる） */
  maxRequestBodyChars?: number
  /** 1 イベントが保持する raw の文字数の上限。既定 100_000（超えたら切り詰め、data も省略版にする） */
  maxEventChars?: number
  /** SSE の 1 行・1 イベントを解析のために保持する文字数の上限。既定は DEFAULT_SSE_MAX_CHARS */
  maxParseChars?: number
  /**
   * ストア全体が保持する文字数（リクエスト body + レスポンス本文 + イベントの raw）の予算。既定 50_000_000。
   * 超えたら古いエントリから捨てる（書き込み中のエントリと選択中のエントリは残す）
   */
  maxTotalChars?: number
  /** UI Message Stream の chunk を SDK のスキーマで検証する関数。既定は validateUiChunk（テストで差し替える） */
  validateChunk?: (data: unknown) => Promise<string | undefined>
  /** atMs / ttfbMs / totalMs の基準にする単調な時計（ミリ秒）。既定は performance.now */
  now?: () => number
  /** 通知の間引き用。cb を少し後に実行し、取り消し関数を返す。既定は setTimeout（約 50ms） */
  schedule?: (cb: () => void) => () => void
  /** 診断（CORS 判定）に使うページのオリジン。既定は location.origin */
  pageOrigin?: () => string | undefined
}

const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_MAX_EVENTS = 5000
const DEFAULT_MAX_BODY_CHARS = 2_000_000
const DEFAULT_MAX_REQUEST_BODY_CHARS = 200_000
const DEFAULT_MAX_EVENT_CHARS = 100_000
const DEFAULT_MAX_TOTAL_CHARS = 50_000_000
/** イベントの raw の予算を使い切ったあとも、診断に必要な先頭だけは残す文字数。 */
const MIN_EVENT_RAW_CHARS = 200
/** 省略版の data に残す文字列の長さ。type / id / toolCallId などの短い値は丸ごと残る。 */
const SLIM_STRING_CHARS = 1000
const NOTIFY_INTERVAL_MS = 50

/** ストア内部だけで持つ、エントリごとの作業用の状態（NetworkLogEntry には載せない）。 */
interface Slot {
  entry: NetworkLogEntry
  /** begin 時点の now()。atMs / ttfbMs / totalMs はここからの経過 */
  t0: number
  parser: SseParser | null
  /** パーサーが出した、まだ StreamEvent にしていない項目 */
  queue: SseItem[]
  /** イベントの raw として保持している文字数の合計（maxBodyChars の予算に数える） */
  eventChars: number
  /** ストア全体の予算に数えている、このエントリの文字数 */
  weight: number
  /** 実行中の chunk スキーマ検証の数 */
  pendingValidations: number
  /** 検証で見つかった問題（イベントの index → 理由）。検証が落ち着いたらまとめてイベントに反映する */
  schemaErrors: Map<number, string>
}

type EventDraft = Omit<StreamEvent, 'index' | 'atMs'>

const defaultNow = (): number => performance.now()

const defaultSchedule = (cb: () => void): (() => void) => {
  const timer = setTimeout(cb, NOTIFY_INTERVAL_MS)
  return () => clearTimeout(timer)
}

function defaultPageOrigin(): string | undefined {
  try {
    const origin = globalThis.location?.origin
    // about:blank などは 'null'。オリジンとして使えない
    return typeof origin === 'string' && origin !== 'null' ? origin : undefined
  } catch {
    return undefined
  }
}

function isFinished(state: LogState): boolean {
  return state === 'done' || state === 'error' || state === 'aborted'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** UTF-8 に符号化したときのバイト数（TextEncoder と同じ結果。対になっていない代用対は U+FFFD の 3 バイト）。 */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * 部分文字列は元の文字列を保持し続ける（V8 の sliced string）。巨大なイベントの先頭だけを残すときに
 * 元の文字列ごと残ってしまっては意味が無いので、新しい文字列にコピーする。
 */
function detach(text: string): string {
  return `${text} `.slice(0, -1)
}

function clipRaw(text: string, cap: number): { raw: string; rawTruncated?: true } {
  if (text.length <= cap) return { raw: text }
  let cut = cap
  // 代用対の途中で切らない
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut--
  return { raw: detach(text.slice(0, cut)), rawTruncated: true }
}

function slimString(value: string): string {
  if (value.length <= SLIM_STRING_CHARS) return value
  return `${detach(value.slice(0, SLIM_STRING_CHARS))}…（省略: 全 ${value.length} 文字）`
}

/**
 * 切り詰めたイベント用の省略版の data。type / id / toolCallId などの短い値は残し、
 * 長い文字列は先頭だけ、入れ子のオブジェクト・配列は件数の注記に置き換える。
 */
function slimData(data: unknown): unknown {
  if (typeof data === 'string') return slimString(data)
  if (Array.isArray(data)) return `（省略: 配列 ${data.length} 件）`
  if (!isRecord(data)) return data
  const slim: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') slim[key] = slimString(value)
    else if (Array.isArray(value)) slim[key] = `（省略: 配列 ${value.length} 件）`
    else if (isRecord(value))
      slim[key] = `（省略: オブジェクト ${Object.keys(value).length} 個のキー）`
    else slim[key] = value
  }
  return slim
}

interface DraftResult {
  draft: EventDraft
  /** JSON.parse した完全な値（sse-json のときだけ）。スキーマ検証に使う。保持はしない */
  parsed?: unknown
}

function toDraft(item: SseItem, rawCap: number): DraftResult {
  if (item.kind === 'comment') {
    return { draft: { kind: 'sse-comment', ...clipRaw(item.text, rawCap) } }
  }
  const base = {
    ...clipRaw(item.data, rawCap),
    ...(item.event !== undefined ? { eventName: item.event } : {}),
    ...(item.incomplete === true ? { incomplete: true } : {}),
  }
  if (item.truncated === true) {
    // パーサーの上限を超えて途中までしか無い。JSON として解釈できないのは壊れているからではないので、パース失敗とは区別する
    return {
      draft: {
        kind: 'sse-text',
        parseSkipped: true,
        parseError: 'イベントが大きすぎるため、解析を省略しました',
        ...base,
        rawTruncated: true,
      },
    }
  }
  // AI SDK と同じく、完全一致の [DONE] だけを終端として扱う
  if (item.data === '[DONE]') return { draft: { kind: 'sse-done', ...base } }
  try {
    const data: unknown = JSON.parse(item.data)
    const type = isRecord(data) && typeof data.type === 'string' ? data.type : undefined
    return {
      draft: {
        kind: 'sse-json',
        // raw を切り詰めたイベントは、data も大きいまま持たない
        data: base.rawTruncated === true ? slimData(data) : data,
        ...(type !== undefined ? { type } : {}),
        ...base,
      },
      parsed: data,
    }
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error)
    return { draft: { kind: 'sse-text', parseError, ...base } }
  }
}

export function createNetworkLog(opts: NetworkLogOptions = {}): NetworkLogStore {
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? DEFAULT_MAX_ENTRIES))
  const maxEvents = Math.max(0, Math.floor(opts.maxEvents ?? DEFAULT_MAX_EVENTS))
  const maxBodyChars = Math.max(0, Math.floor(opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS))
  const maxRequestBodyChars = Math.max(
    0,
    Math.floor(opts.maxRequestBodyChars ?? DEFAULT_MAX_REQUEST_BODY_CHARS),
  )
  const maxEventChars = Math.max(0, Math.floor(opts.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS))
  const maxParseChars = Math.max(1, Math.floor(opts.maxParseChars ?? DEFAULT_SSE_MAX_CHARS))
  const maxTotalChars = Math.max(0, Math.floor(opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS))
  const validateChunk = opts.validateChunk ?? validateUiChunk
  const now = opts.now ?? defaultNow
  const schedule = opts.schedule ?? defaultSchedule
  const pageOrigin = opts.pageOrigin ?? defaultPageOrigin

  let entries: readonly NetworkLogEntry[] = []
  let selectedId: string | null = null
  let seq = 0
  const slots = new Map<string, Slot>()
  /** 全エントリの weight の合計（maxTotalChars の予算と比べる） */
  let totalWeight = 0
  const listeners = new Set<() => void>()

  // --- 通知 -----------------------------------------------------------------

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  let scheduled = false
  let cancelScheduled: (() => void) | null = null

  /** recordHead / recordText 用。短い間隔で何度呼ばれても通知は 1 回にまとめる。 */
  function scheduleNotify(): void {
    if (scheduled) return
    scheduled = true
    cancelScheduled = schedule(() => {
      scheduled = false
      cancelScheduled = null
      notify()
    })
  }

  /** begin / finish / select / clear 用。保留中の通知もここで済ませる。 */
  function notifyNow(): void {
    if (scheduled) {
      scheduled = false
      cancelScheduled?.()
      cancelScheduled = null
    }
    notify()
  }

  // --- エントリ更新 ----------------------------------------------------------

  /** エントリは常に新しいオブジェクトで差し替える（呼び出し側が持っている旧エントリは変化しない）。 */
  function commit(slot: Slot, next: NetworkLogEntry): void {
    const index = entries.indexOf(slot.entry)
    slot.entry = next
    if (index === -1) return
    const copy = entries.slice()
    copy[index] = next
    entries = copy
  }

  function elapsed(slot: Slot): number {
    return Math.max(0, now() - slot.t0)
  }

  /** events は追記時にコピーして参照を変える。上限を超えた分は捨てて eventsTruncated を立てる。 */
  function appendEvents(
    entry: NetworkLogEntry,
    total: number,
    build: (i: number, index: number) => EventDraft,
    atMs: number,
  ): NetworkLogEntry {
    const room = Math.max(0, maxEvents - entry.events.length)
    const accepted = Math.min(total, room)
    const eventsTruncated = entry.eventsTruncated || accepted < total
    if (accepted === 0) {
      return eventsTruncated === entry.eventsTruncated ? entry : { ...entry, eventsTruncated }
    }
    const added: StreamEvent[] = []
    for (let i = 0; i < accepted; i++) {
      const index = entry.events.length + i
      added.push({ index, atMs, ...build(i, index) })
    }
    return { ...entry, events: [...entry.events, ...added], eventsTruncated }
  }

  /** 1 イベントが保持できる raw の文字数。エントリ全体の予算を使い切ったあとも、先頭の少しだけは残す。 */
  function rawCapFor(slot: Slot): number {
    return Math.min(maxEventChars, Math.max(MIN_EVENT_RAW_CHARS, maxBodyChars - slot.eventChars))
  }

  /** パーサーが出した項目を取り出してイベントにする。 */
  function drainSseItems(slot: Slot, entry: NetworkLogEntry, atMs: number): NetworkLogEntry {
    const items = slot.queue.splice(0)
    const toValidate: Array<{ index: number; data: unknown }> = []
    const validates = entry.mode === 'chat-ui' || entry.mode === 'completion'
    const next = appendEvents(
      entry,
      items.length,
      (i, index) => {
        const { draft, parsed } = toDraft(items[i] as SseItem, rawCapFor(slot))
        slot.eventChars += draft.raw.length
        // 空行で終わっていないイベントは SDK が受け取らないので、検証しない
        if (validates && parsed !== undefined && draft.incomplete !== true) {
          toValidate.push({ index, data: parsed })
        }
        return draft
      },
      atMs,
    )
    for (const { index, data } of toValidate) startValidation(slot, index, data)
    return next
  }

  // --- chunk のスキーマ検証 ----------------------------------------------------

  /**
   * 検証は非同期（SDK のスキーマが Promise を返す）。結果はイベントに後から付ける。
   * 実際の通信ではチャンクの到着間隔のあいだに終わるので、finish() の診断より前に揃うのが普通。
   */
  function startValidation(slot: Slot, index: number, data: unknown): void {
    slot.pendingValidations++
    void validateChunk(data)
      .then(
        (reason) => {
          if (reason !== undefined) slot.schemaErrors.set(index, reason)
        },
        // 検証できなかった chunk は問題なしとして扱う（診断自体は止めない）
        () => {},
      )
      .then(() => {
        slot.pendingValidations--
        if (slot.pendingValidations === 0) applySchemaErrors(slot)
      })
  }

  /** たまった検証結果をイベントにまとめて反映する（chunk ごとに配列をコピーしないため、落ち着いてから 1 回）。 */
  function applySchemaErrors(slot: Slot): void {
    if (slot.schemaErrors.size === 0) return
    const errors = slot.schemaErrors
    slot.schemaErrors = new Map()
    // 捨てられた（clear / 古いエントリの削除）エントリには反映しない
    if (slots.get(slot.entry.id) !== slot) return
    const entry = slot.entry
    const events = entry.events.map((event) => {
      const reason = errors.get(event.index)
      return reason === undefined ? event : { ...event, schemaError: reason }
    })
    const finished = isFinished(entry.state)
    // 受信中の診断は finish() がやり直す。完了済みなら、検証が遅れた分をここで診断に反映する
    const next: NetworkLogEntry = { ...entry, events }
    commit(slot, finished ? diagnose(next) : next)
    if (finished) notifyNow()
    else scheduleNotify()
  }

  // --- メモリの予算 ------------------------------------------------------------

  function weightOf(slot: Slot): number {
    return (slot.entry.requestBody?.length ?? 0) + slot.entry.rawBody.length + slot.eventChars
  }

  function reweigh(slot: Slot): void {
    const weight = weightOf(slot)
    totalWeight += weight - slot.weight
    slot.weight = weight
  }

  function forget(id: string): void {
    const slot = slots.get(id)
    if (slot === undefined) return
    totalWeight -= slot.weight
    slots.delete(id)
  }

  /** 予算を超えたら古いエントリから捨てる。書き込み中（keepId）と選択中のエントリは残す。 */
  function enforceBudget(keepId: string): void {
    if (totalWeight <= maxTotalChars) return
    const kept = entries.slice()
    for (let i = kept.length - 1; i >= 0 && totalWeight > maxTotalChars; i--) {
      const candidate = kept[i] as NetworkLogEntry
      if (candidate.id === keepId || candidate.id === selectedId) continue
      kept.splice(i, 1)
      forget(candidate.id)
    }
    if (kept.length !== entries.length) entries = kept
  }

  function appendBody(
    entry: NetworkLogEntry,
    text: string,
  ): Pick<NetworkLogEntry, 'rawBody' | 'rawBodyTruncated'> {
    if (entry.rawBodyTruncated) return { rawBody: entry.rawBody, rawBodyTruncated: true }
    const room = maxBodyChars - entry.rawBody.length
    if (text.length <= room) return { rawBody: entry.rawBody + text, rawBodyTruncated: false }
    let cut = Math.max(0, room)
    // 代用対の途中で切らない
    if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut--
    return { rawBody: entry.rawBody + text.slice(0, cut), rawBodyTruncated: true }
  }

  function diagnose(entry: NetworkLogEntry): NetworkLogEntry {
    return { ...entry, diagnostics: buildDiagnostics(entry, { pageOrigin: pageOrigin() }) }
  }

  // --- ストア ----------------------------------------------------------------

  return {
    getEntries: () => entries,
    getEntry: (id) => slots.get(id)?.entry,
    getSelectedId: () => selectedId,

    select(id) {
      if (id === selectedId) return
      // 存在しない（捨てられた）エントリは選べない
      if (id !== null && !slots.has(id)) return
      selectedId = id
      notifyNow()
    },

    clear() {
      if (entries.length === 0 && selectedId === null) return
      entries = []
      selectedId = null
      slots.clear()
      totalWeight = 0
      notifyNow()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    begin(init) {
      const id = `req-${++seq}`
      // 添付ファイルの data URL などで数十 MB になりうる。履歴は毎ターン全部再送されるので、保持は上限までにする
      const requestBody =
        init.requestBody === undefined ? undefined : clipRaw(init.requestBody, maxRequestBodyChars)
      const entry: NetworkLogEntry = {
        id,
        mode: init.mode,
        startedAt: Date.now(),
        method: init.method,
        targetUrl: init.targetUrl,
        viaProxy: init.viaProxy,
        requestHeaders: { ...init.requestHeaders },
        ...(init.droppedHeaders !== undefined && init.droppedHeaders.length > 0
          ? { droppedHeaders: [...init.droppedHeaders] }
          : {}),
        ...(requestBody !== undefined ? { requestBody: requestBody.raw } : {}),
        ...(requestBody?.rawTruncated === true ? { requestBodyTruncated: true } : {}),
        state: 'pending',
        events: [],
        eventsTruncated: false,
        rawBody: '',
        rawBodyTruncated: false,
        bytesReceived: 0,
        diagnostics: [],
      }
      const slot: Slot = {
        entry,
        t0: now(),
        parser: null,
        queue: [],
        eventChars: 0,
        weight: 0,
        pendingValidations: 0,
        schemaErrors: new Map(),
      }
      slots.set(id, slot)
      reweigh(slot)
      const next = [entry, ...entries]
      // 古いものを捨てる。通信中のエントリが捨てられても、以降の記録は無視されるだけ
      for (const dropped of next.splice(maxEntries)) forget(dropped.id)
      entries = next
      selectedId = id
      enforceBudget(id)
      notifyNow()
      return id
    },

    recordHead(id, head) {
      const slot = slots.get(id)
      if (slot === undefined || isFinished(slot.entry.state)) return
      const responseHeaders = Object.fromEntries(
        Object.entries(head.responseHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      )
      // ヘッダー受信時点で分かる診断（ステータス・プロキシ・Content-Type など）だけがここで付く
      commit(
        slot,
        diagnose({
          ...slot.entry,
          state: 'streaming',
          status: head.status,
          statusText: head.statusText,
          responseHeaders,
          ttfbMs: elapsed(slot),
        }),
      )
      scheduleNotify()
    },

    recordText(id, text, { sse }) {
      const slot = slots.get(id)
      if (slot === undefined || text === '' || isFinished(slot.entry.state)) return
      const atMs = elapsed(slot)
      let entry: NetworkLogEntry = {
        ...slot.entry,
        state: 'streaming',
        // バイト数は上限と無関係に数える
        bytesReceived: slot.entry.bytesReceived + utf8ByteLength(text),
        ...appendBody(slot.entry, text),
      }
      if (sse) {
        slot.parser ??= createSseParser((item) => slot.queue.push(item), {
          maxChars: maxParseChars,
        })
        slot.parser.push(text)
        entry = drainSseItems(slot, entry, atMs)
      } else {
        entry = appendEvents(
          entry,
          1,
          () => {
            const clipped = clipRaw(text, rawCapFor(slot))
            slot.eventChars += clipped.raw.length
            return { kind: 'text-chunk', ...clipped }
          },
          atMs,
        )
      }
      commit(slot, entry)
      reweigh(slot)
      enforceBudget(id)
      scheduleNotify()
    },

    finish(id, result) {
      const slot = slots.get(id)
      if (slot === undefined || isFinished(slot.entry.state)) return
      const atMs = elapsed(slot)
      let entry = slot.entry
      if (slot.parser !== null) {
        // 末尾の改行が無いまま終わったイベントも、診断の前にここで確定させる
        slot.parser.end()
        entry = drainSseItems(slot, entry, atMs)
      }
      entry = diagnose({
        ...entry,
        state: result.state,
        totalMs: atMs,
        ...(result.state !== 'done' && result.error !== undefined
          ? { error: { ...result.error } }
          : {}),
      })
      commit(slot, entry)
      reweigh(slot)
      enforceBudget(id)
      notifyNow()
    },
  }
}

export const networkLog: NetworkLogStore = createNetworkLog()
