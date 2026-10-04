import { CircleAlert, Globe, Info, TriangleAlert } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Terminal,
  TerminalActions,
  TerminalClearButton,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from '@/components/ai-elements/terminal'
import { RawResponseHeaders } from '@/components/raw/raw-response-headers'
import { RawStatusBadge } from '@/components/raw/raw-status-badge'
import {
  MAX_BODY_CHARS,
  isLikelyBinaryContentType,
  prettyPrintJson,
} from '@/components/raw/raw-utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import type { RawPhase, RawRequestState } from '@/hooks/use-raw-request'
import { formatBytes, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'

export interface RawResponsePanelProps {
  state: RawRequestState
  onClear: () => void
  className?: string
}

const WARN_ALERT_CLASSES =
  'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200 *:data-[slot=alert-description]:text-amber-900/90 dark:*:data-[slot=alert-description]:text-amber-200/90'
const INFO_ALERT_CLASSES =
  'border-sky-500/40 bg-sky-500/10 text-sky-900 dark:bg-sky-500/10 dark:text-sky-200 *:data-[slot=alert-description]:text-sky-900/90 dark:*:data-[slot=alert-description]:text-sky-200/90'

const PHASE_LABELS: Partial<Record<RawPhase, string>> = {
  sending: '送信中…',
  streaming: '受信中…',
  aborted: '中止しました',
  error: '失敗',
}

function PhaseBadge({ phase }: { phase: RawPhase }) {
  const label = PHASE_LABELS[phase]
  if (label === undefined) return null
  const busy = phase === 'sending' || phase === 'streaming'
  return (
    <Badge
      role="status"
      variant={phase === 'error' ? 'destructive' : 'outline'}
      className={cn(
        phase === 'aborted' && 'border-amber-500/50 text-amber-700 dark:text-amber-300',
      )}
    >
      {busy && (
        <Spinner role="presentation" aria-label={undefined} aria-hidden className="size-3" />
      )}
      {label}
    </Badge>
  )
}

function ResponseMeta({ state }: { state: RawRequestState }) {
  const items: string[] = []
  if (state.ttfbMs !== undefined) items.push(`TTFB ${formatDuration(state.ttfbMs)}`)
  if (state.totalMs !== undefined) items.push(`合計 ${formatDuration(state.totalMs)}`)
  // ヘッダーを受け取った後（接続できた後）だけ、受信量を出す
  if (state.status !== undefined) items.push(formatBytes(state.bytes))
  if (items.length === 0) return null
  return <span className="text-xs text-muted-foreground tabular-nums">{items.join(' ・ ')}</span>
}

/** Raw ビューのレスポンス表示（ステータス・所要時間・ヘッダー・ボディ）。 */
export function RawResponsePanel({ state, onClear, className }: RawResponsePanelProps) {
  const switchId = useId()
  const [jsonMode, setJsonMode] = useState(false)

  const streaming = state.phase === 'streaming'
  // 整形はボディが出そろってから、全体が JSON のときだけ行う（途中の断片は JSON にならない）
  const formatted = useMemo(
    () =>
      jsonMode && !streaming && !state.bodyTruncated && state.body !== ''
        ? prettyPrintJson(state.body)
        : null,
    [jsonMode, streaming, state.bodyTruncated, state.body],
  )
  const displayText = formatted ?? state.body
  const jsonNote =
    jsonMode && !streaming && state.body !== '' && formatted === null
      ? state.bodyTruncated
        ? '表示を切り詰めたため整形できません'
        : 'JSON として解析できないため、そのまま表示しています'
      : null

  const footer = (
    <p className="text-xs text-muted-foreground">
      詳細はインスペクタ（ログ・SSE イベント・cURL）で確認できます。
    </p>
  )

  if (state.phase === 'idle') {
    return (
      <section
        aria-label="レスポンス"
        className={cn('flex min-h-64 flex-1 flex-col gap-2', className)}
      >
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Globe />
            </EmptyMedia>
            <EmptyTitle>レスポンスはまだありません</EmptyTitle>
            <EmptyDescription>
              メソッド・エンドポイント・ボディを指定して「送信」を押すと、ステータス・ヘッダー・ボディがここに表示されます。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        {footer}
      </section>
    )
  }

  const showBinaryNote = isLikelyBinaryContentType(state.contentType) && state.body !== ''
  const placeholder =
    state.phase === 'sending'
      ? '応答を待っています…'
      : state.body === '' && state.phase !== 'streaming'
        ? // ヘッダーも受け取れていない（接続前の失敗・中止）ときは「空のボディ」とは別物
          state.status === undefined
          ? '（レスポンスを受信していません）'
          : '（レスポンスボディは空です）'
        : null

  return (
    <section
      aria-label="レスポンス"
      className={cn('flex min-h-64 flex-1 flex-col gap-2', className)}
    >
      <p
        className="truncate font-mono text-xs text-muted-foreground"
        title={`${state.method ?? ''} ${state.url ?? ''}`}
      >
        <span className="font-semibold text-foreground">{state.method}</span> {state.url}
      </p>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {state.status !== undefined && (
          <RawStatusBadge status={state.status} statusText={state.statusText} />
        )}
        <PhaseBadge phase={state.phase} />
        <ResponseMeta state={state} />
        <div className="ml-auto flex items-center gap-2">
          {jsonNote !== null && <span className="text-xs text-muted-foreground">{jsonNote}</span>}
          <Switch id={switchId} size="sm" checked={jsonMode} onCheckedChange={setJsonMode} />
          <Label htmlFor={switchId} className="text-xs">
            JSON を整形
          </Label>
        </div>
      </div>

      {state.error !== undefined && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>
            {state.error.name === 'RequestShapeError'
              ? 'リクエストを組み立てられませんでした'
              : 'リクエストに失敗しました'}
          </AlertTitle>
          <AlertDescription className="space-y-1">
            <p className="break-words whitespace-pre-wrap">{state.error.message}</p>
            {state.error.hint !== undefined && <p>{state.error.hint}</p>}
            <p>詳細はインスペクタの診断を確認してください。</p>
          </AlertDescription>
        </Alert>
      )}

      {state.bodyTruncated && (
        <Alert className={WARN_ALERT_CLASSES}>
          <TriangleAlert />
          <AlertTitle>表示を切り詰めました</AlertTitle>
          <AlertDescription>
            表示できる上限（{MAX_BODY_CHARS.toLocaleString('ja-JP')}
            文字）を超えたため、以降の表示を省略しています。受信は最後まで続けており、バイト数と時間は実測値です。
          </AlertDescription>
        </Alert>
      )}

      {showBinaryNote && (
        <Alert className={INFO_ALERT_CLASSES}>
          <Info />
          <AlertTitle>バイナリの可能性があります</AlertTitle>
          <AlertDescription>
            Content-Type が {state.contentType} のため、UTF-8
            としてデコードした結果を表示しています（文字化けすることがあります）。
          </AlertDescription>
        </Alert>
      )}

      {state.headers.length > 0 && <RawResponseHeaders headers={state.headers} />}

      <Terminal
        output={displayText}
        isStreaming={streaming}
        // ストリーミング中だけ末尾に追従する。止まったあとは自由にスクロールできる
        autoScroll={streaming}
        onClear={onClear}
        className="min-h-40 flex-1"
      >
        <TerminalHeader>
          <TerminalTitle>レスポンスボディ</TerminalTitle>
          <div className="flex items-center gap-1">
            <TerminalStatus>受信中…</TerminalStatus>
            <TerminalActions>
              <TerminalCopyButton
                aria-label="レスポンスボディをコピー"
                title="コピー"
                onCopy={() => toast.success('レスポンスボディをコピーしました')}
                onError={() => toast.error('コピーに失敗しました')}
              />
              <TerminalClearButton aria-label="レスポンスをクリア" title="クリア" />
            </TerminalActions>
          </div>
        </TerminalHeader>
        <TerminalContent className="max-h-none min-h-0 flex-1">
          {/* 既定の表示は ANSI エスケープを解釈してしまうため、受信した文字列をそのまま出す */}
          <pre className="break-words whitespace-pre-wrap">
            {placeholder !== null ? (
              <span className="text-zinc-400">{placeholder}</span>
            ) : (
              displayText
            )}
            {streaming && (
              <span
                aria-hidden
                className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-zinc-100 align-middle"
              />
            )}
          </pre>
        </TerminalContent>
      </Terminal>

      {footer}
    </section>
  )
}
