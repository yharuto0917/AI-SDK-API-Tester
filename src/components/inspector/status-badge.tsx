import { BanIcon, CircleCheckIcon, CircleXIcon } from 'lucide-react'
import { LOG_STATE_LABELS, statusTone } from '@/components/inspector/entry-utils'
import { STATUS_BADGE_CLASSES } from '@/components/inspector/tone-classes'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { LogState } from '@/types'

interface HttpStatusBadgeProps {
  status: number | undefined
  /** 渡すと「200 OK」の形で出す */
  statusText?: string
  className?: string
}

/** HTTP ステータスコードのバッジ。2xx 緑 / 3xx 青 / 4xx・5xx 赤 / 未受信は —。 */
export function HttpStatusBadge({ status, statusText, className }: HttpStatusBadgeProps) {
  const label =
    status === undefined
      ? '—'
      : statusText !== undefined && statusText !== ''
        ? `${status} ${statusText}`
        : String(status)
  return (
    <Badge
      variant="outline"
      className={cn('font-mono tabular-nums', STATUS_BADGE_CLASSES[statusTone(status)], className)}
      aria-label={status === undefined ? 'ステータス 未受信' : `ステータス ${label}`}
    >
      {label}
    </Badge>
  )
}

/**
 * 通信の状態を表すアイコン（pending / streaming はスピナー）。
 * 隣に状態名の文字がある場所では decorative を付け、読み上げの重複を避ける。
 */
export function LogStateIcon({
  state,
  className,
  decorative = false,
}: {
  state: LogState
  className?: string
  decorative?: boolean
}) {
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': LOG_STATE_LABELS[state] } as const)
  const size = cn('size-3.5 shrink-0', className)
  switch (state) {
    case 'pending':
    case 'streaming':
      // Spinner の既定は role="status" + 英語ラベル。一覧に並ぶので画像として日本語ラベルを付ける
      return <Spinner {...a11y} className={cn(size, 'text-muted-foreground')} />
    case 'done':
      return (
        <CircleCheckIcon {...a11y} className={cn(size, 'text-emerald-600 dark:text-emerald-400')} />
      )
    case 'error':
      return <CircleXIcon {...a11y} className={cn(size, 'text-destructive')} />
    case 'aborted':
      return <BanIcon {...a11y} className={cn(size, 'text-muted-foreground')} />
  }
}

/** アイコン + 状態名。 */
export function LogStateLabel({ state }: { state: LogState }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <LogStateIcon state={state} decorative />
      <span>{LOG_STATE_LABELS[state]}</span>
    </span>
  )
}
