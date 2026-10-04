import type { UIMessageChunk } from 'ai'
import { forbiddenHeaderHint } from '@/lib/forbidden-headers'
import { formatDuration, truncate } from '@/lib/format'
import { PROXY_ERROR_HEADER, PROXY_NAME, PROXY_PATH, PROXY_TOGGLE_LABEL } from '@/lib/proxy'
import type { Diagnostic, DiagnosticLevel, NetworkLogEntry, StreamEvent } from '@/types'

/**
 * ネットワークログ 1 件から診断（Diagnostic）を作る純粋関数。
 * 「接続できない」「プロキシが動いていない」「SSE が壊れている」といった、
 * AI SDK を使ったバックエンドのつまずきやすい点を日本語の対処つきで示す。
 */

/** UIMessageChunk の type（data-* は接頭辞で別扱いなので除く）。 */
type SdkChunkType = Exclude<UIMessageChunk['type'], `data-${string}`>

/**
 * AI SDK v7 の UIMessageChunk の type 一覧（data-* は接頭辞で別扱い）。
 * Record<SdkChunkType, true> で書くので、SDK に type が増えるとキー不足、減ると余分なキーで型エラーになり、
 * pnpm typecheck が見直しを促す（目視の突き合わせだと、更新したことに気づけず正常な chunk を誤って警告し続ける）。
 */
const KNOWN_TYPE_FLAGS: Record<SdkChunkType, true> = {
  'text-start': true,
  'text-delta': true,
  'text-end': true,
  'reasoning-start': true,
  'reasoning-delta': true,
  'reasoning-end': true,
  'reasoning-file': true,
  file: true,
  'source-url': true,
  'source-document': true,
  custom: true,
  error: true,
  'tool-input-start': true,
  'tool-input-delta': true,
  'tool-input-available': true,
  'tool-input-error': true,
  'tool-approval-request': true,
  'tool-approval-response': true,
  'tool-output-available': true,
  'tool-output-error': true,
  'tool-output-denied': true,
  'start-step': true,
  'finish-step': true,
  'reset-step': true,
  start: true,
  finish: true,
  abort: true,
  'message-metadata': true,
}

export const KNOWN_UI_CHUNK_TYPES: ReadonlySet<string> = new Set(Object.keys(KNOWN_TYPE_FLAGS))

/**
 * クライアント（SDK）がレスポンスの読み取りを自分から打ち切ったときのログのエラー名。
 * サーバーやプロキシが接続を切った「途中切断」とは原因が違うので、診断を分ける。
 */
export const STREAM_CANCELLED_ERROR = 'StreamCancelled'

const UI_STREAM_HEADER = 'x-vercel-ai-ui-message-stream'
/** detail に列挙する項目数の上限 */
const MAX_LISTED = 5
/** アプリ自身の index.html に必ずある目印（プロキシが無くて SPA にフォールバックした応答の判別用） */
const APP_SHELL_RE = /<div id="root"/

const LEVEL_ORDER: Record<DiagnosticLevel, number> = { error: 0, warn: 1, info: 2, ok: 3 }

interface View {
  entry: NetworkLogEntry
  status: number | undefined
  ok2xx: boolean
  /** キーを小文字にそろえたレスポンスヘッダー */
  headers: Record<string, string>
  rawContentType: string | undefined
  /** パラメーターを除いた小文字の media type（未指定なら空文字） */
  mediaType: string
  isEventStream: boolean
  /** ctx.pageOrigin が分かっていて、ターゲットが別オリジンのときだけ true（不明なら false） */
  crossOrigin: boolean
  hasProxyError: boolean
  /** UI Message Stream（SSE の JSON chunk）として解析する対象か */
  uiStream: boolean
  hasSseEvents: boolean
  hasFinish: boolean
  /** 空行で終わらず、SDK には届いていない最後のイベント（incomplete）がある */
  hasIncomplete: boolean
  /** UI Message Stream が finish の前に切断された */
  truncated: boolean
}

