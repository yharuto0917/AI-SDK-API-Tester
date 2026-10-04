import { useState } from 'react'
import { DatabaseIcon, RotateCcwIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Hint, SettingsSection } from '@/components/settings/settings-section'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useSettings } from '@/hooks/use-settings'

export function ResetSection() {
  const { reset } = useSettings()
  const [open, setOpen] = useState(false)

  function confirmReset(): void {
    reset()
    setOpen(false)
    toast.success('設定をリセットしました')
  }

  return (
    <SettingsSection title="保存とリセット" icon={DatabaseIcon}>
      <Hint>設定はこのブラウザの localStorage に保存されます（Bearer トークンを除く）。</Hint>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <RotateCcwIcon aria-hidden="true" />
            設定をリセット
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>設定をリセットしますか？</DialogTitle>
            <DialogDescription>
              エンドポイント・追加ヘッダー・Bearer
              トークン・追加ボディなど、すべての設定が初期値に戻ります。この操作は元に戻せません。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                キャンセル
              </Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={confirmReset}>
              リセットする
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}
