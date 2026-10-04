import { formatDuration } from '@/lib/format'
import { maskHeaders, maskSecretValue } from '@/lib/curl'
import type { LogState, NetworkLogEntry } from '@/types'

export const LOG_STATE_LABELS: Readonly<Record<LogState, string>> = {
  pending: '送信中',
  streaming: '受信中',
  done: '完了',
  error: 'エラー',
  aborted: '中断',
}

/** まだ通信が終わっていない（pending / streaming）か。 */
export function isInFlight(state: LogState): boolean {
  return state === 'pending' || state === 'streaming'
}

export interface SplitUrl {
  /** 'https://example.com:8080' のような部分。相対パスや解釈できない文字列では空文字 */
  origin: string
  /** パス + クエリ + ハッシュ。 */
  path: string
}

/** 一覧でホストを薄く・パスを強調して見せるために URL を分ける。 */
export function splitUrl(url: string): SplitUrl {
  try {
    const parsed = new URL(url)
    // http / https 以外（file: など）や origin が 'null' のものは分けても意味が無い
    if (parsed.origin === 'null') return { origin: '', path: url }
    return { origin: parsed.origin, path: `${parsed.pathname}${parsed.search}${parsed.hash}` }
  } catch {
    return { origin: '', path: url }
  }
}

export type StatusTone = 'success' | 'info' | 'error' | 'none'

/** ステータスコードの色分け。2xx 緑 / 1xx・3xx 青 / 4xx・5xx 赤 / 未受信・不明は none。 */
export function statusTone(status: number | undefined): StatusTone {
  if (status === undefined || !Number.isFinite(status)) return 'none'
  if (status >= 200 && status < 300) return 'success'
  if ((status >= 100 && status < 200) || (status >= 300 && status < 400)) return 'info'
  if (status >= 400 && status < 600) return 'error'
  return 'none'
}

/**
 * 表示・コピー・エクスポートに使う「リクエスト」ヘッダー。秘匿情報を表示しない設定のときはマスクする。
 * 名前の判定は lib の広い規則（auth / key / token など）。レスポンスヘッダーには使わず、displayResponseHeaders を使うこと。
 */
export function displayHeaders(
  headers: Record<string, string>,
  revealSecrets: boolean,
): Record<string, string> {
  return revealSecrets ? headers : maskHeaders(headers)
}

/**
 * 値を隠すレスポンスヘッダー名（小文字・完全一致）。
 * リクエスト側と同じ広い名前判定を使うと、`access-control-allow-credentials: true`（当アプリの CORS 診断が
 * 「見てほしい」と案内するヘッダー）や `www-authenticate`、`x-ratelimit-remaining-tokens` のような、
 * 秘密ではないヘッダーまで隠れて診断の役に立たなくなる。レスポンスで本当に秘密を運ぶ名前だけに絞る。
 */
const SENSITIVE_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'set-cookie',
  'set-cookie2',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
])

/** 値を隠すレスポンスヘッダー名か（大文字小文字は区別しない完全一致）。 */
export function isSensitiveResponseHeaderName(name: string): boolean {
  return SENSITIVE_RESPONSE_HEADERS.has(name.trim().toLowerCase())
}

/**
 * 表示・コピー・エクスポートに使う「レスポンス」ヘッダー。秘匿情報を表示しない設定のときは、
 * 名簿（SENSITIVE_RESPONSE_HEADERS）にある名前の値だけをマスクする。マスクの形式はリクエスト側と同じ。
 */
export function displayResponseHeaders(
  headers: Record<string, string>,
  revealSecrets: boolean,
): Record<string, string> {
  if (revealSecrets) return headers
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    result[name] = isSensitiveResponseHeaderName(name) ? maskSecretValue(value) : value
  }
  return result
}

/** レスポンスヘッダーのうち、AI SDK のバックエンド確認で特に見たいもの。 */
const EMPHASIZED_HEADERS: ReadonlySet<string> = new Set([
  'x-vercel-ai-ui-message-stream',
  'content-type',
])

export function isEmphasizedHeader(name: string): boolean {
  return EMPHASIZED_HEADERS.has(name.toLowerCase())
}

/** 一覧に出す所要時間。完了前は計測値が無いので '—'。 */
export function durationLabel(entry: Pick<NetworkLogEntry, 'totalMs'>): string {
  return entry.totalMs === undefined ? '—' : formatDuration(entry.totalMs)
}
