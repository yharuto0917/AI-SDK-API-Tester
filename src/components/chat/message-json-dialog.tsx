import type { UIMessage } from 'ai'
import { CheckIcon, CopyIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  CodeBlockActions,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ai-elements/code-block'
import { messagesToDisplayJson } from '@/components/chat/chat-utils'
import { JsonBlock } from '@/components/chat/json-block'
import { HIGHLIGHT_MAX_CHARS } from '@/components/inspector/json-utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface MessageJsonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  messages: UIMessage[]
  /** 受信中。更新のたびに全体を再ハイライトしないよう、この間は素のテキストで見せる */
  streaming?: boolean
}

/**
 * コピー対象を props で受け取るコピーボタン。
 * CodeBlockCopyButton は CodeBlock の中でしか code を知らないが、ここはハイライトしない表示でも全文をコピーしたい。
 */
function CopyJsonButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('JSON をコピーしました')
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('コピーに失敗しました')
    }
  }

  const Icon = copied ? CheckIcon : CopyIcon
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="shrink-0"
      aria-label="JSON をコピー"
      title="JSON をコピー"
      onClick={() => void handleClick()}
    >
      <Icon size={14} aria-hidden />
    </Button>
  )
}

/** useChat が持っている messages をそのまま JSON で確認する（SDK がサーバー応答をどう解釈したかの検証用）。 */
export function MessageJsonDialog({
  open,
  onOpenChange,
  messages,
  streaming = false,
}: MessageJsonDialogProps) {
  // 閉じている間は計算しない（ストリーミング中の messages 更新ごとに整形するのは無駄）
  const json = useMemo(() => (open ? messagesToDisplayJson(messages) : ''), [open, messages])
  const tooLong = json.length > HIGHLIGHT_MAX_CHARS

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" showCloseButton={false}>
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            aria-label="閉じる"
          >
            <XIcon aria-hidden />
          </Button>
        </DialogClose>
        <DialogHeader>
          <DialogTitle>メッセージ JSON</DialogTitle>
          <DialogDescription>
            useChat の messages（{messages.length} 件）です。長い data URL は省略して表示します。
            {tooLong
              ? ` ${json.length.toLocaleString()} 文字と長いため、色付けは省略しています。`
              : ''}
            {streaming && !tooLong ? ' 受信中は色付けを止めています。' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-md" data-testid="message-json">
          <JsonBlock
            code={json}
            plain={streaming}
            preClassName="max-h-none"
            header={
              <CodeBlockHeader>
                <CodeBlockTitle>
                  <CodeBlockFilename>messages.json</CodeBlockFilename>
                </CodeBlockTitle>
                <CodeBlockActions>
                  <CopyJsonButton text={json} />
                </CodeBlockActions>
              </CodeBlockHeader>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
