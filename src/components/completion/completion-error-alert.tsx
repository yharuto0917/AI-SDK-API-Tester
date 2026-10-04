import { CircleAlert } from 'lucide-react'
import { describeCompletionError } from '@/components/completion/completion-format'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { CompletionProtocol } from '@/types'

export interface CompletionErrorAlertProps {
  error: Error
  /** 現在のプロトコル設定（解釈エラーのヒントに使う） */
  protocol: CompletionProtocol
}

export function CompletionErrorAlert({ error, protocol }: CompletionErrorAlertProps) {
  const info = describeCompletionError(error, protocol)
  return (
    <Alert variant="destructive" className="shrink-0">
      <CircleAlert />
      <AlertTitle>{info.title}</AlertTitle>
      <AlertDescription className="space-y-1">
        {/* サーバーのレスポンス本文がそのまま入ることがあるので、長くても枠内でスクロールさせる */}
        <p className="max-h-32 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
          {info.message}
        </p>
        {info.hint !== undefined && <p>{info.hint}</p>}
        <p>原因の詳細はインスペクタの診断を確認してください。</p>
      </AlertDescription>
    </Alert>
  )
}
