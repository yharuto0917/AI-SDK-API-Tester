import { Check, Info, Send, Square, TriangleAlert, WandSparkles } from 'lucide-react'
import { useId, useMemo } from 'react'
import type { KeyboardEvent } from 'react'
import { inspectJson, isRawMethod, prettyPrintJson, RAW_METHODS } from '@/components/raw/raw-utils'
import type { JsonState } from '@/components/raw/raw-utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { PROXY_NAME } from '@/lib/proxy'
import { validateEndpoint } from '@/lib/settings'
import type { CredentialsMode, RawMethod } from '@/types'

/** 設定パネルの値のうち、Raw の送信に自動で適用されるもの（表示用）。 */
export interface RawAppliedSettings {
  useDevProxy: boolean
  headerCount: number
  hasBearer: boolean
  credentials: CredentialsMode
}

export interface RawRequestFormProps {
  method: RawMethod
  endpoint: string
  body: string
  busy: boolean
  applied: RawAppliedSettings
  onMethodChange: (method: RawMethod) => void
  onEndpointChange: (endpoint: string) => void
  onBodyChange: (body: string) => void
  onSend: () => void
  onAbort: () => void
}

/** 変換確定の Enter を送信と取り違えない。Safari は確定の keydown が isComposing=false で keyCode=229 になる。 */
function isComposing(event: KeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

function JsonIndicator({ method, state }: { method: RawMethod; state: JsonState }) {
  if (method === 'GET') {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Info className="size-3.5" aria-hidden />
        GET ではボディは送信されません
      </span>
    )
  }
  if (state.kind === 'empty') {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Info className="size-3.5" aria-hidden />
        ボディなし
      </span>
    )
  }
  if (state.kind === 'valid') {
    return (
      <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
        <Check className="size-3.5" aria-hidden />
        JSON として有効
      </span>
    )
  }
  return (
    <span
      className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300"
      title={state.message}
    >
      <TriangleAlert className="size-3.5" aria-hidden />
      JSONではありません（文字列としてそのまま送信）
    </span>
  )
}

/** Raw ビューのリクエスト入力部（メソッド・エンドポイント・ボディ・送信/中止）。 */
export function RawRequestForm({
  method,
  endpoint,
  body,
  busy,
  applied,
  onMethodChange,
  onEndpointChange,
  onBodyChange,
  onSend,
  onAbort,
}: RawRequestFormProps) {
  const endpointErrorId = useId()
  const endpointError = validateEndpoint(endpoint)
  const json = useMemo(() => inspectJson(body), [body])
  const noBody = method === 'GET'

  const handleEndpointKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !isComposing(event)) {
      event.preventDefault()
      if (!busy) onSend()
    }
  }

  const handleBodyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isComposing(event)) {
      event.preventDefault()
      if (!busy) onSend()
    }
  }

  const handleFormat = () => {
    const pretty = prettyPrintJson(body)
    if (pretty !== null) onBodyChange(pretty)
  }

  return (
    <section aria-label="リクエスト" className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Select
          value={method}
          onValueChange={(value) => {
            if (isRawMethod(value)) onMethodChange(value)
          }}
        >
          <SelectTrigger aria-label="HTTP メソッド" className="w-28 shrink-0 font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RAW_METHODS.map((m) => (
              <SelectItem key={m} value={m} className="font-mono">
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="エンドポイント"
          aria-invalid={endpointError !== null}
          aria-describedby={endpointError !== null ? endpointErrorId : undefined}
          className="font-mono"
          placeholder="https://api.example.com/v1/endpoint"
          spellCheck={false}
          autoComplete="off"
          value={endpoint}
          onChange={(event) => onEndpointChange(event.target.value)}
          onKeyDown={handleEndpointKeyDown}
        />
        {/*
          「送信」と「中止」を同じ位置で差し替えると、ダブルクリックの 2 回目が「中止」を押してしまう。
          送信は通信中だけ無効にして残し、中止は隣に足す。
        */}
        <Button type="button" onClick={onSend} disabled={busy}>
          <Send aria-hidden />
          送信
        </Button>
        {busy && (
          <Button type="button" variant="destructive" onClick={onAbort}>
            <Square aria-hidden />
            中止
          </Button>
        )}
      </div>
      {endpointError !== null && (
        <p id={endpointErrorId} className="text-xs text-destructive">
          {endpointError}
        </p>
      )}

      <Textarea
        aria-label="リクエストボディ"
        className="max-h-56 min-h-24 resize-none font-mono text-xs md:text-xs"
        placeholder={noBody ? 'GET ではボディを送信しません' : '{ "key": "value" }'}
        spellCheck={false}
        disabled={noBody}
        value={body}
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={handleBodyKeyDown}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <div aria-live="polite">
          <JsonIndicator method={method} state={json} />
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={noBody || json.kind !== 'valid'}
          onClick={handleFormat}
        >
          <WandSparkles aria-hidden />
          整形
        </Button>
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          <Kbd>⌘ / Ctrl</Kbd>
          <span aria-hidden>+</span>
          <Kbd>Enter</Kbd>
          で送信
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>設定パネルの値が自動で適用されます:</span>
        <Badge variant="outline">追加ヘッダー {applied.headerCount} 件</Badge>
        {applied.hasBearer && <Badge variant="outline">Bearer トークン</Badge>}
        <Badge variant="outline">
          {applied.useDevProxy
            ? `${PROXY_NAME}経由（credentials: omit）`
            : `credentials: ${applied.credentials}`}
        </Badge>
        <span>
          JSON の body には Content-Type: application/json を付けます（ヘッダー設定を優先）。
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        この画面の表示は未マスクです。画面共有時は注意してください（インスペクタは既定でマスクします）。
      </p>
    </section>
  )
}
