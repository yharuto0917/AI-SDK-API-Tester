import { InboxIcon } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { EmptyState } from '@/components/inspector/empty-state'
import { durationLabel, splitUrl } from '@/components/inspector/entry-utils'
import { maskUrlForDisplay } from '@/components/inspector/secret-mask'
import { HttpStatusBadge, LogStateIcon } from '@/components/inspector/status-badge'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatClock } from '@/lib/format'
import { PROXY_NAME } from '@/lib/proxy'
import { MODE_LABELS, type NetworkLogEntry } from '@/types'

interface RequestRowProps {
  entry: NetworkLogEntry
  /** true のとき URL のクエリなどの秘匿情報をマスクして表示する */
  maskSecrets: boolean
  selected: boolean
  /** roving tabindex: 一覧の中で Tab キーで入れる行は 1 つだけ */
  tabbable: boolean
  onSelect: (id: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, id: string) => void
  register: (id: string, element: HTMLDivElement | null) => void
}

const RequestRow = memo(function RequestRow({
  entry,
  maskSecrets,
  selected,
  tabbable,
  onSelect,
  onKeyDown,
  register,
}: RequestRowProps) {
  const { targetUrl, requestHeaders } = entry
  const { origin, path, fullUrl } = useMemo(() => {
    const parts = splitUrl(targetUrl)
    if (!maskSecrets) return { ...parts, fullUrl: targetUrl }
    // origin には user:pass が含まれない。path と全体だけを伏せる（URL を作り直すと伏せ字が %XX になるため、分けた後に伏せる）
    return {
      origin: parts.origin,
      path: maskUrlForDisplay(parts.path, requestHeaders),
      fullUrl: maskUrlForDisplay(targetUrl, requestHeaders),
    }
  }, [targetUrl, requestHeaders, maskSecrets])
  return (
    <div
      ref={(element) => {
        register(entry.id, element)
        return () => register(entry.id, null)
      }}
      role="option"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      data-entry-id={entry.id}
      onClick={() => onSelect(entry.id)}
      onKeyDown={(event) => onKeyDown(event, entry.id)}
      className="flex cursor-pointer flex-col gap-0.5 border-b px-2.5 py-1.5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset aria-selected:bg-muted aria-selected:shadow-[inset_2px_0_0_0_var(--primary)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <LogStateIcon state={entry.state} />
        <span className="w-11 shrink-0 font-mono text-xs font-semibold">{entry.method}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={fullUrl}>
          <span className="text-muted-foreground">{origin}</span>
          <span className="font-medium text-foreground">{path}</span>
        </span>
        <HttpStatusBadge status={entry.status} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-[1.375rem] text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">{formatClock(entry.startedAt)}</span>
        <span className="font-mono tabular-nums" title="所要時間">
          {durationLabel(entry)}
        </span>
        <Badge
          variant="outline"
          title={MODE_LABELS[entry.mode]}
          className="h-4 px-1.5 font-mono text-[10px] font-normal"
        >
          {entry.mode}
        </Badge>
        {entry.viaProxy ? (
          <Badge
            variant="outline"
            title={`${PROXY_NAME}経由で送信`}
            className="h-4 border-sky-500/40 bg-sky-500/10 px-1.5 font-mono text-[10px] font-normal text-sky-800 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-200"
          >
            proxy
          </Badge>
        ) : null}
      </div>
    </div>
  )
})

interface RequestListProps {
  /** 新しい順 */
  entries: readonly NetworkLogEntry[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** true のとき URL のクエリなどの秘匿情報をマスクせずに表示する */
  revealSecrets: boolean
}

/** 通信の一覧。上下キーで選択を移動できる（listbox）。 */
export function RequestList({ entries, selectedId, onSelect, revealSecrets }: RequestListProps) {
  const rows = useRef(new Map<string, HTMLDivElement>())
  // キー操作のコールバックを安定させる（毎回変わると、ストリーミング中に全行が再描画される）
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  })

  const hasSelected = selectedId !== null && entries.some((entry) => entry.id === selectedId)
  const tabbableId = hasSelected ? selectedId : entries[0]?.id

  // 新しい通信が自動で選択されたときや、キーで選択を動かしたときに、行が見えるようにする
  useEffect(() => {
    if (selectedId !== null) rows.current.get(selectedId)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const register = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element === null) rows.current.delete(id)
    else rows.current.set(id, element)
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, id: string) => {
      const list = entriesRef.current
      const current = list.findIndex((entry) => entry.id === id)
      if (current === -1) return
      let next: number
      switch (event.key) {
        case 'ArrowDown':
          next = current + 1
          break
        case 'ArrowUp':
          next = current - 1
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = list.length - 1
          break
        case 'Enter':
        case ' ':
          event.preventDefault()
          onSelect(id)
          return
        default:
          return
      }
      event.preventDefault()
      const target = list[Math.min(list.length - 1, Math.max(0, next))]
      if (target === undefined) return
      onSelect(target.id)
      rows.current.get(target.id)?.focus()
    },
    [onSelect],
  )

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={InboxIcon}
        title="まだ通信がありません"
        description="メッセージを送信するとここに表示されます"
      />
    )
  }

  return (
    // Radix の ScrollArea は中身を display:table で包み、行の truncate を効かなくするので block に戻す
    <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
      <div role="listbox" aria-label="通信リスト" className="min-w-0">
        {entries.map((entry) => (
          <RequestRow
            key={entry.id}
            entry={entry}
            maskSecrets={!revealSecrets}
            selected={entry.id === selectedId}
            tabbable={entry.id === tabbableId}
            onSelect={onSelect}
            onKeyDown={handleKeyDown}
            register={register}
          />
        ))}
      </div>
    </ScrollArea>
  )
}
