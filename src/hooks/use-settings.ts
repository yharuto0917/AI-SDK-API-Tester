import { useMemo, useSyncExternalStore } from 'react'
import { settingsStore } from '@/lib/settings-store'
import type { SettingsStore } from '@/lib/settings-store'
import type { ConnectionSettings } from '@/types'

export function useSettings(): {
  settings: ConnectionSettings
  update: SettingsStore['update']
  reset: () => void
} {
  const settings = useSyncExternalStore(
    settingsStore.subscribe,
    settingsStore.getSettings,
    settingsStore.getSettings,
  )
  // update / reset はストアのクロージャで安定しているので、settings が変わったときだけ新しい参照にする
  return useMemo(
    () => ({ settings, update: settingsStore.update, reset: settingsStore.reset }),
    [settings],
  )
}
