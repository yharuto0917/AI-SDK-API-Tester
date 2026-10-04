import { DownloadIcon, Trash2Icon } from 'lucide-react'
import { useId } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

interface InspectorHeaderProps {
  count: number
  /** 保存対象（選択中の通信）があるか */
  canExport: boolean
  revealSecrets: boolean
  onRevealSecretsChange: (reveal: boolean) => void
  onClear: () => void
  onExport: () => void
}

/** 件数・クリア・秘匿情報の表示切替・JSON 保存。 */
export function InspectorHeader({
  count,
  canExport,
  revealSecrets,
  onRevealSecretsChange,
  onClear,
  onExport,
}: InspectorHeaderProps) {
  const switchId = useId()
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">インスペクタ</h2>
        <Badge variant="secondary" aria-label={`通信 ${count} 件`} className="tabular-nums">
          {count}
        </Badge>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-1.5">
          <Switch
            id={switchId}
            size="sm"
            checked={revealSecrets}
            onCheckedChange={onRevealSecretsChange}
          />
          <Label htmlFor={switchId} className="text-xs font-normal">
            秘匿情報を表示
          </Label>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={!canExport} onClick={onExport}>
          <DownloadIcon aria-hidden />
          ログをJSONで保存
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={count === 0} onClick={onClear}>
          <Trash2Icon aria-hidden />
          クリア
        </Button>
      </div>
    </header>
  )
}
