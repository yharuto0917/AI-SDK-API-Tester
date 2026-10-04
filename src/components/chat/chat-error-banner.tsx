import { CircleAlertIcon } from 'lucide-react'
import { describeChatError } from '@/components/chat/chat-utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export interface ChatErrorBannerProps {
  error: Error
  onRetry: () => void
  onDismiss: () => void
}

/** useChat の error を画面内に出す。トーストは使わず、ここに集約する。 */
export function ChatErrorBanner({ error, onRetry, onDismiss }: ChatErrorBannerProps) {
  const info = describeChatError(error)
  return (
    <Alert variant="destructive" className="shrink-0 rounded-none border-x-0 border-b-0">
      <CircleAlertIcon aria-hidden />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        リクエストに失敗しました
        {info.statusCode !== undefined ? (
          <Badge variant="destructive" className="font-mono">
            HTTP {info.statusCode}
          </Badge>
        ) : null}
        <span className="font-mono font-normal text-xs opacity-80">{info.name}</span>
      </AlertTitle>
      <AlertDescription className="col-start-2 space-y-2">
        <pre
          className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs"
          data-testid="chat-error-message"
        >
          {info.message}
        </pre>
        <p className="text-xs">インスペクタの「診断」タブに原因の手がかりが出ます。</p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            再試行
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
            閉じる
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
