import {
  CircleCheckIcon,
  CircleXIcon,
  InfoIcon,
  type LucideIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useMemo } from 'react'
import { LEVEL_LABELS, sortDiagnostics } from '@/components/inspector/diagnostics-utils'
import { isInFlight } from '@/components/inspector/entry-utils'
import { maskDiagnostic, maskEntryError, maskRequest } from '@/components/inspector/secret-mask'
import { LEVEL_ALERT_CLASSES } from '@/components/inspector/tone-classes'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import type { Diagnostic, DiagnosticLevel, NetworkLogEntry } from '@/types'

const LEVEL_ICONS: Record<DiagnosticLevel, LucideIcon> = {
  error: CircleXIcon,
  warn: TriangleAlertIcon,
  info: InfoIcon,
  ok: CircleCheckIcon,
}

function DiagnosticAlert({ diagnostic }: { diagnostic: Diagnostic }) {
  const { level, title, detail } = diagnostic
  const Icon = LEVEL_ICONS[level]
  return (
    <Alert
      // Alert 既定の role="alert" は件数が多いと読み上げが騒がしいので、ただのグループにする
      role="group"
      aria-label={`${LEVEL_LABELS[level]}: ${title}`}
      data-level={level}
      variant={level === 'error' ? 'destructive' : 'default'}
      className={LEVEL_ALERT_CLASSES[level]}
    >
      <Icon aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      {detail !== undefined && detail !== '' ? (
        // detail は改行を含むので、改行をそのまま見せる
        <AlertDescription className="text-start text-current/80 break-words whitespace-pre-line text-pretty">
          {detail}
        </AlertDescription>
      ) : null}
    </Alert>
  )
}

interface DiagnosticsTabProps {
  entry: NetworkLogEntry
  /** true のとき URL・本文由来の秘匿値をマスクせずに表示する */
  revealSecrets: boolean
}

function ErrorAlert({ error }: { error: NonNullable<NetworkLogEntry['error']> }) {
  return (
    <Alert
      role="group"
      aria-label={`通信エラー: ${error.name}`}
      variant="destructive"
      className={LEVEL_ALERT_CLASSES.error}
    >
      <CircleXIcon aria-hidden />
      <AlertTitle className="font-mono">{error.name}</AlertTitle>
      <AlertDescription className="text-start break-words whitespace-pre-line text-pretty">
        <div>{error.message}</div>
        {error.hint !== undefined && error.hint !== '' ? (
          <div className="mt-1.5 text-foreground/80">
            <span className="font-medium">ヒント: </span>
            {error.hint}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

/**
 * 診断タブ。重大なものから順に並べ、通信自体のエラーがあれば最上部に出す。
 * 診断やエラーの文言は転送先 URL を引用することがあるので、マスクする設定では URL・本文から分かった秘匿値を伏せる。
 */
export function DiagnosticsTab({ entry, revealSecrets }: DiagnosticsTabProps) {
  const { targetUrl, requestHeaders, requestBody } = entry
  const secrets = useMemo(
    () =>
      revealSecrets ? undefined : maskRequest({ targetUrl, requestHeaders, requestBody }).secrets,
    [revealSecrets, targetUrl, requestHeaders, requestBody],
  )
  const sorted = useMemo(() => {
    const items = sortDiagnostics(entry.diagnostics)
    return secrets === undefined ? items : items.map((item) => maskDiagnostic(item, secrets))
  }, [entry.diagnostics, secrets])
  const error = useMemo(
    () =>
      entry.error === undefined || secrets === undefined
        ? entry.error
        : maskEntryError(entry.error, secrets),
    [entry.error, secrets],
  )
  const running = isInFlight(entry.state)

  return (
    <div className="space-y-2 p-3">
      {error !== undefined ? <ErrorAlert error={error} /> : null}
      {running ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner aria-hidden className="size-3.5" />
          <span>実行中…</span>
          {sorted.length > 0 ? <span>（完了すると診断が更新されます）</span> : null}
        </p>
      ) : null}
      {sorted.map((diagnostic, index) => (
        <DiagnosticAlert key={`${diagnostic.id}:${index}`} diagnostic={diagnostic} />
      ))}
      {!running && sorted.length === 0 && error === undefined ? (
        <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
          診断項目はありません
        </p>
      ) : null}
    </div>
  )
}
