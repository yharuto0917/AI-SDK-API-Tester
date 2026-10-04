import { ArrowDownToLineIcon, RadioIcon, TriangleAlertIcon } from 'lucide-react'
import { memo, useCallback, useLayoutEffect, useMemo, useState } from 'react'
import type { UIEvent } from 'react'
import { CodeView } from '@/components/inspector/code-view'
import { CopyButton } from '@/components/inspector/copy-button'
import { EmptyState } from '@/components/inspector/empty-state'
import { isInFlight } from '@/components/inspector/entry-utils'
import { EventBadge, EventNoteBadge } from '@/components/inspector/event-badge'
import { maskRequest, maskStreamEvent } from '@/components/inspector/secret-mask'
import type { SecretSet } from '@/components/inspector/secret-mask'
import {
  computeVirtualWindow,
  eventDetail,
  eventDetailHeight,
  eventNoteLines,
  eventNotes,
  eventPreview,
  eventsToJson,
  filterEvents,
  findEventPosition,
  KIND_FILTER_LABELS,
  KIND_FILTER_ORDER,
  STREAM_ROW_HEIGHT,
  type EventDetail,
  type KindFilter,
  type VirtualExtra,
} from '@/components/inspector/stream-utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { useInspectorScroller } from '@/hooks/use-inspector-scroller'
import type { NetworkLogEntry, StreamEvent } from '@/types'

/** 「最新を追う」中に、末尾からこれ以上離れたらユーザーが上へ戻ったとみなして追従をやめる距離（px）。 */
const FOLLOW_RELEASE_DISTANCE = 48

/** #, +ms, バッジ, プレビューの列。ヘッダー行と各行で共有する。 */
const ROW_GRID = 'grid grid-cols-[2.5rem_3.75rem_auto_minmax(0,1fr)] items-center gap-2 px-2'

function isKindFilter(value: string): value is KindFilter {
  return value === 'all' || (KIND_FILTER_ORDER as readonly string[]).includes(value)
}

interface ExpandedInfo {
  /** 表示中の一覧での位置 */
  position: number
  detail: EventDetail
  height: number
}

interface EventRowProps {
  event: StreamEvent
  /** 渡すと、一覧のプレビューと展開した中身から、これに一致する秘匿情報を伏せる */
  secrets: SecretSet | undefined
  position: number
  total: number
  expanded: ExpandedInfo | undefined
  onToggle: (index: number) => void
}

const EventRow = memo(function EventRow({
  event: rawEvent,
  secrets,
  position,
  total,
  expanded,
  onToggle,
}: EventRowProps) {
  const event = useMemo(
    () => (secrets === undefined ? rawEvent : maskStreamEvent(rawEvent, secrets)),
    [rawEvent, secrets],
  )
  const notes = useMemo(() => eventNotes(event), [event])
  return (
    <div
      role="listitem"
      aria-setsize={total}
      aria-posinset={position + 1}
      data-event-index={event.index}
      style={{ height: STREAM_ROW_HEIGHT + (expanded?.height ?? 0) }}
      className="overflow-hidden"
    >
      <button
        type="button"
        aria-expanded={expanded !== undefined}
        onClick={() => onToggle(event.index)}
        style={{ height: STREAM_ROW_HEIGHT }}
        className={`${ROW_GRID} w-full border-b text-left text-xs outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset aria-expanded:bg-muted/40`}
      >
        <span className="text-right font-mono text-muted-foreground tabular-nums">
          {event.index}
        </span>
        <span className="text-right font-mono text-muted-foreground tabular-nums">
          +{Math.round(event.atMs)}
        </span>
        <EventBadge event={event} />
        {/* 行の高さは固定。注記バッジはプレビューの右に置き、幅が足りないときはプレビューのほうを削る */}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
            {eventPreview(event)}
          </span>
          {notes.length > 0 ? (
            <span className="flex shrink-0 items-center gap-1">
              {notes.map((note) => (
                <EventNoteBadge key={note.id} note={note} />
              ))}
            </span>
          ) : null}
        </span>
      </button>
      {expanded !== undefined ? (
        <div
          style={{ height: expanded.height }}
          className="overflow-auto border-b bg-muted/30 p-2"
          data-testid="event-detail"
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>種別: {event.kind}</span>
            {event.eventName !== undefined ? <span>event: {event.eventName}</span> : null}
            {event.parseError !== undefined ? (
              <span className="text-destructive">
                JSON として解釈できません: {event.parseError}
              </span>
            ) : null}
            {expanded.detail.clipped ? <span>先頭のみ表示</span> : null}
            <CopyButton text={expanded.detail.code} label="イベント" className="ml-auto" />
          </div>
          {notes.length > 0 ? (
            <ul className="mb-1.5 space-y-0.5 text-[11px]" aria-label="イベントの注記">
              {notes.map((note) => (
                <li
                  key={note.id}
                  data-note={note.id}
                  className={
                    note.tone === 'warn'
                      ? 'text-amber-800 dark:text-amber-200'
                      : 'text-muted-foreground'
                  }
                >
                  {note.description}
                </li>
              ))}
            </ul>
          ) : null}
          <CodeView
            code={expanded.detail.code}
            language={expanded.detail.language}
            copyLabel="イベント"
            compact
            className="max-h-none"
          />
        </div>
      ) : null}
    </div>
  )
})

