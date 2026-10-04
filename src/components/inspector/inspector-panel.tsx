import { InspectorView } from '@/components/inspector/inspector-view'
import { useNetworkLog } from '@/hooks/use-network-log'

/**
 * バックエンドとの通信を観察・診断する右ペイン。
 * ネットワークログを購読して InspectorView に渡すだけの薄い殻。
 */
export function InspectorPanel() {
  const { entries, selectedId, selectedEntry, select, clear } = useNetworkLog()
  return (
    <InspectorView
      entries={entries}
      selectedId={selectedId}
      selectedEntry={selectedEntry}
      select={select}
      clear={clear}
    />
  )
}
