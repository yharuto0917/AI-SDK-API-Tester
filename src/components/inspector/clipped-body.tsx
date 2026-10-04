import { useMemo, useState } from 'react'
import { CodeView } from '@/components/inspector/code-view'
import { CopyButton } from '@/components/inspector/copy-button'
import { clipText } from '@/components/inspector/json-utils'
import type { FormattedBody } from '@/components/inspector/json-utils'
import { Button } from '@/components/ui/button'

/** 本文のうち、最初に描画する文字数。超える分は「全文を表示」で出す。 */
export const BODY_PREVIEW_CHARS = 30_000

/**
 * 「全文を表示」でも描画する文字数の上限。
 * リクエスト本文は添付ファイルの data URL で数 MB～数十 MB になりうるので、押しても固まらないよう上限を置く
 * （超える分はコピーでだけ取り出せる）。
 */
export const BODY_FULL_VIEW_MAX_CHARS = 2_000_000

interface ClippedBodyProps {
  /** 表示用に整形した本文 */
  formatted: FormattedBody
  /** コピーする文字列。整形・切り詰め前の原文（マスクする設定のときはマスク済みの原文） */
  copyText: string
  /** 「リクエストボディ」「レスポンス本文」など、コピーのトースト名と案内に使う名前 */
  label: string
}

/**
 * 本文の表示。長いときは先頭だけを描画し、全文はボタンで出す（巨大な本文で UI が固まらないように）。
 * 全文を表示した状態は内部に持つので、呼び出し側で通信ごとに key を付けて作り直すこと。
 */
export function ClippedBody({ formatted, copyText, label }: ClippedBodyProps) {
  const [showAll, setShowAll] = useState(false)
  const limit = showAll ? BODY_FULL_VIEW_MAX_CHARS : BODY_PREVIEW_CHARS
  const view = useMemo(() => clipText(formatted.text, limit), [formatted.text, limit])

  return (
    <>
      {view.clipped ? (
        <div
          role="note"
          className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs"
        >
          <span className="mr-auto text-muted-foreground">
            {showAll
              ? `表示上限（${BODY_FULL_VIEW_MAX_CHARS.toLocaleString('ja-JP')} 文字）を超えるため、先頭のみ表示しています`
              : `先頭 ${BODY_PREVIEW_CHARS.toLocaleString('ja-JP')} 文字のみ表示しています`}
            （全 {view.total.toLocaleString('ja-JP')} 文字）
          </span>
          <CopyButton text={copyText} label={`${label}の全文`} variant="outline">
            全文をコピー
          </CopyButton>
          {showAll ? null : (
            <Button type="button" variant="outline" size="xs" onClick={() => setShowAll(true)}>
              全文を表示
            </Button>
          )}
        </div>
      ) : null}
      <CodeView
        code={view.text}
        language={formatted.kind === 'json' ? 'json' : 'text'}
        title={formatted.kind === 'json' ? 'JSON' : 'テキスト'}
        copyLabel={label}
        copyText={copyText}
        className={showAll ? 'max-h-[32rem]' : undefined}
      />
    </>
  )
}
