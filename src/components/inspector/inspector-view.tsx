import { MousePointerClickIcon } from 'lucide-react'
import { useState } from 'react'
import { downloadTextFile } from '@/components/inspector/download'
import { EmptyState } from '@/components/inspector/empty-state'
import { EntryDetail } from '@/components/inspector/entry-detail'
import {
  exportFileName,
  MASKING_NOTE,
  serializeEntryExport,
} from '@/components/inspector/export-utils'
import { InspectorHeader } from '@/components/inspector/inspector-header'
import { RequestList } from '@/components/inspector/request-list'
import { Separator } from '@/components/ui/separator'
import type { NetworkLogEntry } from '@/types'

export interface InspectorViewProps {
  /** 新しい順 */
  entries: readonly NetworkLogEntry[]
  selectedId: string | null
  selectedEntry: NetworkLogEntry | undefined
  select: (id: string | null) => void
  clear: () => void
}

/**
 * インスペクタの表示本体。状態を持たない（秘匿情報の表示切替だけローカル状態）ので、
 * useNetworkLog の戻り値をそのまま渡せる。テストでは偽のエントリを直接渡す。
 */
export function InspectorView({
  entries,
  selectedId,
  selectedEntry,
  select,
  clear,
}: InspectorViewProps) {
  // 既定は伏せる。画面表示・コピー・JSON 保存のすべてがこの値に従う
  const [revealSecrets, setRevealSecrets] = useState(false)

  const handleExport = () => {
    if (selectedEntry === undefined) return
    downloadTextFile(
      exportFileName(selectedEntry),
      serializeEntryExport(selectedEntry, { revealSecrets }),
      'application/json',
      // マスクは完全ではないので、共有する前に確認してもらう
      revealSecrets ? '秘匿情報をマスクせずに保存しました' : MASKING_NOTE,
    )
  }

  return (
    <section aria-label="インスペクタ" className="flex h-full min-h-0 flex-col bg-background">
      <InspectorHeader
        count={entries.length}
        canExport={selectedEntry !== undefined}
        revealSecrets={revealSecrets}
        onRevealSecretsChange={setRevealSecrets}
        onClear={clear}
        onExport={handleExport}
      />
      <Separator />
      <div className="flex min-h-28 basis-[34%] shrink-0 flex-col">
        <RequestList
          entries={entries}
          selectedId={selectedId}
          onSelect={select}
          revealSecrets={revealSecrets}
        />
      </div>
      <Separator />
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedEntry === undefined ? (
          <EmptyState
            icon={MousePointerClickIcon}
            title="通信を選択してください"
            description="一覧から選ぶと、診断・リクエスト・レスポンス・ストリームを確認できます"
          />
        ) : (
          <EntryDetail entry={selectedEntry} revealSecrets={revealSecrets} />
        )}
      </div>
    </section>
  )
}
