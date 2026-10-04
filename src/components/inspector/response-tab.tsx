import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { ClippedBody } from '@/components/inspector/clipped-body'
import { DetailSection } from '@/components/inspector/detail-section'
import { displayResponseHeaders, isInFlight } from '@/components/inspector/entry-utils'
import { HeadersTable } from '@/components/inspector/headers-table'
import { formatBody } from '@/components/inspector/json-utils'
import {
  maskRequest,
  maskResponseText,
  replaceSecretsInHeaders,
} from '@/components/inspector/secret-mask'
import { HttpStatusBadge, LogStateLabel } from '@/components/inspector/status-badge'
import { formatBytes, formatDuration } from '@/lib/format'
import type { NetworkLogEntry } from '@/types'

interface ResponseTabProps {
  entry: NetworkLogEntry
  revealSecrets: boolean
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  )
}

/**
 * レスポンスタブ。ステータス・タイミング・ヘッダー・本文。
 * 本文は、秘匿キーの値と、リクエストで送った認証情報と同じ値（エコー系のバックエンドが返す）を伏せる。
 * 呼び出し側で通信ごとに key を付け、本文の「全文を表示」の状態を作り直すこと。
 */
export function ResponseTab({ entry, revealSecrets }: ResponseTabProps) {
  const { responseHeaders, rawBody, targetUrl, requestHeaders, requestBody } = entry

  // ストリーミング中は rawBody が更新されるたびに伏せ直すが、リクエスト側の走査は通信ごとに 1 回で済ませる
  const secrets = useMemo(
    () =>
      revealSecrets ? undefined : maskRequest({ targetUrl, requestHeaders, requestBody }).secrets,
    [revealSecrets, targetUrl, requestHeaders, requestBody],
  )
  // レスポンスヘッダーは狭い名前規則で伏せ、さらにリクエストで送った認証情報と同じ値（エコーされたもの）は名前によらず伏せる
  const headers = useMemo(() => {
    if (responseHeaders === undefined) return undefined
    const shown = displayResponseHeaders(responseHeaders, revealSecrets)
    return secrets === undefined ? shown : replaceSecretsInHeaders(shown, secrets)
  }, [responseHeaders, revealSecrets, secrets])
  const body = useMemo(
    () => (secrets === undefined ? rawBody : maskResponseText(rawBody, secrets)),
    [secrets, rawBody],
  )
  const formatted = useMemo(() => formatBody(body), [body])

  return (
    <div className="space-y-4 p-3">
      <DetailSection title="ステータス">
        <div className="flex flex-wrap items-center gap-2">
          <HttpStatusBadge
            status={entry.status}
            statusText={entry.statusText}
            className="text-xs"
          />
          {entry.status === undefined ? (
            <span className="text-xs text-muted-foreground">レスポンスをまだ受信していません</span>
          ) : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border p-2 text-xs sm:grid-cols-4">
          <Metric
            label="TTFB"
            value={entry.ttfbMs === undefined ? '—' : formatDuration(entry.ttfbMs)}
          />
          <Metric
            label="合計"
            value={entry.totalMs === undefined ? '—' : formatDuration(entry.totalMs)}
          />
          <Metric label="受信バイト" value={formatBytes(entry.bytesReceived)} />
          <Metric label="状態" value={<LogStateLabel state={entry.state} />} />
        </dl>
      </DetailSection>

      <DetailSection
        title={`ヘッダー (${headers === undefined ? 0 : Object.keys(headers).length})`}
      >
        <HeadersTable
          headers={headers ?? {}}
          emphasize
          label="レスポンスヘッダー"
          emptyText={
            entry.status === undefined
              ? 'レスポンスヘッダーはまだありません'
              : 'レスポンスヘッダーはありません'
          }
        />
      </DetailSection>

      <DetailSection title="ボディ">
        {rawBody === '' ? (
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            {isInFlight(entry.state) ? '受信を待っています…' : 'ボディはありません'}
          </p>
        ) : (
          <>
            {entry.rawBodyTruncated ? (
              <p
                role="note"
                className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200"
              >
                ボディが保存上限を超えたため、先頭部分だけを保持しています（受信したのは{' '}
                {formatBytes(entry.bytesReceived)}）。
              </p>
            ) : null}
            {body !== rawBody ? (
              <p className="text-xs text-muted-foreground">
                認証情報らしい値（キー名と、リクエストで送ったトークンとの一致から判定）はマスクしています。ヘッダーの「秘匿情報を表示」で切り替えられます。
              </p>
            ) : null}
            <ClippedBody formatted={formatted} copyText={body} label="レスポンス本文" />
          </>
        )}
      </DetailSection>
    </div>
  )
}