interface EventListProps {
  /** フィルタ済みの一覧 */
  events: readonly StreamEvent[]
  secrets: SecretSet | undefined
  expanded: ReadonlySet<number>
  onToggle: (index: number) => void
  follow: boolean
  live: boolean
  onFollowChange: (follow: boolean) => void
}

/** 固定行高 + 展開行の追加高さで、見えている行だけを描画する一覧。 */
function EventList({
  events,
  secrets,
  expanded,
  onToggle,
  follow,
  live,
  onFollowChange,
}: EventListProps) {
  const { ref, scrollTop, viewportHeight, onScroll, scrollToBottom } = useInspectorScroller()

  // 展開中の行ごとに、表示内容と高さを決める（一覧に無い行は無視する）
  const expandedInfo = useMemo(() => {
    const infos = new Map<number, ExpandedInfo>()
    for (const index of expanded) {
      const position = findEventPosition(events, index)
      const event = events[position]
      if (event === undefined) continue
      // 注記（スキーマ不一致の理由など）は伏せた後の文言で行数を見積もる（行の表示と同じ内容にそろえる）
      const shown = secrets === undefined ? event : maskStreamEvent(event, secrets)
      const detail = eventDetail(shown)
      const height = eventDetailHeight(detail.code, eventNoteLines(eventNotes(shown)))
      infos.set(index, { position, detail, height })
    }
    return infos
  }, [events, expanded, secrets])

  const extras = useMemo<VirtualExtra[]>(
    () => [...expandedInfo.values()].map(({ position, height }) => ({ position, height })),
    [expandedInfo],
  )

  const range = computeVirtualWindow({
    total: events.length,
    rowHeight: STREAM_ROW_HEIGHT,
    scrollTop,
    viewportHeight,
    extras,
  })

  // ストリーミング中に「最新を追う」が有効なら、更新のたびに末尾へ寄せる
  useLayoutEffect(() => {
    if (follow && live) scrollToBottom()
  }, [follow, live, events.length, range.totalHeight, scrollToBottom])

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      onScroll(event)
      if (!follow || !live) return
      const element = event.currentTarget
      if (
        element.scrollHeight - element.scrollTop - element.clientHeight >
        FOLLOW_RELEASE_DISTANCE
      ) {
        onFollowChange(false)
      }
    },
    [onScroll, follow, live, onFollowChange],
  )

  const visible = events.slice(range.start, range.end)

  return (
    <div ref={ref} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto">
      <div style={{ height: range.totalHeight, position: 'relative' }}>
        <div
          role="list"
          aria-label="ストリームイベント"
          style={{ transform: `translateY(${range.offsetTop}px)` }}
        >
          {visible.map((event, offset) => (
            <EventRow
              key={event.index}
              event={event}
              secrets={secrets}
              position={range.start + offset}
              total={events.length}
              expanded={expandedInfo.get(event.index)}
              onToggle={onToggle}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

interface StreamTabProps {
  entry: NetworkLogEntry
  /** true のとき秘匿情報をマスクせずに表示・コピーする */
  revealSecrets: boolean
  /** ストリームではないときの導線（レスポンスタブを開く） */
  onOpenResponse: () => void
}

/** ストリームタブ。イベントの一覧・絞り込み・展開。呼び出し側で key={entry.id} を付け、通信ごとに状態を作り直す。 */
export function StreamTab({ entry, revealSecrets, onOpenResponse }: StreamTabProps) {
  const { events, targetUrl, requestHeaders, requestBody } = entry
  const live = isInFlight(entry.state)

  // 伏せる値の洗い出し（リクエスト本文の走査）は通信ごとに 1 回。イベントは見えている行・コピーする分だけ伏せる
  const secrets = useMemo(
    () =>
      revealSecrets ? undefined : maskRequest({ targetUrl, requestHeaders, requestBody }).secrets,
    [revealSecrets, targetUrl, requestHeaders, requestBody],
  )

  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [follow, setFollow] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())

  const filtered = useMemo(() => filterEvents(events, { query, kind }), [events, query, kind])

  const toggle = useCallback((index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
    // 行を開いたのに末尾へ飛ばされないよう、追従は止める
    setFollow(false)
  }, [])

  if (events.length === 0) {
    if (live) {
      return (
        <EmptyState
          icon={RadioIcon}
          title="イベントを待っています…"
          description="ストリームのデータを受信するとここに並びます"
        />
      )
    }
    return (
      <EmptyState
        icon={RadioIcon}
        title="このレスポンスはストリームではありません"
        description={
          entry.status === undefined
            ? 'レスポンスを受信できなかったため、イベントはありません'
            : '本文は「レスポンス」タブで確認できます'
        }
      >
        <Button type="button" variant="outline" size="sm" onClick={onOpenResponse}>
          レスポンスタブを開く
        </Button>
      </EmptyState>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 border-b p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="タイプで絞り込み"
            placeholder="タイプで絞り込み（例: text-delta）"
            className="h-7 min-w-32 flex-1 text-xs md:text-xs"
          />
          <Select
            value={kind}
            onValueChange={(value) => {
              if (isKindFilter(value)) setKind(value)
            }}
          >
            <SelectTrigger size="sm" aria-label="種別で絞り込み" className="w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">すべての種別</SelectItem>
              {KIND_FILTER_ORDER.map((value) => (
                <SelectItem key={value} value={value}>
                  {KIND_FILTER_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="mr-auto text-muted-foreground tabular-nums">
            表示 {filtered.length} / 全 {events.length} 件
          </span>
          <Toggle
            pressed={follow}
            onPressedChange={setFollow}
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
          >
            <ArrowDownToLineIcon aria-hidden className="size-3" />
            最新を追う
          </Toggle>
          <CopyButton
            text={() =>
              eventsToJson(
                secrets === undefined ? events : events.map((e) => maskStreamEvent(e, secrets)),
              )
            }
            label="全イベントのJSON"
            variant="outline"
          >
            全イベントをJSONでコピー
          </CopyButton>
        </div>
        {entry.eventsTruncated ? (
          <p
            role="note"
            className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200"
          >
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              イベント数が保存上限を超えたため、先頭の {events.length.toLocaleString('ja-JP')}{' '}
              件だけを記録しています（以降は破棄）。
            </span>
          </p>
        ) : null}
      </div>

      <div
        aria-hidden
        className={`${ROW_GRID} shrink-0 border-b bg-muted/40 py-1 text-[11px] text-muted-foreground`}
      >
        <span className="text-right">#</span>
        <span className="text-right">+ms</span>
        <span>タイプ</span>
        <span>プレビュー</span>
      </div>

      {filtered.length === 0 ? (
        <p className="p-4 text-center text-xs text-muted-foreground">
          条件に一致するイベントがありません
        </p>
      ) : (
        <EventList
          events={filtered}
          secrets={secrets}
          expanded={expanded}
          onToggle={toggle}
          follow={follow}
          live={live}
          onFollowChange={setFollow}
        />
      )}
    </div>
  )
}
