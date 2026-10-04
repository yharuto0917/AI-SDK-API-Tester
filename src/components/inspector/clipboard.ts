import { toast } from 'sonner'

/** クリップボードにコピーし、結果をトーストで知らせる。非対応環境・拒否のときは false を返す。 */
export async function copyToClipboard(text: string, label: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      throw new Error('このブラウザではクリップボードを利用できません')
    }
    await navigator.clipboard.writeText(text)
    toast.success(`${label}をコピーしました`)
    return true
  } catch (error) {
    toast.error(`${label}をコピーできませんでした`, {
      description: error instanceof Error ? error.message : undefined,
    })
    return false
  }
}
