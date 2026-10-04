import { Copy } from 'lucide-react'
import { useId } from 'react'
import { toast } from 'sonner'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { MessageResponse } from '@/components/ai-elements/message'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { countCharacters } from '@/components/completion/completion-format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export interface CompletionResultProps {
  completion: string
  isLoading: boolean
  /** true なら Markdown として描画、false なら受信した文字列をそのまま表示 */
  markdown: boolean
  onMarkdownChange: (markdown: boolean) => void
  /** 正常終了したのに出力が空だった */
  emptyResult: boolean
  className?: string
}

/** Completion の出力表示。ストリーミング中は末尾に追従し、スクロールで離れれば追従をやめる。 */
export function CompletionResult({
  completion,
  isLoading,
  markdown,
  onMarkdownChange,
  emptyResult,
  className,
}: CompletionResultProps) {
  const switchId = useId()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(completion)
      toast.success('出力をコピーしました')
    } catch {
      toast.error('コピーに失敗しました')
    }
  }

  const waiting = isLoading && completion === ''
  const showEmptyState = completion === '' && !isLoading

  return (
    <section
      aria-label="出力"
      className={cn('flex min-h-48 flex-1 flex-col overflow-hidden rounded-lg border', className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2">
        <h3 className="text-sm font-medium">出力</h3>
        {isLoading && (
          <span role="status" className="flex items-center gap-1.5 text-xs">
            <Spinner role="presentation" aria-label={undefined} aria-hidden className="size-3.5" />
            <Shimmer as="span">生成中…</Shimmer>
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <Badge variant="secondary" className="tabular-nums">
            {countCharacters(completion).toLocaleString('ja-JP')} 文字
          </Badge>
          <div className="flex items-center gap-2">
            <Switch id={switchId} size="sm" checked={markdown} onCheckedChange={onMarkdownChange} />
            <Label htmlFor={switchId} className="text-xs">
              Markdown 表示
            </Label>
          </div>
          <Button variant="ghost" size="sm" onClick={copy} disabled={completion === ''}>
            <Copy aria-hidden />
            コピー
          </Button>
        </div>
      </div>

      {showEmptyState ? (
        <ConversationEmptyState
          className="flex-1"
          title={emptyResult ? '出力が空でした' : 'まだ出力はありません'}
          description={
            emptyResult
              ? 'レスポンスにテキストが含まれていませんでした。サーバーの出力形式に合わせて、設定パネルのプロトコル（data / text）を確認してください。'
              : 'プロンプトを入力して「生成」を押すと、ここに出力が表示されます。'
          }
        />
      ) : (
        <Conversation className="min-h-0">
          <ConversationContent className="gap-0 p-3">
            {waiting ? (
              <Shimmer as="span" className="text-sm">
                応答を待っています…
              </Shimmer>
            ) : markdown ? (
              <div className="text-sm">
                <MessageResponse isAnimating={isLoading}>{completion}</MessageResponse>
              </div>
            ) : (
              // completion は素の出力を検証するのが主目的なので、既定は加工しない生テキスト
              <pre className="font-mono text-sm break-words whitespace-pre-wrap">{completion}</pre>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}
    </section>
  )
}
