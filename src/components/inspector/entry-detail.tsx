import { useState } from 'react'
import { DiagnosticsTab } from '@/components/inspector/diagnostics-tab'
import { countLevel, LEVEL_LABELS, worstLevel } from '@/components/inspector/diagnostics-utils'
import { RequestTab } from '@/components/inspector/request-tab'
import { ResponseTab } from '@/components/inspector/response-tab'
import { StreamTab } from '@/components/inspector/stream-tab'
import { LEVEL_BADGE_CLASSES } from '@/components/inspector/tone-classes'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { NetworkLogEntry } from '@/types'

type DetailTab = 'diagnostics' | 'request' | 'response' | 'stream'

const DETAIL_TABS: readonly DetailTab[] = ['diagnostics', 'request', 'response', 'stream']

function isDetailTab(value: string): value is DetailTab {
  return (DETAIL_TABS as readonly string[]).includes(value)
}

interface EntryDetailProps {
  entry: NetworkLogEntry
  /** true のとき Authorization などをマスクせずに表示・コピーする */
  revealSecrets: boolean
}

/** 選択中の通信の詳細。診断 / リクエスト / レスポンス / ストリームのタブ。 */
export function EntryDetail({ entry, revealSecrets }: EntryDetailProps) {
  const [tab, setTab] = useState<DetailTab>('diagnostics')

  const worst = worstLevel(entry.diagnostics)
  const worstCount = worst === undefined ? 0 : countLevel(entry.diagnostics, worst)

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isDetailTab(value)) setTab(value)
      }}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="shrink-0 px-2 pt-2 pb-1.5">
        <TabsList className="w-full">
          <TabsTrigger value="diagnostics" className="text-xs">
            診断
            {worst !== undefined ? (
              <Badge
                variant="outline"
                data-level={worst}
                aria-label={`${LEVEL_LABELS[worst]} ${worstCount} 件`}
                className={cn(
                  'h-4 min-w-4 px-1 text-[10px] tabular-nums',
                  LEVEL_BADGE_CLASSES[worst],
                )}
              >
                {worstCount}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="request" className="text-xs">
            リクエスト
          </TabsTrigger>
          <TabsTrigger value="response" className="text-xs">
            レスポンス
          </TabsTrigger>
          <TabsTrigger value="stream" className="text-xs">
            ストリーム
            {entry.events.length > 0 ? (
              <Badge
                variant="secondary"
                aria-label={`イベント ${entry.events.length} 件`}
                className="h-4 min-w-4 px-1 text-[10px] tabular-nums"
              >
                {entry.events.length}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="diagnostics" className="min-h-0 flex-1 overflow-auto">
        <DiagnosticsTab entry={entry} revealSecrets={revealSecrets} />
      </TabsContent>
      <TabsContent value="request" className="min-h-0 flex-1 overflow-auto">
        {/* 本文の「全文を表示」の状態を通信ごとに作り直す */}
        <RequestTab key={entry.id} entry={entry} revealSecrets={revealSecrets} />
      </TabsContent>
      <TabsContent value="response" className="min-h-0 flex-1 overflow-auto">
        {/* 全文表示の状態を通信ごとに作り直す */}
        <ResponseTab key={entry.id} entry={entry} revealSecrets={revealSecrets} />
      </TabsContent>
      <TabsContent
        value="stream"
        className="min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col"
      >
        <StreamTab
          key={entry.id}
          entry={entry}
          revealSecrets={revealSecrets}
          onOpenResponse={() => setTab('response')}
        />
      </TabsContent>
    </Tabs>
  )
}
