import { AuthSection } from '@/components/settings/auth-section'
import { ConnectionSection } from '@/components/settings/connection-section'
import { HeadersSection } from '@/components/settings/headers-section'
import { RequestSection } from '@/components/settings/request-section'
import { ResetSection } from '@/components/settings/reset-section'
import { Separator } from '@/components/ui/separator'

/** 接続設定パネル。入力は 1 文字ごとに設定ストアへ反映される。 */
export function SettingsPanel() {
  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <div className="flex flex-col gap-5 p-4">
        <ConnectionSection />
        <Separator />
        <AuthSection />
        <Separator />
        <HeadersSection />
        <Separator />
        <RequestSection />
        <Separator />
        <ResetSection />
      </div>
    </div>
  )
}
