import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { proxyStatusText, useProxyStatus } from '@/hooks/use-proxy-status'
import type { ProxyStatus } from '@/hooks/use-proxy-status'
import { useSettings } from '@/hooks/use-settings'
import { PROXY_NAME, PROXY_PATH, PROXY_TOGGLE_LABEL } from '@/lib/proxy'
import { cn } from '@/lib/utils'

/** 状態を色で示す小さな丸。意味は常に隣のテキストでも伝える（色だけに頼らない）。 */
export function ProxyStatusDot({
  status,
  warn = false,
  className,
}: {
  status: ProxyStatus
  /** 利用不可なのに ON にしている、など注意が要る状態 */
  warn?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        status === 'available' && 'bg-emerald-500',
        status === 'checking' && 'animate-pulse bg-muted-foreground/60',
        status === 'unavailable' && (warn ? 'bg-amber-500' : 'bg-muted-foreground/60'),
        className,
      )}
    />
  )
}

function explain(status: ProxyStatus, enabled: boolean): string {
  switch (status) {
    case 'checking':
      return `${PROXY_NAME}（${PROXY_PATH}）の応答を確認しています。`
    case 'available':
      return enabled
        ? `${PROXY_NAME}が応答しています。現在 ON なので、リクエストは${PROXY_NAME}経由で送られます。`
        : `${PROXY_NAME}が応答しています。CORS エラーになるときは、設定で「${PROXY_TOGGLE_LABEL}」を ON にしてください。`
    case 'unavailable':
      return enabled
        ? `${PROXY_NAME}が応答しません。設定が ON のままだとリクエストは失敗します。${PROXY_NAME}は vite dev / vite preview で起動しているときだけ有効です。`
        : `${PROXY_NAME}が応答しません。${PROXY_NAME}は vite dev / vite preview で起動しているときだけ有効です（ビルド済みの静的ファイルを配信しているだけの環境では使えません）。`
  }
}

/** ヘッダー用のプロキシ状態バッジ。クリックで再確認する。 */
export function ProxyStatusBadge() {
  const { status, recheck } = useProxyStatus()
  const { settings } = useSettings()
  const enabled = settings.useDevProxy
  const warn = enabled && status === 'unavailable'
  const label = proxyStatusText(status)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          asChild
          variant="outline"
          className={cn(
            'cursor-pointer gap-1.5 hover:bg-muted',
            status === 'available' &&
              'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300',
            warn &&
              'border-amber-500/30 bg-amber-500/10 text-amber-800 hover:bg-amber-500/15 dark:text-amber-300',
            status !== 'available' && !warn && 'text-muted-foreground',
          )}
        >
          <button type="button" onClick={recheck} data-status={status}>
            <ProxyStatusDot status={status} warn={warn} />
            {/* 狭い画面では丸だけにして、名前はスクリーンリーダー向けに残す */}
            <span className="max-sm:sr-only">{label}</span>
          </button>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex-col items-start gap-1 text-left">
        <p className="font-medium">{label}</p>
        <p className="leading-relaxed">{explain(status, enabled)}</p>
        <p className="opacity-70">クリックで再確認</p>
      </TooltipContent>
    </Tooltip>
  )
}
