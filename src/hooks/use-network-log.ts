import { useMemo, useSyncExternalStore } from 'react'
import { networkLog } from '@/lib/network-log'
import type { NetworkLogEntry } from '@/types'

export function useNetworkLog(): {
  entries: readonly NetworkLogEntry[]
  selectedId: string | null
  selectedEntry: NetworkLogEntry | undefined
  select: (id: string | null) => void
  clear: () => void
} {
  const entries = useSyncExternalStore(
    networkLog.subscribe,
    networkLog.getEntries,
    networkLog.getEntries,
  )
  const selectedId = useSyncExternalStore(
    networkLog.subscribe,
    networkLog.getSelectedId,
    networkLog.getSelectedId,
  )
  // select / clear はストアのクロージャで安定しているので、状態が変わったときだけ新しい参照にする
  return useMemo(
    () => ({
      entries,
      selectedId,
      selectedEntry:
        selectedId === null ? undefined : entries.find((entry) => entry.id === selectedId),
      select: networkLog.select,
      clear: networkLog.clear,
    }),
    [entries, selectedId],
  )
}
