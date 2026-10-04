import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContainer,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ai-elements/code-block'
import { CopyButton } from '@/components/inspector/copy-button'
import { HIGHLIGHT_MAX_CHARS } from '@/components/inspector/json-utils'
import { cn } from '@/lib/utils'

interface CodeViewProps {
  code: string
  language: 'json' | 'bash' | 'text'
  /** ヘッダーの見出し。compact のときはヘッダー自体を出さない */
  title?: string
  /** コピーしたときのトースト名 */
  copyLabel: string
  /** コピーする文字列。code と違う（切り詰めていない全文など）ときだけ渡す。関数なら押した時点で作る */
  copyText?: string | (() => string)
  /** ヘッダー無し・余白小さめ（展開した行の中などで使う） */
  compact?: boolean
  className?: string
}

/**
 * AI Elements の CodeBlock（shiki）で表示する。
 * ただし shiki のハイライトは非同期で重いので、text 指定のとき・長すぎるときは素の pre にする。
 */
export function CodeView({
  code,
  language,
  title,
  copyLabel,
  copyText,
  compact = false,
  className,
}: CodeViewProps) {
  const header = compact ? null : (
    <CodeBlockHeader>
      <CodeBlockTitle>
        <span>{title ?? language}</span>
      </CodeBlockTitle>
      <CodeBlockActions>
        <CopyButton text={copyText ?? code} label={copyLabel} />
      </CodeBlockActions>
    </CodeBlockHeader>
  )

  if (language === 'text' || code.length > HIGHLIGHT_MAX_CHARS) {
    return (
      <CodeBlockContainer
        language={language}
        className={cn('flex max-h-80 flex-col', className)}
        data-code-view="plain"
      >
        {header}
        <pre
          className={cn(
            'm-0 min-h-0 flex-1 overflow-auto font-mono text-xs break-all whitespace-pre-wrap',
            compact ? 'p-2' : 'p-3',
          )}
        >
          {code}
        </pre>
      </CodeBlockContainer>
    )
  }

  return (
    <CodeBlock
      code={code}
      language={language}
      className={cn('flex max-h-80 flex-col', compact && '[&_pre]:p-2 [&_code]:text-xs', className)}
      data-code-view="highlighted"
    >
      {header}
    </CodeBlock>
  )
}
