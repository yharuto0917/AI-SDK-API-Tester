import type { ChatStatus, UIMessage } from 'ai'
import { ChevronDownIcon, CopyIcon } from 'lucide-react'
import { memo, useMemo } from 'react'
import { toast } from 'sonner'
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from '@/components/ai-elements/message'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { buildRenderItems, messageText, safeJson } from '@/components/chat/chat-utils'
import { JsonBlock } from '@/components/chat/json-block'
import { MessagePartView } from '@/components/chat/message-parts'
import { PartErrorBoundary } from '@/components/chat/part-error-boundary'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

export interface ChatMessageProps {
  message: UIMessage
  isLastMessage: boolean
  /** 最後のメッセージに対してだけ渡す（過去メッセージを status の変化で再描画しないため） */
  chatStatus: ChatStatus | undefined
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('コピーしました')
  } catch {
    toast.error('コピーできませんでした')
  }
}

function MessageMetadataView({ metadata }: { metadata: unknown }) {
  return (
    <Collapsible className="group not-prose text-xs">
      <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
        <ChevronDownIcon
          className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90"
          aria-hidden
        />
        メタデータ
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <JsonBlock code={safeJson(metadata)} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** メッセージ 1 件。parts を順に描画し、アシスタントのメッセージは幅いっぱいに使う。 */
export const ChatMessage = memo(function ChatMessage({
  message,
  isLastMessage,
  chatStatus,
}: ChatMessageProps) {
  const isUser = message.role === 'user'
  const items = useMemo(() => buildRenderItems(message.parts), [message.parts])
  const text = messageText(message)
  const hasMetadata = message.metadata !== undefined && message.metadata !== null

  return (
    <Message from={message.role} data-role={message.role}>
      <MessageContent className={cn(!isUser && 'w-full')}>
        {message.role === 'system' ? (
          <Badge variant="outline" className="w-fit font-mono">
            system
          </Badge>
        ) : null}
        {items.length === 0 ? (
          isLastMessage && chatStatus === 'streaming' ? (
            <Shimmer>受信中...</Shimmer>
          ) : (
            <p className="text-muted-foreground text-xs">（表示できる内容がありません）</p>
          )
        ) : (
          items.map((item) => {
            const itemKey = `${message.id}-${item.key}`
            return (
              <PartErrorBoundary
                key={itemKey}
                resetKey={item}
                fallback={(error) => (
                  <div
                    role="alert"
                    className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-xs"
                  >
                    <p className="font-medium">パートの描画に失敗しました</p>
                    <p className="break-words font-mono">
                      {error instanceof Error ? error.message : String(error)}
                    </p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
                      {safeJson('part' in item ? item.part : item)}
                    </pre>
                  </div>
                )}
              >
                <MessagePartView
                  item={item}
                  itemKey={itemKey}
                  role={message.role}
                  isLastMessage={isLastMessage}
                  chatStatus={chatStatus}
                />
              </PartErrorBoundary>
            )
          })
        )}
        {hasMetadata ? <MessageMetadataView metadata={message.metadata} /> : null}
      </MessageContent>
      <MessageActions className={cn(isUser && 'justify-end')}>
        <MessageAction
          tooltip="コピー"
          label="メッセージのテキストをコピー"
          disabled={text === ''}
          onClick={() => void copyToClipboard(text)}
        >
          <CopyIcon className="size-3.5" aria-hidden />
        </MessageAction>
      </MessageActions>
    </Message>
  )
})
