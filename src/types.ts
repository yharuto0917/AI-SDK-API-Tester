/**
 * アプリ全体で共有するドメイン型（契約）。
 * lib / hooks / components / views はここで定義した型だけを介して連携する。
 * このファイルを変更する場合は、利用側すべてへの影響を確認すること。
 */

/** 接続モード。 */
export type Mode =
  /** useChat + DefaultChatTransport（UI Message Stream / SSE） */
  | 'chat-ui'
  /** useChat + TextStreamChatTransport（プレーンテキストのストリーム） */
  | 'chat-text'
  /** useCompletion（data / text プロトコル） */
  | 'completion'
  /** 任意の HTTP リクエストを送り、レスポンスをそのまま観察する */
  | 'raw'

export const MODES: readonly Mode[] = ['chat-ui', 'chat-text', 'completion', 'raw']

export const MODE_LABELS: Record<Mode, string> = {
  'chat-ui': 'Chat (UI Message Stream)',
  'chat-text': 'Chat (Text Stream)',
  completion: 'Completion',
  raw: 'Raw HTTP',
}

export interface HeaderEntry {
  /** React key / 編集用の安定 ID */
  id: string
  name: string
  value: string
  enabled: boolean
}

export type CredentialsMode = 'omit' | 'same-origin' | 'include'
export type RawMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type CompletionProtocol = 'data' | 'text'

/**
 * 接続設定。localStorage に永続化する（ただし bearerToken だけは sessionStorage）。
 * 読み込み時は必ず normalizeSettings() を通し、壊れた保存値でも落ちないようにする。
 */
export interface ConnectionSettings {
  /** 現在選択中のモード */
  mode: Mode
  /** モードごとのエンドポイント URL（絶対 URL または相対パス）。実行時に毎回ここから解決する */
  endpoints: Record<Mode, string>
  /** 追加リクエストヘッダー（enabled のものだけ送る） */
  headers: HeaderEntry[]
  /** Authorization: Bearer <token> として送る。明示的な Authorization ヘッダーがあればそちらを優先。永続化は sessionStorage のみ */
  bearerToken: string
  /** リクエスト body にマージする JSON オブジェクトのテキスト（空文字なら何もしない）。Chat / Completion のみ */
  extraBody: string
  credentials: CredentialsMode
  /** Vite の開発プロキシ（/__proxy）経由で送る。CORS 回避用 */
  useDevProxy: boolean
  /** Chat: messages 配列を最後の 1 件だけに絞って送る（サーバー側で履歴を持つバックエンド向け） */
  sendLastMessageOnly: boolean
  /** Chat (UI): ツール出力 / 承認応答が揃ったら自動で再送する（sendAutomaticallyWhen） */
  autoSendAfterToolOutput: boolean
  completionProtocol: CompletionProtocol
  rawMethod: RawMethod
  /** Raw モードで送る body（文字列のまま送る） */
  rawBody: string
}

// ---------------------------------------------------------------------------
// ネットワークログ
// ---------------------------------------------------------------------------

export type LogState = 'pending' | 'streaming' | 'done' | 'error' | 'aborted'

export type StreamEventKind =
  /** SSE の data が JSON としてパースできた */
  | 'sse-json'
  /** SSE の data が JSON ではない（parseError が付く場合あり） */
  | 'sse-text'
  /** data: [DONE] */
  | 'sse-done'
  /** SSE コメント行（": ping" など） */
  | 'sse-comment'
  /** SSE ではないストリーム（Text Stream 等）の 1 チャンク */
  | 'text-chunk'

export interface StreamEvent {
  /** 0 始まりの通し番号 */
  index: number
  /** リクエスト開始からの経過ミリ秒 */
  atMs: number
  kind: StreamEventKind
  /** SSE の `event:` フィールド */
  eventName?: string
  /** kind が 'sse-json' で data.type が文字列のとき、その値 */
  type?: string
  /** kind が 'sse-json' のときのパース済み JSON */
  data?: unknown
  /** 元のペイロード文字列。1 件あたりの上限を超えると切り詰める（rawTruncated） */
  raw: string
  parseError?: string
  /**
   * raw を保持の上限で切り詰めた。このとき data も省略版（長い文字列は先頭だけ、入れ子のオブジェクト・配列は
   * 件数の注記に置換）になるが、type / id / toolCallId などの短い値は残る
   */
  rawTruncated?: boolean
  /** 巨大すぎて JSON かどうかの判定自体を省略したイベント（kind は 'sse-text'）。パース失敗とは区別する */
  parseSkipped?: boolean
  /**
   * 最後が空行で終わっておらず、クライアント SDK は受け取らないイベント。
   * ストリーム終了時にデバッグ用として表示しているだけなので、SDK の動作を再現する診断からは除く
   */
  incomplete?: boolean
  /**
   * kind が 'sse-json' で、SDK の uiMessageChunkSchema に合わなかった理由（日本語）。
   * 検証は非同期なので、ストリーム受信後しばらくして付く。chat-ui / completion のときだけ検証する
   */
  schemaError?: string
}

export type DiagnosticLevel = 'ok' | 'info' | 'warn' | 'error'

export interface Diagnostic {
  /** 安定した識別子（例: 'stream-header-missing'）。テストで参照する */
  id: string
  level: DiagnosticLevel
  /** 日本語の短い見出し */
  title: string
  /** 日本語の詳細・対処方法 */
  detail?: string
}

export interface NetworkLogEntry {
  id: string
  mode: Mode
  /** epoch ミリ秒 */
  startedAt: number
  method: string
  /** ユーザーが指定したターゲット URL（プロキシ経由でも /__proxy ではなくこちらを入れる） */
  targetUrl: string
  viaProxy: boolean
  /** 実際にターゲットへ送られる実効ヘッダー（マスクなし。表示・コピー時に maskSecrets で処理する） */
  requestHeaders: Record<string, string>
  /** 指定されたが、ブラウザの仕様（Cookie / Origin など）で送信されないヘッダー名（小文字）。値は持たない */
  droppedHeaders?: string[]
  /** リクエスト body。添付の data URL などで巨大になりうるため、上限を超えると先頭だけを保持する（requestBodyTruncated） */
  requestBody?: string
  /** requestBody を保持の上限で切り詰めた（実際に送った内容の全文ではない）。切り詰めたときだけ true で、無ければキーごと省く */
  requestBodyTruncated?: boolean
  state: LogState
  status?: number
  statusText?: string
  /** レスポンスヘッダー（キーは小文字） */
  responseHeaders?: Record<string, string>
  /** ヘッダー受信までのミリ秒 */
  ttfbMs?: number
  /** ストリーム完了（または失敗）までのミリ秒 */
  totalMs?: number
  events: StreamEvent[]
  eventsTruncated: boolean
  /** デコード済みボディ全文（上限あり） */
  rawBody: string
  rawBodyTruncated: boolean
  bytesReceived: number
  error?: { name: string; message: string; hint?: string }
  diagnostics: Diagnostic[]
}
