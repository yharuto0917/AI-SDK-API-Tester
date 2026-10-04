import type { ChatStatus } from 'ai'
import { BracesIcon, MessageSquarePlusIcon, RefreshCwIcon } from 'lucide-react'
import { useId } from 'react'
import { CHAT_STATUS_META, TONE_BADGE_CLASS } from '@/components/chat/chat-utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export interface ChatToolbarProps {
  status: ChatStatus
  messageCount: number
  canRegenerate: boolean
  canClear: boolean
  markdown: boolean
  onMarkdownChange: (value: boolean) => void
  onNewConversation: () => void
  onRegenerate: () => void
  onShowJson: () => void
}

export function ChatStatusBadge({ status }: { status: ChatStatus }) {
  const meta = CHAT_STATUS_META[status]
  return (
    <Badge
      variant="secondary"
      className={cn('gap-1.5', TONE_BADGE_CLASS[meta.tone])}
      title={`status: ${status}`}
      data-status={status}
    >
      {status === 'streaming' || status === 'submitted' ? (
        <Spinner className="size-3" aria-label="処理中" />
      ) : null}
      {meta.label}
    </Badge>
  )
}

export function ChatToolbar({
  status,
  messageCount,
  canRegenerate,
  canClear,
  markdown,
  onMarkdownChange,
  onNewConversation,
  onRegenerate,
  onShowJson,
}: ChatToolbarProps) {
  const switchId = useId()
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-background px-3 py-1.5">
      <ChatStatusBadge status={status} />
      <span className="text-muted-foreground text-xs tabular-nums">{messageCount} 件</span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onShowJson}>
          <BracesIcon aria-hidden />
          メッセージ JSON
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRegenerate}
          disabled={!canRegenerate}
        >
          <RefreshCwIcon aria-hidden />
          再生成
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onNewConversation}
          disabled={!canClear}
        >
          <MessageSquarePlusIcon aria-hidden />
          新しい会話
        </Button>
        <div className="flex items-center gap-2 pl-1.5">
          <Switch id={switchId} size="sm" checked={markdown} onCheckedChange={onMarkdownChange} />
          <Label htmlFor={switchId} className="cursor-pointer text-xs">
            Markdown 表示
          </Label>
        </div>
      </div>
    </div>
  )
}
