import { toast } from 'sonner'

/**
 * テキストをファイルとして保存させる。失敗したらトーストで知らせ、例外は投げない。
 * description は成功トーストに添える補足（保存内容に関する注意など）。
 */
export function downloadTextFile(
  fileName: string,
  text: string,
  mime = 'application/json',
  description?: string,
): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    // 直後に revoke するとダウンロード開始前に無効になるブラウザがある
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // 既に無効になっている、または非対応の環境。解放できなくても保存自体には影響しない
      }
    }, 1000)
    toast.success(`${fileName} を保存しました`, description === undefined ? {} : { description })
    return true
  } catch (error) {
    toast.error('ファイルを保存できませんでした', {
      description: error instanceof Error ? error.message : undefined,
    })
    return false
  }
}
