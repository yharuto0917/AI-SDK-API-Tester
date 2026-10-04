import { InfoIcon, TriangleAlertIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

/**
 * - manual: 設定で自動再送が無効
 * - stalled: 自動再送が中断・失敗した（または無効の間に揃った）まま、サーバーへ届いていない
 * - blocked: 古いメッセージに承認応答が残っていて、SDK は正しい宛先へ再送できない
 */
export type ChatResubmitVariant = 'manual' | 'stalled' | 'blocked'

export interface ChatResubmitBarProps {
  variant: ChatResubmitVariant
  onResubmit: () => void
  onRegenerate: () => void
}

const BLOCKED_DESCRIPTION =
  '以前のメッセージに応答済みの承認（approval-responded）が残っています。このまま再送すると SDK は継続リクエストをそのメッセージ宛て（messageId）に送り、返答が別のメッセージへ追記されます。サーバーが承認に応答しなかった可能性があります。'

/** ツール出力 / 承認応答が揃ったのにサーバーへ届いていない会話を、手動で先へ進めるための帯。 */
export function ChatResubmitBar({ variant, onResubmit, onRegenerate }: ChatResubmitBarProps) {
  if (variant === 'blocked') {
    return (
      <Alert role="status" className="shrink-0 rounded-none border-x-0 border-b-0">
        <TriangleAlertIcon aria-hidden />
        <AlertTitle>この状態では結果を送信できません</AlertTitle>
        <AlertDescription className="col-start-2 space-y-2">
          <p>{BLOCKED_DESCRIPTION}</p>
          <Button type="button" size="sm" variant="outline" onClick={onRegenerate}>
            再生成
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert role="status" className="shrink-0 rounded-none border-x-0 border-b-0">
      <InfoIcon aria-hidden />
      <AlertTitle>
        {variant === 'manual'
          ? 'ツールの出力（または承認）が揃っています'
          : 'ツールの出力（または承認）がサーバーへ届いていません'}
      </AlertTitle>
      <AlertDescription className="col-start-2 space-y-2">
        <p>
          {variant === 'manual'
            ? '設定で自動再送が無効になっているため、手動でサーバーへ送信してください。'
            : '自動再送が中断・失敗した（または自動再送が無効の間に揃った）ため、まだ届いていません。もう一度送信してください。'}
        </p>
        <Button type="button" size="sm" onClick={onResubmit}>
          結果を送信
        </Button>
      </AlertDescription>
    </Alert>
  )
}
