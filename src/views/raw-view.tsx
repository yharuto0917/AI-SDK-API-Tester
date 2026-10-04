import { RawRequestForm } from '@/components/raw/raw-request-form'
import { RawResponsePanel } from '@/components/raw/raw-response-panel'
import { useRawRequest } from '@/hooks/use-raw-request'
import { useSettings } from '@/hooks/use-settings'

/**
 * 任意の HTTP リクエストを送り、レスポンスをそのまま観察するビュー。
 * メソッド・エンドポイント・ボディは設定ストアと双方向で、設定パネルの同じ項目と同じ状態を共有する。
 */
export function RawView() {
  const { settings, update } = useSettings()
  const request = useRawRequest()

  const applied = {
    useDevProxy: settings.useDevProxy,
    headerCount: settings.headers.filter((h) => h.enabled && h.name.trim() !== '').length,
    hasBearer: settings.bearerToken.trim() !== '',
    credentials: settings.credentials,
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4">
      <RawRequestForm
        method={settings.rawMethod}
        endpoint={settings.endpoints.raw}
        body={settings.rawBody}
        busy={request.busy}
        applied={applied}
        onMethodChange={(rawMethod) => update({ rawMethod })}
        // patch は浅いマージなので、他モードのエンドポイントを消さないよう関数形式で更新する
        onEndpointChange={(raw) =>
          update((prev) => ({ ...prev, endpoints: { ...prev.endpoints, raw } }))
        }
        onBodyChange={(rawBody) => update({ rawBody })}
        onSend={() => void request.send()}
        onAbort={request.abort}
      />
      <RawResponsePanel state={request.state} onClear={request.clear} />
    </div>
  )
}
