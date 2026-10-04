import { Badge } from '@/components/ui/badge'
import { statusTone } from '@/components/raw/raw-utils'
import type { StatusTone } from '@/components/raw/raw-utils'
import { cn } from '@/lib/utils'

/** 色はステータスの区分ごとに固定し、ライト/ダークの両方で読めるようにする。 */
const TONE_CLASSES: Record<StatusTone, string> = {
  info: 'bg-sky-500/10 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
  success: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  redirect: 'bg-sky-500/10 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
  'client-error': 'bg-amber-500/10 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  'server-error': '',
  unknown: '',
}

export interface RawStatusBadgeProps {
  status: number
  statusText?: string
  className?: string
}

export function RawStatusBadge({ status, statusText, className }: RawStatusBadgeProps) {
  const tone = statusTone(status)
  const label =
    statusText !== undefined && statusText !== '' ? `${status} ${statusText}` : `${status}`
  return (
    <Badge
      data-tone={tone}
      variant={tone === 'server-error' ? 'destructive' : 'secondary'}
      className={cn('font-mono', TONE_CLASSES[tone], className)}
    >
      {label}
    </Badge>
  )
}
