import { displayHeaders, displayResponseHeaders } from '@/components/inspector/entry-utils'
import {
  maskDiagnostic,
  maskEntryError,
  maskRequest,
  maskResponseText,
  maskStreamEvent,
  replaceSecretsInHeaders,
} from '@/components/inspector/secret-mask'
import type { NetworkLogEntry } from '@/types'

/** マスクして保存したときに、ファイルと保存直後のトーストへ載せる「何を伏せて、何を保証しないか」。 */
export const MASKING_NOTE =
  'ヘッダーの認証情報、URL のクエリ・user:pass、JSON / フォーム本文の秘匿らしいキーの値、' +
  '設定中のトークンと同じ値をマスクしています。キー名で判定できない場所に含まれる秘密は伏せられないため、共有前に内容を確認してください。'

export interface EntryExport {
  exportedAt: string
  /**
   * マスクを適用したか。true でも秘密が残らない保証ではなく、範囲と限界は maskingNote に書く。
   * 適用するのは Authorization / Cookie などのヘッダー、URL、リクエスト・レスポンス本文、イベント、エラー文。
   */
  secretsMasked: boolean
  /** secretsMasked のときだけ付く、マスクの範囲と限界 */
  maskingNote?: string
  entry: NetworkLogEntry
}

/** 保存用に、秘匿情報をマスクした複製を作る（元のエントリは書き換えない）。 */
function maskEntry(entry: NetworkLogEntry): NetworkLogEntry {
  const { url, body, secrets } = maskRequest(entry)
  return {
    ...entry,
    targetUrl: url,
    // リクエストとレスポンスでヘッダー名の判定が違う（レスポンスは狭い）。どちらも既知の秘匿値は名前によらず伏せる
    requestHeaders: replaceSecretsInHeaders(displayHeaders(entry.requestHeaders, false), secrets),
    ...(body !== undefined ? { requestBody: body } : {}),
    ...(entry.responseHeaders !== undefined
      ? {
          responseHeaders: replaceSecretsInHeaders(
            displayResponseHeaders(entry.responseHeaders, false),
            secrets,
          ),
        }
      : {}),
    events: entry.events.map((event) => maskStreamEvent(event, secrets)),
    rawBody: maskResponseText(entry.rawBody, secrets),
    ...(entry.error !== undefined ? { error: maskEntryError(entry.error, secrets) } : {}),
    diagnostics: entry.diagnostics.map((item) => maskDiagnostic(item, secrets)),
  }
}

/** 保存用のペイロード。マスクは画面表示と同じ規則（revealSecrets）に従い、ヘッダー以外にも及ぶ。 */
export function buildEntryExport(
  entry: NetworkLogEntry,
  opts: { revealSecrets: boolean; now?: number },
): EntryExport {
  const { revealSecrets, now = Date.now() } = opts
  return {
    exportedAt: new Date(now).toISOString(),
    secretsMasked: !revealSecrets,
    ...(revealSecrets ? {} : { maskingNote: MASKING_NOTE }),
    entry: revealSecrets ? entry : maskEntry(entry),
  }
}

export function serializeEntryExport(
  entry: NetworkLogEntry,
  opts: { revealSecrets: boolean; now?: number },
): string {
  return JSON.stringify(buildEntryExport(entry, opts), null, 2)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** ローカル時刻の YYYYMMDD-HHMMSS。ファイル名用。 */
export function formatFileStamp(epochMs: number): string {
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function exportFileName(entry: Pick<NetworkLogEntry, 'id' | 'startedAt'>): string {
  // id は内部採番だが、念のためファイル名に使えない文字は潰す
  const safeId = entry.id.replace(/[^\w.-]+/g, '_')
  return `ai-sdk-log_${safeId}_${formatFileStamp(entry.startedAt)}.json`
}
