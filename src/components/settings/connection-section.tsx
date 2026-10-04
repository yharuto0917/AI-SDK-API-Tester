import { useId } from 'react'
import type { ReactNode } from 'react'
import { PlugIcon, RefreshCwIcon, ServerIcon, TriangleAlertIcon } from 'lucide-react'
import { toast } from 'sonner'
import {
  Snippet,
  SnippetAddon,
  SnippetCopyButton,
  SnippetInput,
  SnippetText,
} from '@/components/ai-elements/snippet'
import { ProxyStatusDot } from '@/components/proxy-status-badge'
import { Hint, SettingsSection } from '@/components/settings/settings-section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { proxyStatusText, useProxyStatus } from '@/hooks/use-proxy-status'
import { useSettings } from '@/hooks/use-settings'
import { PROXY_NAME, PROXY_TOGGLE_LABEL } from '@/lib/proxy'
import { MOCK_ENDPOINTS, applyMockPreset, validateEndpoint } from '@/lib/settings'
import { MODE_LABELS } from '@/types'

/** 注意（警告）を促す枠。色だけに頼らずアイコンと見出しでも伝える。 */
function WarningNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-amber-900/90 dark:text-amber-200/90">
        {children}
      </AlertDescription>
    </Alert>
  )
}

export function ConnectionSection() {
  const { settings, update } = useSettings()
  const { status, recheck } = useProxyStatus()
  const endpointId = useId()
  const endpointErrorId = useId()
  const proxyId = useId()

  const { mode, useDevProxy } = settings
  const endpoint = settings.endpoints[mode]
  const endpointError = validateEndpoint(endpoint)
  const proxyUnavailable = useDevProxy && status === 'unavailable'
  // 検証に通った上で / 始まりなら相対パス。プロキシは転送先の絶対 URL が必要
  const relativeWithProxy =
    useDevProxy && endpointError === null && !/^https?:\/\//i.test(endpoint.trim())

  function connectToMock(): void {
    update(applyMockPreset)
    toast.success('モックサーバーに接続する設定にしました', {
      description: '全モードのエンドポイントを http://localhost:28787 に向けました',
    })
  }

  return (
    <SettingsSection
      title="接続"
      icon={PlugIcon}
      description={`現在のモード: ${MODE_LABELS[mode]}`}
    >
      <FieldGroup className="gap-4">
        <Field data-invalid={endpointError !== null}>
          <FieldLabel htmlFor={endpointId}>
            エンドポイント
            <span className="font-normal text-muted-foreground">（{MODE_LABELS[mode]}）</span>
          </FieldLabel>
          <Input
            id={endpointId}
            value={endpoint}
            onChange={(e) => {
              const value = e.target.value
              update((prev) => ({ ...prev, endpoints: { ...prev.endpoints, [mode]: value } }))
            }}
            placeholder={MOCK_ENDPOINTS[mode]}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={endpointError !== null}
            aria-describedby={endpointError !== null ? endpointErrorId : undefined}
          />
          {endpointError !== null && <FieldError id={endpointErrorId}>{endpointError}</FieldError>}
          {relativeWithProxy && (
            <WarningNotice title="絶対URLが必要です">
              {PROXY_NAME}利用時は、http:// または https:// で始まる絶対URLを指定してください。
            </WarningNotice>
          )}
        </Field>

        <div className="flex flex-col gap-2">
          <Button type="button" variant="outline" size="sm" onClick={connectToMock}>
            <ServerIcon aria-hidden="true" />
            モックサーバーに接続
          </Button>
          <Hint>全モードのエンドポイントを同梱のモックサーバー（localhost:28787）に向けます。</Hint>
          <Snippet code="pnpm mock">
            <SnippetAddon className="pl-1">
              <SnippetText>$</SnippetText>
            </SnippetAddon>
            <SnippetInput aria-label="モックサーバーの起動コマンド" />
            <SnippetAddon align="inline-end" className="pr-2">
              <SnippetCopyButton aria-label="起動コマンドをコピー" title="コピー" />
            </SnippetAddon>
          </Snippet>
        </div>

        <div className="flex flex-col gap-2">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={proxyId}>{PROXY_TOGGLE_LABEL}</FieldLabel>
              <Hint>
                CORSエラーになるときにONにします。Vite
                の開発サーバーが代理で送信するので、接続先のCORS設定は不要です。
              </Hint>
            </FieldContent>
            <Switch
              id={proxyId}
              checked={useDevProxy}
              onCheckedChange={(checked) => update({ useDevProxy: checked })}
              className="mt-0.5"
            />
          </Field>

          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span role="status" className="flex items-center gap-1.5">
              <ProxyStatusDot status={status} warn={proxyUnavailable} />
              {proxyStatusText(status)}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={recheck}>
              <RefreshCwIcon aria-hidden="true" />
              再確認
            </Button>
          </div>

          {proxyUnavailable && (
            <WarningNotice title={`${PROXY_NAME}を利用できません`}>
              ONのままだとリクエストは失敗します。{PROXY_NAME}は vite dev / vite preview
              で起動しているときだけ使えます。OFFに戻すか、起動方法を確認してください。
            </WarningNotice>
          )}
        </div>
      </FieldGroup>
    </SettingsSection>
  )
}