function diag(id: string, level: DiagnosticLevel, title: string, detail?: string): Diagnostic {
  return detail ? { id, level, title, detail } : { id, level, title }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCrossOrigin(targetUrl: string, pageOrigin: string | undefined): boolean {
  if (!pageOrigin) return false
  try {
    return new URL(targetUrl).origin !== new URL(pageOrigin).origin
  } catch {
    // どちらかが URL として解釈できなければ判断しない（CORS の憶測を出さない）
    return false
  }
}

/** UI Message Stream の chunk type（sse-json の data.type）。 */
function chunkType(event: StreamEvent): string | undefined {
  if (event.type !== undefined) return event.type
  return isRecord(event.data) && typeof event.data.type === 'string' ? event.data.type : undefined
}

/**
 * SDK が受け取る JSON chunk。空行で終わっていない最後のイベント（incomplete）は、SDK には届かないので含めない。
 */
function jsonChunks(events: readonly StreamEvent[]): Array<{ event: StreamEvent; type?: string }> {
  const chunks: Array<{ event: StreamEvent; type?: string }> = []
  for (const event of events) {
    if (event.kind !== 'sse-json' || event.incomplete === true) continue
    const type = chunkType(event)
    chunks.push(type === undefined ? { event } : { event, type })
  }
  return chunks
}

function createView(entry: NetworkLogEntry, ctx: { pageOrigin?: string } | undefined): View {
  const status = entry.status
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(entry.responseHeaders ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  )
  const rawContentType = headers['content-type']
  const mediaType = rawContentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  const isEventStream = mediaType === 'text/event-stream'
  const ok2xx = status !== undefined && status >= 200 && status < 300
  // completion は data / text のどちらか entry からは分からないので、SSE で返ってきたら data とみなす
  const uiStream = entry.mode === 'chat-ui' || (entry.mode === 'completion' && isEventStream)
  const chunks = jsonChunks(entry.events)
  const hasFinish = chunks.some((c) => c.type === 'finish')
  return {
    entry,
    status,
    ok2xx,
    headers,
    rawContentType,
    mediaType,
    isEventStream,
    crossOrigin: isCrossOrigin(entry.targetUrl, ctx?.pageOrigin),
    hasProxyError: headers[PROXY_ERROR_HEADER] !== undefined,
    uiStream,
    hasSseEvents: entry.events.some((e) => e.kind.startsWith('sse-')),
    hasFinish,
    hasIncomplete: entry.events.some((e) => e.incomplete === true),
    truncated:
      uiStream &&
      entry.state === 'error' &&
      ok2xx &&
      !hasFinish &&
      // SDK が自分で打ち切った場合は、サーバー側の切断ではない
      entry.error?.name !== STREAM_CANCELLED_ERROR,
  }
}

/** '#3: 説明' の行を最大 MAX_LISTED 件並べ、残りは件数だけ示す。 */
function listLines(items: Array<{ index: number; text: string }>): string {
  const lines = items.slice(0, MAX_LISTED).map((item) => `#${item.index}: ${item.text}`)
  if (items.length > MAX_LISTED) lines.push(`…ほか ${items.length - MAX_LISTED} 件`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// HTTP / 接続
// ---------------------------------------------------------------------------

const MESSAGE_KEYS = [
  'message',
  'error',
  'detail',
  'errorText',
  'error_description',
  'msg',
  'title',
]

/** JSON のエラー応答（{ error: { message } } や FastAPI の detail 配列など）から人が読める 1 文を取り出す。 */
function pickMessage(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (depth >= 3) return undefined
  if (Array.isArray(value)) return pickMessage(value[0], depth + 1)
  if (!isRecord(value)) return undefined
  for (const key of MESSAGE_KEYS) {
    const found = pickMessage(value[key], depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function extractErrorMessage(rawBody: string): string | undefined {
  const text = rawBody.trim()
  if (text === '') return undefined
  try {
    const message = pickMessage(JSON.parse(text))
    return message === undefined ? undefined : truncate(message, 300)
  } catch {
    // JSON ではない。HTML のエラーページは読みづらいので出さず、短いテキストだけ先頭を見せる
    if (text.startsWith('<')) return undefined
    return truncate(text.replace(/\s+/g, ' '), 200)
  }
}

function statusHint(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return '認証・認可で拒否されました。Authorization ヘッダー（または Bearer トークン）の値・有効期限・権限を確認してください。'
  }
  if (status === 404) {
    return 'エンドポイントが見つかりません。URL とパス（末尾のスラッシュ含む）、サーバー側のルーティングを確認してください。'
  }
  if (status === 405) {
    return 'このエンドポイントは、送ったメソッドを受け付けません。HTTP メソッド（Raw モードなら設定のメソッド）とサーバー側のルート定義を確認してください。'
  }
  if (status === 415) {
    return 'Content-Type が受け付けられません。サーバーが期待する形式（通常は application/json）と、ヘッダー設定を確認してください。'
  }
  if (status === 429) {
    return 'レート制限に達しました。少し待ってから再試行するか、サーバー側の制限（Retry-After ヘッダー）を確認してください。'
  }
  if (status === 400 || status === 422) {
    return 'リクエストの内容が不正と判断されました。リクエスト body の形式・必須フィールド・追加ボディの JSON を確認してください。'
  }
  if (status >= 500) {
    return 'サーバー側でエラーが発生しています。サーバーのログ（スタックトレース）と、環境変数（API キーなど）の設定を確認してください。'
  }
  return undefined
}

function httpStatus(v: View): Diagnostic | undefined {
  const { entry, status } = v
  if (status === undefined) return undefined
  const label = `HTTP ${status}${entry.statusText ? ` ${entry.statusText}` : ''}`
  if (v.ok2xx) return diag('http-status', 'ok', `${label}（正常に応答しました）`)
  if (status < 400) {
    return diag('http-status', 'info', `${label}（2xx 以外の応答です）`)
  }

  const lines: string[] = []
  if (v.hasProxyError) {
    lines.push(
      `${PROXY_NAME}自身が返したエラーです。原因は「${PROXY_NAME}がエラーを返しました」を参照してください。`,
    )
  } else {
    const hint = statusHint(status)
    if (hint !== undefined) lines.push(hint)
    if ((status === 401 || status === 403) && hasDroppedCookie(entry)) {
      lines.push(
        'なお、設定した Cookie ヘッダーはブラウザの仕様で送信されていません（「ブラウザの仕様で送信されないヘッダー」を参照）。',
      )
    }
    const message = extractErrorMessage(entry.rawBody)
    if (message !== undefined) lines.push(`サーバーのメッセージ: ${message}`)
  }
  return diag('http-status', 'error', `${label}（リクエストが失敗しました）`, lines.join('\n'))
}

function isAborted(entry: NetworkLogEntry): boolean {
  return entry.state === 'aborted' || entry.error?.name === 'AbortError'
}

function aborted(v: View): Diagnostic | undefined {
  if (!isAborted(v.entry)) return undefined
  return diag(
    'aborted',
    'info',
    'リクエストは中断されました',
    '停止ボタンの操作・ページ遷移・タイムアウトなどで中断されたため、レスポンスは途中で終わっています（エラーではありません）。',
  )
}

function hasDroppedCookie(entry: NetworkLogEntry): boolean {
  return (entry.droppedHeaders ?? []).some((name) => name === 'cookie' || name === 'cookie2')
}

/** 指定したのにブラウザの仕様で送られなかったヘッダー（ログの requestHeaders には載せていない）。 */
function droppedHeaders(v: View): Diagnostic | undefined {
  const names = v.entry.droppedHeaders ?? []
  if (names.length === 0) return undefined
  return diag(
    'request-headers-dropped',
    'warn',
    `ブラウザの仕様で送信されないヘッダーがあります: ${names.join(', ')}`,
    [
      'fetch は Cookie / Origin / Referer / Host / Content-Length / Accept-Encoding / Connection / Sec-* / Proxy-* などのヘッダーを JavaScript から設定できず、指定しても黙って捨てます。サーバーには届いていないので、リクエストタブと cURL にもこれらは含めていません（cURL で再現すると結果が違うのはこのためです）。',
      hasDroppedCookie(v.entry) ? (forbiddenHeaderHint('cookie') ?? '') : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  )
}

/** クライアント SDK がレスポンスの読み取りを自分から打ち切った（サーバー側の切断ではない）。 */
function streamCancelled(v: View): Diagnostic | undefined {
  const { error } = v.entry
  if (error?.name !== STREAM_CANCELLED_ERROR) return undefined
  return diag(
    'stream-cancelled',
    'error',
    'クライアント（AI SDK）がレスポンスの読み取りを打ち切りました',
    [
      error.message,
      'サーバーやプロキシが接続を切ったのではありません。SDK は、解釈できない chunk（JSON の誤り・スキーマ違反・順序違反・error chunk）に当たるとストリームの読み取りをやめ、接続を閉じます。チャット / Completion 側のエラー表示と、このタブの chunk に関する診断を確認してください。',
    ].join('\n'),
  )
}

function networkError(v: View): Diagnostic | undefined {
  const { entry } = v
  if (isAborted(entry)) return undefined
  if (entry.error === undefined && entry.state !== 'error') return undefined
  // SDK が自分で読み取りをやめた場合は 'stream-cancelled' が説明する
  if (entry.error?.name === STREAM_CANCELLED_ERROR) return undefined
  const error = entry.error
  const errorLine = error === undefined ? '' : `（${error.name}: ${error.message}）`

  // レスポンスを受け取ったあとの失敗＝ストリームの途中切断
  if (v.status !== undefined) {
    // UI Message Stream で finish が無い切断は 'ui-stream-truncated' が説明する
    if (v.truncated) return undefined
    return diag(
      'network-error',
      'error',
      'ストリームの受信中に接続が切断されました',
      [
        'サーバーまたはプロキシが応答の途中で接続を閉じた可能性があります。サーバー側のログ（タイムアウト・クラッシュ・メモリ不足など）と、間にあるプロキシ / ロードバランサーのタイムアウト設定を確認してください。',
        errorLine,
      ]
        .filter((line) => line !== '')
        .join('\n'),
    )
  }

  if (error?.name === 'RequestShapeError') {
    return diag(
      'network-error',
      'error',
      'リクエストを送信できませんでした',
      `設定に誤りがあるため、送信前に中止しました。${errorLine}\n設定画面の内容（エンドポイント・ヘッダー・追加ボディなど）を確認してください。`,
    )
  }

  if (entry.viaProxy) {
    return diag(
      'network-error',
      'error',
      'プロキシ経由のリクエストに失敗しました',
      [
        `Vite 開発サーバー（${PROXY_PATH}）に届かなかったか、プロキシから転送先への接続が途中で切れました。`,
        `開発サーバー（pnpm dev）が起動しているか、転送先 ${entry.targetUrl} のホスト名・ポート・サーバーの起動状態を確認してください。`,
        errorLine,
      ]
        .filter((line) => line !== '')
        .join('\n'),
    )
  }

  if (v.crossOrigin) {
    return diag(
      'network-error',
      'error',
      'リクエストに失敗しました（CORS が許可されていない可能性があります）',
      [
        'ターゲットはこのページとは別オリジンです。ブラウザは CORS を許可しないレスポンスを JavaScript に渡さず、「Failed to fetch」のような詳細の無いエラーにします。',
        `対処: (1) 設定の「${PROXY_TOGGLE_LABEL}」を ON にする（CORS を回避できます） (2) バックエンドで CORS を許可する（Access-Control-Allow-Origin、プリフライト OPTIONS への応答、Authorization など独自ヘッダーを送る場合は Access-Control-Allow-Headers）。`,
        'サーバーが停止している・URL やポートが違う場合も同じエラーになるので、あわせて確認してください。',
        errorLine,
      ]
        .filter((line) => line !== '')
        .join('\n'),
    )
  }

  return diag(
    'network-error',
    'error',
    'リクエストに失敗しました（サーバーに接続できません）',
    [
      'サーバーが起動しているか、URL・ポート・ネットワーク接続を確認してください。https のページから http のエンドポイントへ送ると、混在コンテンツとしてブロックされます。',
      errorLine,
    ]
      .filter((line) => line !== '')
      .join('\n'),
  )
}

// ---------------------------------------------------------------------------
// プロキシ
// ---------------------------------------------------------------------------

function proxyUnavailable(v: View): Diagnostic | undefined {
  const { entry, status } = v
  if (!entry.viaProxy || status === undefined) return undefined
  const isHtml = v.mediaType === 'text/html'
  const notFound = status === 404 && !v.hasProxyError
  if (!notFound && !isHtml) return undefined

  // アプリ自身の index.html が返っていれば、プロキシが動いていないと断定できる
  const certain = isHtml && APP_SHELL_RE.test(entry.rawBody)
  return diag(
    'proxy-unavailable',
    certain ? 'error' : 'warn',
    certain ? `${PROXY_NAME}が動作していません` : `${PROXY_NAME}が動作していない可能性があります`,
    [
      `プロキシ（${PROXY_PATH}）ではなく、別のレスポンス（404 または HTML）が返っています。プロキシは Vite の開発サーバー / プレビューサーバーのミドルウェアなので、ビルド成果物を静的ホスティングなどで配信している場合は使えません。`,
      `確認: ブラウザで ${PROXY_PATH} を開き、{"proxy":"ai-sdk-tester",...} が返るか見てください。`,
      '転送先のサーバー自身が 404 や HTML を返している場合も、この表示になります（その場合は転送先の URL・パスを確認してください）。',
    ].join('\n'),
  )
}

function proxyError(v: View): Diagnostic | undefined {
  const { entry, status } = v
  if (!v.hasProxyError) return undefined
  let code: string | undefined
  let message: string | undefined
  try {
    const json: unknown = JSON.parse(entry.rawBody)
    if (isRecord(json)) {
      if (typeof json.error === 'string') code = json.error
      if (typeof json.message === 'string') message = json.message
    }
  } catch {
    // JSON でなければ、本文の先頭だけ見せる
    message = extractErrorMessage(entry.rawBody)
  }

  let hint: string | undefined
  if (code === 'proxy_error') {
    hint =
      'プロキシから転送先へ接続できませんでした。転送先のホスト名・ポート・サーバーの起動状態を確認してください（localhost は ::1 と 127.0.0.1 の違いにも注意）。'
  } else if (code === 'missing_target' || code === 'invalid_target') {
    hint = '転送先 URL が不正です。エンドポイントに http(s) の絶対 URL を指定してください。'
  } else if (code === 'forbidden') {
    hint =
      'プロキシは開発サーバーと同じオリジンのページからのリクエストだけを受け付けます。別のホスト名・別サイトから開いていないか確認してください。'
  } else if (code === 'redirect_error') {
    // 転送先には届いている。接続失敗（proxy_error）と取り違えて、転送先の起動状態を探し回らせない
    hint =
      '転送先はリダイレクト（301 / 302 / 303 / 307 / 308）を返しましたが、プロキシがリダイレクト先へ再送できませんでした。上のメッセージに理由があります（Location が不正・リダイレクトが多すぎる・リクエスト body を再送できない、など）。リダイレクト先の URL を直接エンドポイントに指定してください。'
  } else if (code === 'method_not_allowed') {
    hint =
      'CONNECT / TRACE / TRACK は fetch が扱えないため、プロキシでは転送できません。別の HTTP メソッドを指定してください。'
  }
  return diag(
    'proxy-error',
    'error',
    `${PROXY_NAME}がエラーを返しました（HTTP ${status ?? '?'}）`,
    [message, hint].filter((line): line is string => line !== undefined && line !== '').join('\n'),
  )
}

// ---------------------------------------------------------------------------
// Content-Type / ヘッダー
// ---------------------------------------------------------------------------

function contentType(v: View): Diagnostic | undefined {
  if (!v.ok2xx) return undefined
  const actual = v.rawContentType ?? '（指定なし）'
  if (v.entry.mode === 'chat-ui' && !v.isEventStream) {
    const plain = v.rawContentType?.toLowerCase().includes('text/plain') === true
    return diag(
      'content-type',
      'warn',
      'Content-Type が text/event-stream ではありません',
      [
        `実際の Content-Type: ${actual}`,
        'Chat (UI Message Stream) は SSE（text/event-stream）で返す必要があります。サーバー側は toUIMessageStream() の結果を createUIMessageStreamResponse() で返してください。',
        plain
          ? 'プレーンテキストをそのまま返すバックエンドなら、Chat (Text Stream) モードを試してください。'
          : '',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    )
  }
  if (v.entry.mode === 'chat-text' && v.isEventStream) {
    return diag(
      'content-type',
      'warn',
      'Text Stream モードなのに SSE（text/event-stream）が返っています',
      'Chat (UI Message Stream) モードを試してください。Text Stream モードでは SSE の "data: ..." 行がそのまま本文として表示されます。',
    )
  }
  return undefined
}

function uiStreamHeader(v: View): Diagnostic | undefined {
  if (!v.uiStream || !v.ok2xx) return undefined
  const value = v.headers[UI_STREAM_HEADER]
  if (value !== undefined) {
    return value.trim() === 'v1'
      ? diag('ui-stream-header', 'ok', `${UI_STREAM_HEADER}: v1 を確認しました`)
      : diag(
          'ui-stream-header',
          'warn',
          `${UI_STREAM_HEADER} の値が v1 ではありません（${value}）`,
          'UI Message Stream のバージョンは v1 です。サーバー側の AI SDK のバージョンを確認してください。',
        )
  }

  const notRequired =
    'クライアント SDK（DefaultChatTransport / useCompletion）はこのヘッダーを必須としておらず、無くても動作します。'
  if (v.crossOrigin && !v.entry.viaProxy) {
    return diag(
      'ui-stream-header',
      'info',
      `${UI_STREAM_HEADER} ヘッダーを確認できません`,
      [
        'クロスオリジンでは、CORS の Access-Control-Expose-Headers に含めないとブラウザの JavaScript からは読めません。サーバーが送っていても「無い」ように見えている可能性があります。',
        notRequired,
      ].join('\n'),
    )
  }
  return diag(
    'ui-stream-header',
    'warn',
    `${UI_STREAM_HEADER}: v1 ヘッダーがありません`,
    [
      'UI Message Stream を返す場合は、このヘッダーを付けるのが仕様です（createUIMessageStreamResponse が自動で付けます）。自前で SSE を組み立てているなら追加してください。',
      notRequired,
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// UI Message Stream（SSE の JSON chunk）
// ---------------------------------------------------------------------------

function invalidJson(v: View): Diagnostic | undefined {
  // 空行で終わっていないイベント・巨大で解析を省略したイベントは、SDK の挙動を再現できないので対象外
  const bad = v.entry.events.filter(
    (e) =>
      e.kind === 'sse-text' &&
      e.raw !== '[DONE]' &&
      e.incomplete !== true &&
      e.parseSkipped !== true,
  )
  if (bad.length === 0) return undefined
  return diag(
    'sse-invalid-json',
    'error',
    `SSE の data が JSON として解釈できません（${bad.length} 件）`,
    [
      'UI Message Stream の data は 1 イベントにつき 1 つの JSON オブジェクトである必要があります（終端の [DONE] を除く）。SDK はこのイベントでストリームをエラー終了します。',
      listLines(
        bad.map((e) => ({
          index: e.index,
          text: `${e.parseError ?? 'JSON ではありません'} / ${truncate(e.raw, 80)}`,
        })),
      ),
    ].join('\n'),
  )
}

function unknownType(v: View): Diagnostic | undefined {
  const firstIndex = new Map<string, number>()
  for (const { event, type } of jsonChunks(v.entry.events)) {
    const label = type ?? '（type なし）'
    if (type !== undefined && (KNOWN_UI_CHUNK_TYPES.has(type) || type.startsWith('data-'))) continue
    if (!firstIndex.has(label)) firstIndex.set(label, event.index)
  }
  if (firstIndex.size === 0) return undefined
  const labels = [...firstIndex.keys()]
  return diag(
    'ui-chunk-unknown-type',
    'warn',
    `未知の chunk type が含まれています: ${labels.slice(0, MAX_LISTED).join(', ')}`,
    [
      'AI SDK（v7）の UIMessageChunk に無い type です。クライアント SDK はスキーマ検証に失敗し、ストリームをエラー終了させます。',
      'サーバー側 SDK のバージョンがクライアントより新しい、または独自の type を使っている可能性があります。独自データは "data-" で始まる type にしてください。',
      listLines(
        [...firstIndex.entries()].map(([label, index]) => ({ index, text: `${label}（初出）` })),
      ),
    ].join('\n'),
  )
}

/**
 * type 名は既知でも、フィールドが SDK のスキーマ（uiMessageChunkSchema）に合わない chunk。
 * 未知の type は 'ui-chunk-unknown-type' が説明するので、ここでは重ねない。
 */
function schemaInvalid(v: View): Diagnostic | undefined {
  const bad = jsonChunks(v.entry.events).filter(
    ({ event, type }) =>
      event.schemaError !== undefined &&
      type !== undefined &&
      (KNOWN_UI_CHUNK_TYPES.has(type) || type.startsWith('data-')),
  )
  if (bad.length === 0) return undefined
  return diag(
    'ui-chunk-schema-invalid',
    'error',
    `chunk のフィールドが SDK のスキーマに合いません（${bad.length} 件）`,
    [
      'クライアント SDK（DefaultChatTransport / useCompletion の data プロトコル）は、各 chunk を uiMessageChunkSchema で検証し、合わない chunk で AI_TypeValidationError を投げてストリームを中断します。',
      '古い AI SDK の形式（text-delta の textDelta など）、id や toolName の抜け、finishReason の値（"tool-calls" のようにハイフン区切り）の違いが典型的な原因です。サーバー側の AI SDK のバージョンも確認してください。',
      listLines(
        bad.map(({ event, type }) => ({
          index: event.index,
          text: `${type}: ${event.schemaError ?? ''}`,
        })),
      ),
    ].join('\n'),
  )
}

/** ログの保持上限を超える巨大なイベント（JSON の判定自体を省略したもの）。 */
function skippedEvents(v: View): Diagnostic | undefined {
  const skipped = v.entry.events.filter((e) => e.parseSkipped === true)
  if (skipped.length === 0) return undefined
  return diag(
    'sse-event-too-large',
    'info',
    `巨大なイベントの解析を省略しました（${skipped.length} 件）`,
    [
      'SSE の 1 行または 1 イベントがログの保持上限を超えたため、JSON の検証と chunk の診断の対象外にしています（SDK は処理できる場合があります）。',
      listLines(skipped.map((e) => ({ index: e.index, text: truncate(e.raw, 60) }))),
    ].join('\n'),
  )
}

interface OrderIssue {
  index: number
  type: string
  id: string
  need: string
  /** SDK が確実に UIMessageStreamError にする条件か（false は前のメッセージから続く場合の可能性あり） */
  hard: boolean
  /** start / delta / end の順序の違反か、ツール呼び出し・承認の参照先が無いか */
  kind: 'order' | 'reference'
}

/**
 * 続きのメッセージ（リクエストの最後のアシスタントメッセージ）がすでに持っているツール呼び出し。
 * 承認応答・クライアントツールの出力を返した後の再送では、サーバーは前回のストリームで作られた
 * ツール呼び出しを参照する chunk を返す。
 */
interface PriorTools {
  parts: Array<{ toolCallId: string; approvalId?: string }>
  /** 最後の step-start より前にあるツールパートの数（SDK の「現在のステップ」はその後ろ） */
  stepStart: number
}

/**
 * process-ui-message-stream.ts が UIMessageStreamError を投げる条件を再現する。
 * - text / reasoning の delta・end は、同じ id の start 済みで end 前のパートが必要（end で消えるので end 後の delta も NG）
 * - tool-input-delta は同じ toolCallId の tool-input-start が必要
 * - 承認・出力系は既知の toolCallId / approvalId が必要。ただし継続メッセージ（承認後の再送など）では
 *   前回のストリームで作られたツール呼び出しを参照するので、ストリームだけからは断定できない（hard: false）。
 *   リクエストの最後のアシスタントメッセージが分かるなら prior に渡し、そのツール呼び出しも「既知」として扱う
 * tool-input-available / tool-input-error は start 無しでもツール呼び出しを作るのでエラーではない。
 *
 * ツール呼び出しはメッセージのパート列として扱う。SDK は更新対象を「現在のステップ内の同じ toolCallId」から探し、
 * 無ければ新しいパートを作る（前のステップの同名パートは残る）。参照系は現在のステップ → 全体の順で探す。
 */
function checkOrder(events: readonly StreamEvent[], prior?: PriorTools): OrderIssue[] {
  const issues: OrderIssue[] = []
  const activeText = new Set<string>()
  const activeReasoning = new Set<string>()
  const partialTools = new Set<string>()
  const toolParts: Array<{ toolCallId: string; approvalId?: string }> =
    prior?.parts.map((part) => ({ ...part })) ?? []
  /** 現在のステップの先頭（start-step 時点のパート数。続きのメッセージなら、その最後のステップの先頭） */
  let stepStart = prior?.stepStart ?? 0

  const findInStep = (toolCallId: string) => {
    for (let i = stepStart; i < toolParts.length; i++) {
      if (toolParts[i]?.toolCallId === toolCallId) return toolParts[i]
    }
    return undefined
  }
  const findTool = (toolCallId: string) => {
    const inStep = findInStep(toolCallId)
    if (inStep !== undefined) return inStep
    for (let i = toolParts.length - 1; i >= 0; i--) {
      if (toolParts[i]?.toolCallId === toolCallId) return toolParts[i]
    }
    return undefined
  }
  const upsertTool = (toolCallId: string) => {
    if (findInStep(toolCallId) === undefined) toolParts.push({ toolCallId })
  }

  for (const { event, type } of jsonChunks(events)) {
    const data = isRecord(event.data) ? event.data : {}
    const id = typeof data.id === 'string' ? data.id : ''
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
    const approvalId = typeof data.approvalId === 'string' ? data.approvalId : ''
    const report = (
      need: string,
      hard: boolean,
      key: string,
      kind: OrderIssue['kind'] = 'order',
    ) => {
      issues.push({ index: event.index, type: type ?? '', id: key, need, hard, kind })
    }
    const needTool = () => {
      const part = findTool(toolCallId)
      if (part === undefined) {
        report(
          '先に同じ toolCallId のツール呼び出し（tool-input-*）が必要です',
          false,
          toolCallId,
          'reference',
        )
      }
      return part
    }

    switch (type) {
      case 'text-start':
        activeText.add(id)
        break
      case 'text-delta':
      case 'text-end':
        if (!activeText.has(id)) report('先に同じ id の text-start が必要です', true, id)
        else if (type === 'text-end') activeText.delete(id)
        break
      case 'reasoning-start':
        activeReasoning.add(id)
        break
      case 'reasoning-delta':
      case 'reasoning-end':
        if (!activeReasoning.has(id)) {
          report('先に同じ id の reasoning-start が必要です', true, id)
        } else if (type === 'reasoning-end') {
          activeReasoning.delete(id)
        }
        break
      case 'tool-input-start':
        partialTools.add(toolCallId)
        upsertTool(toolCallId)
        break
      case 'tool-input-delta':
        if (!partialTools.has(toolCallId)) {
          report('先に同じ toolCallId の tool-input-start が必要です', true, toolCallId)
        }
        break
      case 'tool-input-available':
      case 'tool-input-error':
        upsertTool(toolCallId)
        break
      case 'tool-approval-request': {
        const part = needTool()
        if (part !== undefined) part.approvalId = approvalId
        break
      }
      case 'tool-approval-response':
        if (!toolParts.some((part) => part.approvalId === approvalId)) {
          report(
            '先に同じ approvalId の tool-approval-request が必要です',
            false,
            approvalId,
            'reference',
          )
        }
        break
      case 'tool-output-available':
      case 'tool-output-error':
      case 'tool-output-denied':
        needTool()
        break
      case 'start-step':
        stepStart = toolParts.length
        break
      case 'reset-step':
        // 現在のステップのパートを破棄し、進行中の text / reasoning / tool-input も無かったことになる
        activeText.clear()
        activeReasoning.clear()
        partialTools.clear()
        toolParts.length = stepStart
        break
    }
  }
  return issues
}

/**
 * リクエスト body の最後のメッセージがアシスタントなら、そのツール呼び出しを返す。
 * SDK（useChat）はその最後のアシスタントメッセージに応答を続けて書き込む（そうでなければ新しいメッセージを作る）。
 * body が無い・JSON でない・messages が配列でない・ログの保持上限で切り詰められている場合は undefined
 * （継続かどうか分からない。切り詰め済みの body は、たまたま JSON として読めても全文ではないので使わない）。
 */
function priorToolsOf(
  entry: Pick<NetworkLogEntry, 'requestBody' | 'requestBodyTruncated'>,
): PriorTools | undefined {
  const { requestBody } = entry
  if (requestBody === undefined || entry.requestBodyTruncated === true) return undefined
  let json: unknown
  try {
    json = JSON.parse(requestBody)
  } catch {
    return undefined
  }
  if (!isRecord(json) || !Array.isArray(json.messages)) return undefined
  const last: unknown = json.messages.at(-1)
  const prior: PriorTools = { parts: [], stepStart: 0 }
  if (!isRecord(last) || last.role !== 'assistant' || !Array.isArray(last.parts)) return prior
  for (const part of last.parts as unknown[]) {
    if (!isRecord(part) || typeof part.type !== 'string') continue
    if (part.type === 'step-start') {
      prior.stepStart = prior.parts.length
    } else if (
      (part.type.startsWith('tool-') || part.type === 'dynamic-tool') &&
      typeof part.toolCallId === 'string'
    ) {
      const approvalId = isRecord(part.approval) ? part.approval.id : undefined
      prior.parts.push({
        toolCallId: part.toolCallId,
        ...(typeof approvalId === 'string' ? { approvalId } : {}),
      })
    }
  }
  return prior
}

function chunkOrder(v: View): Diagnostic | undefined {
  // 順序を検証するのは useChat（process-ui-message-stream）だけ。useCompletion は text-delta / error しか見ない
  if (v.entry.mode !== 'chat-ui') return undefined
  let issues = checkOrder(v.entry.events)
  // ストリームだけでは断定できない参照（hard: false）は、リクエストの最後のアシスタントメッセージを見て判定し直す。
  // 調べるのは必要なときだけ（添付つきの大きな body を毎回パースしないため）
  let contextKnown = false
  if (issues.some((i) => !i.hard)) {
    const prior = priorToolsOf(v.entry)
    if (prior !== undefined) {
      contextKnown = true
      // 続きのメッセージにも、このストリームにも無い参照先は、SDK が確実にエラーにする
      issues = checkOrder(v.entry.events, prior).map((i) =>
        i.kind === 'reference' ? { ...i, hard: true } : i,
      )
    }
  }
  if (issues.length === 0) return undefined
  const hard = issues.some((i) => i.hard)
  const lines = listLines(
    issues.map((i) => ({
      index: i.index,
      text: `${i.type}${i.id !== '' ? `（${i.id}）` : ''}: ${i.need}`,
    })),
  )
  if (!hard) {
    return diag(
      'ui-chunk-order',
      'warn',
      `対応するツール呼び出し・承認が見つからない chunk があります（${issues.length} 件）`,
      `前回の応答から続くメッセージ（ツール承認後の再送など）への応答であれば正常です。そうでなければ SDK が UIMessageStreamError にします。\n${lines}`,
    )
  }
  if (contextKnown && issues.every((i) => i.kind === 'reference')) {
    return diag(
      'ui-chunk-order',
      'error',
      `存在しないツール呼び出し・承認を参照する chunk があります（${issues.length} 件）`,
      `リクエストの最後のアシスタントメッセージにも、このストリームの中にも無い toolCallId / approvalId を参照しています。SDK はこれを UIMessageStreamError としてストリームを中断します。\n${lines}`,
    )
  }
  return diag(
    'ui-chunk-order',
    'error',
    `chunk の順序が不正です（${issues.length} 件）`,
    `AI SDK は、start より前に来た delta / end をエラー（UIMessageStreamError）としてストリームを中断します。\n${lines}`,
  )
}

function errorChunk(v: View): Diagnostic | undefined {
  const errors = jsonChunks(v.entry.events).filter((c) => c.type === 'error')
  if (errors.length === 0) return undefined
  return diag(
    'ui-stream-error-chunk',
    'error',
    `サーバーが error chunk を送信しました（${errors.length} 件）`,
    [
      'サーバー側でストリーム生成中にエラーが起きています。サーバーのログも確認してください（onError でメッセージを変換していない場合、既定ではエラー内容は隠されます）。',
      listLines(
        errors.map(({ event }) => {
          const text = isRecord(event.data) ? event.data.errorText : undefined
          return {
            index: event.index,
            text: typeof text === 'string' ? text : '（errorText なし）',
          }
        }),
      ),
    ].join('\n'),
  )
}

/** ストリームの終わり方（finish / [DONE] / 切断 / 空）に関する診断。 */
function termination(v: View): Diagnostic[] {
  const { entry } = v
  const list: Diagnostic[] = []

  if (v.truncated) {
    const last = entry.events.at(-1)
    list.push(
      diag(
        'ui-stream-truncated',
        'error',
        'ストリームが finish の前に切断されました',
        [
          entry.error ? `${entry.error.name}: ${entry.error.message}` : '',
          last
            ? `最後に受信したイベント: #${last.index}（${chunkType(last) ?? last.kind}）`
            : 'イベントを 1 件も受信できていません。',
          'サーバーが途中で落ちた、またはプロキシ / ロードバランサーのタイムアウトで切られた可能性があります。サーバー側のログを確認してください。',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      ),
    )
    return list
  }

  if (entry.state !== 'done' || !v.ok2xx) return list

  if (entry.events.length === 0) {
    list.push(
      diag(
        'ui-stream-empty',
        'warn',
        'レスポンスにイベントが 1 件もありません',
        'ステータスは 2xx ですが、ストリームの中身が空でした。サーバーが何も書き込まずに終了していないか確認してください。',
      ),
    )
    return list
  }
  // 本文が SSE でない場合は content-type の診断が説明するので、finish / [DONE] の有無は見ない
  if (!v.hasSseEvents) return list

  const unterminated = entry.events.filter((e) => e.incomplete === true)
  if (unterminated.length > 0) {
    list.push(
      diag(
        'sse-unterminated-event',
        'warn',
        '最後のイベントの後に空行がありません',
        [
          'SSE のイベントは空行（"\\n\\n"）で区切られます。最後のイベントの後ろに空行が無いまま接続が閉じたため、クライアント SDK はこのイベントを受け取りません（ここには救済して表示しています）。onFinish の finishReason なども得られません。',
          listLines(
            unterminated.map((e) => ({
              index: e.index,
              text: `${chunkType(e) ?? e.kind}（SDK 未受信）`,
            })),
          ),
          'サーバー側で、最後のイベントを書いたあとに空行を出力してください。',
        ].join('\n'),
      ),
    )
  }

  if (!v.hasFinish) {
    const hasAbort = jsonChunks(entry.events).some((c) => c.type === 'abort')
    list.push(
      hasAbort
        ? diag(
            'ui-stream-no-finish',
            'info',
            'finish ではなく abort chunk で終了しています',
            'サーバー側でストリームが中断されました。意図した動作か確認してください。',
          )
        : diag(
            'ui-stream-no-finish',
            'warn',
            'finish chunk がありません',
            'ストリームは終了しましたが、finish chunk が届いていません。onFinish の finishReason や messageMetadata が得られません。toUIMessageStream() のストリームをそのまま返しているか確認してください。',
          ),
    )
  }
  if (!entry.events.some((e) => e.kind === 'sse-done' && e.incomplete !== true)) {
    list.push(
      diag(
        'ui-stream-no-done',
        'info',
        '終端の data: [DONE] がありません',
        'SDK は [DONE] が無くても動作しますが、UI Message Stream の仕様では終端マーカーです。自前で SSE を組み立てている場合は末尾に追加してください。',
      ),
    )
  }
  return list
}

function summary(v: View): Diagnostic {
  const { entry } = v
  const count = `${entry.events.length}${entry.eventsTruncated ? '+' : ''}`
  const ms = (value: number | undefined) => (value === undefined ? '—' : formatDuration(value))
  return diag(
    'summary',
    'ok',
    'ストリームは正常に完了しました',
    `チャンク数 ${count} / TTFB ${ms(entry.ttfbMs)} / 合計 ${ms(entry.totalMs)}`,
  )
}

export function buildDiagnostics(
  entry: NetworkLogEntry,
  ctx?: { pageOrigin?: string },
): Diagnostic[] {
  const v = createView(entry, ctx)
  const list: Diagnostic[] = []
  const add = (d: Diagnostic | undefined) => {
    if (d !== undefined) list.push(d)
  }

  add(httpStatus(v))
  add(droppedHeaders(v))
  add(aborted(v))
  add(streamCancelled(v))
  add(networkError(v))
  add(proxyUnavailable(v))
  add(proxyError(v))
  add(contentType(v))
  add(uiStreamHeader(v))
  if (v.uiStream) {
    add(invalidJson(v))
    add(skippedEvents(v))
    add(unknownType(v))
    add(schemaInvalid(v))
    add(chunkOrder(v))
    add(errorChunk(v))
    list.push(...termination(v))
  }
  // 「正常に完了」と言えるのはエラーが無く、SDK が受け取れないイベントも残っていないとき。
  // 末尾が未終端のイベントは 'sse-unterminated-event'（warn）が説明するので、その横に緑の完了表示は並べない
  const sdkMissedEvent = v.uiStream && v.hasIncomplete
  if (entry.state === 'done' && !sdkMissedEvent && !list.some((d) => d.level === 'error')) {
    list.push(summary(v))
  }

  // error → warn → info → ok。同じレベルの中では生成順を保つ（sort は安定）
  return list.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}
