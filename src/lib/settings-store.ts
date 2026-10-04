import { createDefaultSettings, normalizeSettings } from '@/lib/settings'
import type { ConnectionSettings } from '@/types'

/** localStorage のキー（bearerToken 以外の全項目） */
export const SETTINGS_STORAGE_KEY = 'ai-sdk-tester:settings:v1'
/** sessionStorage のキー（bearerToken のみ。タブを閉じたら消える） */
export const BEARER_TOKEN_STORAGE_KEY = 'ai-sdk-tester:bearer-token'

export interface SettingsStore {
  /** 変更が無い限り同一参照を返す（useSyncExternalStore の要件） */
  getSettings(): ConnectionSettings
  subscribe(listener: () => void): () => void
  update(
    patch: Partial<ConnectionSettings> | ((prev: ConnectionSettings) => ConnectionSettings),
  ): void
  reset(): void
}

export interface SettingsStorages {
  local?: Storage | null
  session?: Storage | null
}

/** アクセスするだけで例外になる環境（Cookie ブロック・サンドボックス等）でも落とさない。 */
function getGlobalStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return ((globalThis as { [k: string]: unknown })[kind] as Storage | undefined) ?? null
  } catch {
    return null
  }
}

function safeGet(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function safeSet(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // 容量超過・書き込み禁止などは握りつぶす（設定が揮発するだけで動作は続ける）
  }
}

function safeRemove(storage: Storage | null, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    // 同上
  }
}

/**
 * 比較の対象にする ConnectionSettings の全キー。
 * createDefaultSettings の戻り値は型で全項目が揃っていることが保証されるので、項目を足したときに
 * ここへ足し忘れて「変更なし」と誤判定する（保存も再描画もされない）ことが起きない。
 */
const SETTINGS_KEYS = Object.keys(createDefaultSettings()) as Array<keyof ConnectionSettings>

/** JSON で表せる値（文字列・数値・真偽値・null・配列・プレーンなオブジェクト）の構造的な等価比較。 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item: unknown, i) => jsonEqual(item, b[i]))
    )
  }
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const keys = Object.keys(aRecord)
  return (
    keys.length === Object.keys(bRecord).length &&
    keys.every((key) => Object.hasOwn(bRecord, key) && jsonEqual(aRecord[key], bRecord[key]))
  )
}

function settingsEqual(a: ConnectionSettings, b: ConnectionSettings): boolean {
  return a === b || SETTINGS_KEYS.every((key) => jsonEqual(a[key], b[key]))
}

/** patch の undefined は「指定なし」として扱う（Partial に明示的な undefined が混ざっても設定を壊さない）。 */
function mergePatch(
  prev: ConnectionSettings,
  patch: Partial<ConnectionSettings>,
): ConnectionSettings {
  const next: Record<string, unknown> = { ...prev }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value
  }
  return next as unknown as ConnectionSettings
}

export function createSettingsStore(storages?: SettingsStorages): SettingsStore {
  // undefined は「省略」＝グローバルを使う。null は「ストレージ無し」の明示。
  const local = storages?.local === undefined ? getGlobalStorage('localStorage') : storages.local
  const session =
    storages?.session === undefined ? getGlobalStorage('sessionStorage') : storages.session

  function load(): ConnectionSettings {
    let stored: unknown
    const text = safeGet(local, SETTINGS_STORAGE_KEY)
    if (text !== null) {
      try {
        stored = JSON.parse(text)
      } catch {
        stored = undefined
      }
    }
    const base = typeof stored === 'object' && stored !== null ? stored : {}
    // トークンは常に sessionStorage の値だけを採用する（localStorage に紛れ込んでいても無視）
    return normalizeSettings({
      ...base,
      bearerToken: safeGet(session, BEARER_TOKEN_STORAGE_KEY) ?? '',
    })
  }

  function persist(settings: ConnectionSettings): void {
    const { bearerToken, ...rest } = settings
    safeSet(local, SETTINGS_STORAGE_KEY, JSON.stringify(rest))
    if (bearerToken === '') safeRemove(session, BEARER_TOKEN_STORAGE_KEY)
    else safeSet(session, BEARER_TOKEN_STORAGE_KEY, bearerToken)
  }

  let current = load()
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  return {
    getSettings: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(patch) {
      const next = typeof patch === 'function' ? patch(current) : mergePatch(current, patch)
      if (settingsEqual(current, next)) return
      current = next
      persist(current)
      notify()
    },
    reset() {
      const next = createDefaultSettings()
      // 保存値は初期状態が現在値と同じでも必ず消す（壊れた保存値を残さない）
      safeRemove(local, SETTINGS_STORAGE_KEY)
      safeRemove(session, BEARER_TOKEN_STORAGE_KEY)
      if (settingsEqual(current, next)) return
      current = next
      notify()
    },
  }
}

export const settingsStore: SettingsStore = createSettingsStore()
