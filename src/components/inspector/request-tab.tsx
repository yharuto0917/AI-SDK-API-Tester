import { TriangleAlertIcon, WaypointsIcon } from 'lucide-react'
import { useMemo } from 'react'
import { toast } from 'sonner'
import {
  Snippet,
  SnippetAddon,
  SnippetCopyButton,
  SnippetInput,
  SnippetText,
} from '@/components/ai-elements/snippet'
import { BODY_PREVIEW_CHARS, ClippedBody } from '@/components/inspector/clipped-body'
import { CodeView } from '@/components/inspector/code-view'
import { DetailSection } from '@/components/inspector/detail-section'
import { displayHeaders } from '@/components/inspector/entry-utils'
import { HeadersTable } from '@/components/inspector/headers-table'
import { formatBody } from '@/components/inspector/json-utils'
import { maskRequest } from '@/components/inspector/secret-mask'
import { toCurl } from '@/lib/curl'
import { PROXY_NAME } from '@/lib/proxy'
import type { NetworkLogEntry } from '@/types'

/**
 * リクエスト本文として保持する文字数の上限。lib/network-log.ts の既定値（非公開）と一致させる。
 * 切り詰めた本文の文字数ではなく固定の数字を出すのは、上限そのものを案内するため。
 */
const REQUEST_BODY_KEEP_LIMIT = 200_000

interface RequestTabProps {
  entry: NetworkLogEntry
  /** true のとき Authorization などをマスクせずに表示・コピーする */
  revealSecrets: boolean
}

/** URL・本文の値までマスクしたときの注記。ヘッダーの注記と同じ文体にそろえる。 */
function MaskedNote() {
  return (
    <p className="text-xs text-muted-foreground">
      認証情報らしい値（キー名と設定中のトークンから判定）はマスクしています。ヘッダーの「秘匿情報を表示」で切り替えられます。
    </p>
  )
}

/**
 * リクエストタブ。宛先・ヘッダー・ボディ・cURL。マスク規則は「秘匿情報を表示」に従い、
 * ヘッダーだけでなく URL のクエリ・本文の秘匿キーの値も伏せる（表示・コピー・cURL のすべて）。
 * 呼び出し側で通信ごとに key を付け、本文の「全文を表示」の状態を作り直すこと。
 */
export function RequestTab({ entry, revealSecrets }: RequestTabProps) {
  const { requestHeaders, requestBody, method, targetUrl, requestBodyTruncated, droppedHeaders } =
    entry

  const headers = useMemo(
    () => displayHeaders(requestHeaders, revealSecrets),
    [requestHeaders, revealSecrets],
  )
  const masked = useMemo(
    () => Object.entries(headers).some(([name, value]) => value !== requestHeaders[name]),
    [headers, requestHeaders],
  )
  const mask = useMemo(
    () => (revealSecrets ? undefined : maskRequest({ targetUrl, requestHeaders, requestBody })),
    [revealSecrets, targetUrl, requestHeaders, requestBody],
  )
  // 表示・コピー・cURL はすべて、ここで決めた（マスク済みかもしれない）URL と本文から作る
  const url = mask?.url ?? targetUrl
  const bodyText = mask === undefined ? requestBody : mask.body
  const body = useMemo(
    () => (bodyText === undefined || bodyText === '' ? undefined : formatBody(bodyText)),
    [bodyText],
  )

  // 添付ファイルの data URL などで本文が巨大になりうる。画面にはその全文を含む cURL を出さず、コピー時にだけ作る
  const bodyIsLarge = bodyText !== undefined && bodyText.length > BODY_PREVIEW_CHARS
  const curlPreview = useMemo(
    () =>
      toCurl(
        {
          method,
          targetUrl: url,
          requestHeaders,
          requestBody: bodyIsLarge
            ? `<省略: ${bodyText.length.toLocaleString('ja-JP')} 文字。コピーすると全文が入ります>`
            : bodyText,
          requestBodyTruncated,
        },
        { maskSecrets: !revealSecrets },
      ),
    [method, url, requestHeaders, bodyText, bodyIsLarge, requestBodyTruncated, revealSecrets],
  )
  const copyFullCurl = () =>
    toCurl(
      { method, targetUrl: url, requestHeaders, requestBody: bodyText, requestBodyTruncated },
      { maskSecrets: !revealSecrets },
    )

  return (
    <div className="space-y-4 p-3">
      <DetailSection title="宛先">
        <Snippet code={url} className="text-xs">
          <SnippetAddon>
            <SnippetText className="font-semibold text-foreground">{method}</SnippetText>
          </SnippetAddon>
          <SnippetInput aria-label="宛先 URL" className="text-xs md:text-xs" />
          <SnippetAddon align="inline-end">
            <SnippetCopyButton
              aria-label="宛先 URL をコピー"
              title="宛先 URL をコピー"
              onCopy={() => toast.success('宛先 URL をコピーしました')}
              onError={() => toast.error('宛先 URL をコピーできませんでした')}
            />
          </SnippetAddon>
        </Snippet>
        {url !== targetUrl ? <MaskedNote /> : null}
        {entry.viaProxy ? (
          <p className="flex items-start gap-1.5 text-xs text-sky-700 dark:text-sky-300">
            <WaypointsIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>{PROXY_NAME}経由（実際の宛先はこの URL）</span>
          </p>
        ) : null}
      </DetailSection>

      <DetailSection title={`ヘッダー (${Object.keys(headers).length})`}>
        <HeadersTable headers={headers} label="リクエストヘッダー" />
        {masked ? (
          <p className="text-xs text-muted-foreground">
            認証情報の値はマスクしています。ヘッダーの「秘匿情報を表示」で切り替えられます。
          </p>
        ) : null}
        {droppedHeaders !== undefined && droppedHeaders.length > 0 ? (
          // 値は持たない（Cookie など、実際には送っていないので出せる値も無い）。名前だけを控えめに知らせる
          <p className="text-xs text-muted-foreground">
            {`ブラウザの仕様で送信されなかったヘッダー: ${droppedHeaders.join(', ')}`}
          </p>
        ) : null}
      </DetailSection>

      <DetailSection title="ボディ">
        {body === undefined ? (
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            ボディはありません
          </p>
        ) : (
          <>
            {bodyText !== requestBody ? <MaskedNote /> : null}
            {requestBodyTruncated === true ? (
              <p
                role="note"
                className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200"
              >
                <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  リクエスト本文は保持の上限（{REQUEST_BODY_KEEP_LIMIT.toLocaleString('ja-JP')}{' '}
                  文字）で切り詰められています。cURL は実際の送信内容を再現しません
                </span>
              </p>
            ) : null}
            <ClippedBody formatted={body} copyText={bodyText ?? ''} label="リクエストボディ" />
          </>
        )}
      </DetailSection>

      <DetailSection title="cURL">
        <CodeView
          code={curlPreview}
          language="bash"
          title="bash"
          copyLabel="cURL"
          copyText={bodyIsLarge ? copyFullCurl : undefined}
        />
      </DetailSection>
    </div>
  )
}
