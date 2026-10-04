import type { ReactNode } from 'react'
import { CodeBlock, CodeBlockContainer } from '@/components/ai-elements/code-block'
import { HIGHLIGHT_MAX_CHARS } from '@/components/inspector/json-utils'
import { cn } from '@/lib/utils'

export interface JsonBlockProps {
  /** 整形済みの JSON 文字列 */
  code: string
  /** true の間は素の pre で見せる（ストリーミング中に更新のたびに再ハイライトしないため） */
  plain?: boolean
  /** 本文の上に出すヘッダー。ハイライトの有無にかかわらず同じものを出す */
  header?: ReactNode
  className?: string
  /** 素の pre だけに効く。既定は高さ上限つき（呼び出し側がスクロールするなら max-h-none） */
  preClassName?: string
}

/**
 * チャット内の JSON 表示。shiki のハイライトは同期的に重く、トークンごとに span を作るため、
 * 閾値（インスペクタの CodeView と同じ）を超える JSON と、更新中の JSON は素の pre にする。
 */
export function JsonBlock({
  code,
  plain = false,
  header,
  className,
  preClassName,
}: JsonBlockProps) {
  if (plain || code.length > HIGHLIGHT_MAX_CHARS) {
    return (
      <CodeBlockContainer language="json" className={className} data-json-block="plain">
        {header}
        <pre className={cn('m-0 max-h-96 overflow-auto p-4 font-mono text-sm', preClassName)}>
          {code}
        </pre>
      </CodeBlockContainer>
    )
  }
  return (
    <CodeBlock code={code} language="json" className={className} data-json-block="highlighted">
      {header}
    </CodeBlock>
  )
}
