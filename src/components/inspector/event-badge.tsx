import { eventFamily, eventLabel, type EventNote } from '@/components/inspector/stream-utils'
import { FAMILY_BADGE_CLASSES, NOTE_BADGE_CLASSES } from '@/components/inspector/tone-classes'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { StreamEvent } from '@/types'

/** ストリームイベントの type / 種別のバッジ。ファミリー（text / tool / data / error …）で色分けする。 */
export function EventBadge({ event, className }: { event: StreamEvent; className?: string }) {
  const family = eventFamily(event)
  const label = eventLabel(event)
  return (
    <Badge
      variant="outline"
      data-family={family}
      title={label}
      className={cn('max-w-44 font-mono text-[11px]', FAMILY_BADGE_CLASSES[family], className)}
    >
      <span className="truncate">{label}</span>
    </Badge>
  )
}

/**
 * イベントの注記バッジ（未完了・切り詰め・スキーマ不一致など）。行の高さ（固定）に収まる小ささにし、
 * 説明は title で出す。
 */
export function EventNoteBadge({ note, className }: { note: EventNote; className?: string }) {
  return (
    <Badge
      variant="outline"
      data-note={note.id}
      data-tone={note.tone}
      title={note.description}
      className={cn('h-4 px-1.5 text-[10px] font-normal', NOTE_BADGE_CLASSES[note.tone], className)}
    >
      {note.label}
    </Badge>
  )
}
