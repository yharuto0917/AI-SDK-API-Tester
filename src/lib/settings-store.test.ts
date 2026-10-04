import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings, newHeaderEntry } from '@/lib/settings'
import {
  BEARER_TOKEN_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  createSettingsStore,
  settingsStore,
} from '@/lib/settings-store'

interface FakeStorage {
  storage: Storage
  data: Map<string, string>
  setItem: ReturnType<typeof vi.fn>
  removeItem: ReturnType<typeof vi.fn>
}

function createFakeStorage(overrides: Partial<Record<keyof Storage, unknown>> = {}): FakeStorage {
  const data = new Map<string, string>()
  const setItem = vi.fn((key: string, value: string) => {
    data.set(key, String(value))
  })
  const removeItem = vi.fn((key: string) => {
    data.delete(key)
  })
  const storage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => (data.has(key) ? (data.get(key) ?? null) : null),
    key: (index: number) => [...data.keys()][index] ?? null,
    setItem,
    removeItem,
    ...overrides,
  } as unknown as Storage
  return { storage, data, setItem, removeItem }
}

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, 'localStorage')
  Reflect.deleteProperty(globalThis, 'sessionStorage')
})

function makeStore() {
  const local = createFakeStorage()
  const session = createFakeStorage()
  const store = createSettingsStore({ local: local.storage, session: session.storage })
  return { store, local, session }
}

describe('初期化', () => {
  it('ストレージが空なら既定値で始まる', () => {
    const { store } = makeStore()
    expect(store.getSettings()).toEqual(createDefaultSettings())
  })

  it('変更が無い限り getSettings は同一参照を返す', () => {
    const { store } = makeStore()
    expect(store.getSettings()).toBe(store.getSettings())
  })

  it('保存済みの値を normalizeSettings を通して復元する', () => {
    const local = createFakeStorage()
    const session = createFakeStorage()
    local.data.set(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        mode: 'raw',
        useDevProxy: true,
        headers: [{ id: 'h1', name: 'x-a', value: '1', enabled: false }],
      }),
    )
    session.data.set(BEARER_TOKEN_STORAGE_KEY, 'tok-123')
    const store = createSettingsStore({ local: local.storage, session: session.storage })
    expect(store.getSettings()).toEqual({
      ...createDefaultSettings(),
      mode: 'raw',
      useDevProxy: true,
      headers: [{ id: 'h1', name: 'x-a', value: '1', enabled: false }],
      bearerToken: 'tok-123',
    })
  })

  it('保存値に欠損や不正な値があっても既定値で補完する', () => {
    const local = createFakeStorage()
    local.data.set(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ mode: 'bogus', credentials: 5, headers: 'x', endpoints: { raw: '/r' } }),
    )
    const store = createSettingsStore({
      local: local.storage,
      session: createFakeStorage().storage,
    })
    const settings = store.getSettings()
    expect(settings.mode).toBe('chat-ui')
    expect(settings.credentials).toBe('same-origin')
    expect(settings.headers).toEqual([])
    expect(settings.endpoints.raw).toBe('/r')
    expect(settings.endpoints['chat-ui']).toBe(createDefaultSettings().endpoints['chat-ui'])
  })

  it.each(['{', 'not json', '', 'null', '[]', '"str"', '123', 'true', '{"mode":'])(
    '壊れた保存値 (%j) でも throw せず既定値で始まる',
    (text) => {
      const local = createFakeStorage()
      local.data.set(SETTINGS_STORAGE_KEY, text)
      const store = createSettingsStore({
        local: local.storage,
        session: createFakeStorage().storage,
      })
      expect(store.getSettings()).toEqual(createDefaultSettings())
    },
  )

  it('bearerToken は sessionStorage の値だけを採用する（localStorage に紛れていても無視）', () => {
    const local = createFakeStorage()
    const session = createFakeStorage()
    local.data.set(SETTINGS_STORAGE_KEY, JSON.stringify({ bearerToken: 'leaked-from-local' }))
    let store = createSettingsStore({ local: local.storage, session: session.storage })
    expect(store.getSettings().bearerToken).toBe('')

    session.data.set(BEARER_TOKEN_STORAGE_KEY, 'from-session')
    store = createSettingsStore({ local: local.storage, session: session.storage })
    expect(store.getSettings().bearerToken).toBe('from-session')
  })
})

describe('永続化', () => {
  it('update の内容を localStorage に保存し、bearerToken は含めない', () => {
    const { store, local, session } = makeStore()
    store.update({ mode: 'completion', bearerToken: 'secret-token', useDevProxy: true })

    const saved = local.data.get(SETTINGS_STORAGE_KEY)
    expect(saved).toBeDefined()
    expect(saved).not.toContain('secret-token')
    const parsed = JSON.parse(saved ?? '') as Record<string, unknown>
    expect(parsed).not.toHaveProperty('bearerToken')
    expect(parsed).toMatchObject({ mode: 'completion', useDevProxy: true })
    expect(Object.keys(parsed).sort()).toEqual(
      Object.keys(createDefaultSettings())
        .filter((k) => k !== 'bearerToken')
        .sort(),
    )

    expect(session.data.get(BEARER_TOKEN_STORAGE_KEY)).toBe('secret-token')
    expect([...session.data.keys()]).toEqual([BEARER_TOKEN_STORAGE_KEY])
    expect([...local.data.keys()]).toEqual([SETTINGS_STORAGE_KEY])
  })

  it('保存キーは仕様どおり', () => {
    expect(SETTINGS_STORAGE_KEY).toBe('ai-sdk-tester:settings:v1')
    expect(BEARER_TOKEN_STORAGE_KEY).toBe('ai-sdk-tester:bearer-token')
  })

  it('同じストレージから新しいストアで往復復元できる（ヘッダー ID も保たれる）', () => {
    const { store, local, session } = makeStore()
    const header = newHeaderEntry({ name: 'x-a', value: 'v' })
    store.update({
      mode: 'chat-text',
      headers: [header],
      bearerToken: 'tok',
      extraBody: '{"a":1}',
      endpoints: { ...createDefaultSettings().endpoints, raw: '/custom' },
    })
    const reloaded = createSettingsStore({ local: local.storage, session: session.storage })
    expect(reloaded.getSettings()).toEqual(store.getSettings())
    expect(reloaded.getSettings().headers[0]?.id).toBe(header.id)
  })

  it('bearerToken を空にすると sessionStorage のキーを消す', () => {
    const { store, session } = makeStore()
    store.update({ bearerToken: 'tok' })
    expect(session.data.has(BEARER_TOKEN_STORAGE_KEY)).toBe(true)
    store.update({ bearerToken: '' })
    expect(session.data.has(BEARER_TOKEN_STORAGE_KEY)).toBe(false)
  })

  it('変更が無ければストレージへ書き込まない', () => {
    const { store, local, session } = makeStore()
    store.update({ mode: 'raw' })
    local.setItem.mockClear()
    session.setItem.mockClear()
    session.removeItem.mockClear()
    store.update({ mode: 'raw' })
    expect(local.setItem).not.toHaveBeenCalled()
    expect(session.setItem).not.toHaveBeenCalled()
    expect(session.removeItem).not.toHaveBeenCalled()
  })
})

describe('update / subscribe', () => {
  it('変更があれば参照が変わり、購読者に 1 回だけ通知する', () => {
    const { store } = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.getSettings()
    store.update({ mode: 'raw' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSettings()).not.toBe(before)
    expect(store.getSettings().mode).toBe('raw')
    // 変更していない項目は保たれ、元のオブジェクトは変更されない
    expect(before.mode).toBe('chat-ui')
    expect(store.getSettings().endpoints).toEqual(before.endpoints)
  })

  it('リスナーが呼ばれた時点で getSettings は新しい値を返す', () => {
    const { store } = makeStore()
    let seen: string | undefined
    store.subscribe(() => {
      seen = store.getSettings().mode
    })
    store.update({ mode: 'completion' })
    expect(seen).toBe('completion')
  })

  it('値が同じ patch では通知せず、参照も変えない', () => {
    const { store } = makeStore()
    store.update({ mode: 'raw' })
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.getSettings()
    store.update({ mode: 'raw' })
    store.update({})
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSettings()).toBe(before)
  })

  it('中身が同じ新しい endpoints / headers でも変更なしとして扱う', () => {
    const { store } = makeStore()
    const header = newHeaderEntry({ name: 'x-a', value: '1' })
    store.update({ headers: [header] })
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.getSettings()
    store.update({ endpoints: { ...before.endpoints } })
    store.update({ headers: [{ ...header }] })
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSettings()).toBe(before)
  })

  it('ヘッダーの 1 項目だけの変更も検知する', () => {
    const { store } = makeStore()
    const header = newHeaderEntry({ name: 'x-a', value: '1' })
    store.update({ headers: [header] })
    const listener = vi.fn()
    store.subscribe(listener)
    store.update({ headers: [{ ...header, enabled: false }] })
    expect(listener).toHaveBeenCalledTimes(1)
    store.update({ headers: [{ ...header, enabled: false }, newHeaderEntry()] })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('endpoints の 1 モードだけの変更も検知する', () => {
    const { store } = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.update((prev) => ({ ...prev, endpoints: { ...prev.endpoints, raw: '/changed' } }))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSettings().endpoints.raw).toBe('/changed')
  })

  it('関数形式の更新は直前の値を受け取る', () => {
    const { store } = makeStore()
    store.update({ rawBody: 'a' })
    store.update((prev) => ({ ...prev, rawBody: `${prev.rawBody}b` }))
    expect(store.getSettings().rawBody).toBe('ab')
  })

  it('関数形式で同じ値を返したときは通知しない', () => {
    const { store } = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.update((prev) => prev)
    store.update((prev) => ({ ...prev }))
    expect(listener).not.toHaveBeenCalled()
  })

  it('patch の undefined は「指定なし」として扱い、設定を壊さない', () => {
    const { store } = makeStore()
    store.update({ mode: 'raw' })
    store.update({ mode: undefined, rawBody: 'x' })
    expect(store.getSettings().mode).toBe('raw')
    expect(store.getSettings().rawBody).toBe('x')
  })

  it('unsubscribe 後は通知されない', () => {
    const { store } = makeStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.update({ mode: 'raw' })
    unsubscribe()
    unsubscribe()
    store.update({ mode: 'completion' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('複数の購読者すべてに通知する', () => {
    const { store } = makeStore()
    const a = vi.fn()
    const b = vi.fn()
    store.subscribe(a)
    store.subscribe(b)
    store.update({ mode: 'raw' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('通知中に購読解除しても他の購読者への通知は続く', () => {
    const { store } = makeStore()
    const second = vi.fn()
    const unsubscribeFirst = store.subscribe(() => unsubscribeFirst())
    store.subscribe(second)
    store.update({ mode: 'raw' })
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('update: 設定の全項目の変更を検知する（変更なしと誤判定しない）', () => {
  /**
   * 値の型に応じて、その項目だけを別の値にする。比べる項目は createDefaultSettings のキーから取るので、
   * ConnectionSettings に項目が増えても自動でこの表に加わり、比較の更新漏れがあれば落ちる。
   */
  function differentValue(value: unknown): unknown {
    if (typeof value === 'boolean') return !value
    if (typeof value === 'string') return `${value}!`
    if (typeof value === 'number') return value + 1
    if (Array.isArray(value)) return [...(value as unknown[]), newHeaderEntry({ name: 'x-new' })]
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, differentValue(item)]),
      )
    }
    throw new Error(`この型の値を変える方法が未定義です: ${typeof value}`)
  }

  const keys = Object.keys(createDefaultSettings()) as Array<
    keyof ReturnType<typeof createDefaultSettings>
  >

  it('対象の項目は、型で保証された ConnectionSettings の全キー', () => {
    // 表が空や一部だけになって素通りしないことの見張り
    expect(keys.length).toBeGreaterThanOrEqual(12)
    expect(keys).toEqual(expect.arrayContaining(['mode', 'endpoints', 'headers', 'bearerToken']))
  })

  it.each(keys)('%s だけを変える更新は、保存して購読者に通知する', (key) => {
    const { store, local, session } = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.getSettings()
    const next = differentValue(before[key])

    store.update({ [key]: next })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSettings()).not.toBe(before)
    expect(store.getSettings()[key]).toEqual(next)
    if (key === 'bearerToken') {
      expect(session.data.get(BEARER_TOKEN_STORAGE_KEY)).toBe(next)
    } else {
      const saved = JSON.parse(local.data.get(SETTINGS_STORAGE_KEY) ?? '{}') as Record<
        string,
        unknown
      >
      expect(saved[key]).toEqual(next)
    }
  })

  it.each(keys)('%s に同じ値（別オブジェクトの複製）を渡しても、変更なしとして扱う', (key) => {
    const { store } = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.getSettings()

    store.update({ [key]: structuredClone(before[key]) })

    expect(listener).not.toHaveBeenCalled()
    expect(store.getSettings()).toBe(before)
  })

  it('endpoints はモードごと、headers は id / name / value / enabled のどれか 1 つの違いでも検知する', () => {
    const { store } = makeStore()
    const header = newHeaderEntry({ name: 'x-a', value: '1' })
    store.update({ headers: [header] })
    const listener = vi.fn()
    store.subscribe(listener)

    for (const mode of Object.keys(store.getSettings().endpoints)) {
      store.update((prev) => ({
        ...prev,
        endpoints: { ...prev.endpoints, [mode]: `${prev.endpoints[mode as 'raw']}/x` },
      }))
    }
    expect(listener).toHaveBeenCalledTimes(4)

    const variants = [{ id: 'other-id' }, { name: 'x-b' }, { value: '2' }, { enabled: false }]
    for (const variant of variants) {
      listener.mockClear()
      store.update({ headers: [header] })
      listener.mockClear()
      store.update({ headers: [{ ...header, ...variant }] })
      expect(listener, JSON.stringify(variant)).toHaveBeenCalledTimes(1)
    }
  })

  it('ConnectionSettings に無いキーだけの patch は、変更なしとして扱う（保存されない）', () => {
    const { store, local } = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.update({ notASetting: 1 } as never)
    expect(listener).not.toHaveBeenCalled()
    expect(local.data.has(SETTINGS_STORAGE_KEY)).toBe(false)
  })
})

describe('reset', () => {
  it('既定値に戻し、保存済みの値を両方のストレージから消して通知する', () => {
    const { store, local, session } = makeStore()
    store.update({ mode: 'raw', bearerToken: 'tok', useDevProxy: true })
    const listener = vi.fn()
    store.subscribe(listener)

    store.reset()
    expect(store.getSettings()).toEqual(createDefaultSettings())
    expect(listener).toHaveBeenCalledTimes(1)
    expect(local.data.has(SETTINGS_STORAGE_KEY)).toBe(false)
    expect(session.data.has(BEARER_TOKEN_STORAGE_KEY)).toBe(false)

    // 再起動しても既定値
    const reloaded = createSettingsStore({ local: local.storage, session: session.storage })
    expect(reloaded.getSettings()).toEqual(createDefaultSettings())
  })

  it('既に既定値なら通知しないが、壊れた保存値は消す', () => {
    const local = createFakeStorage()
    const session = createFakeStorage()
    local.data.set(SETTINGS_STORAGE_KEY, '{broken')
    session.data.set(BEARER_TOKEN_STORAGE_KEY, '')
    const store = createSettingsStore({ local: local.storage, session: session.storage })
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.getSettings()
    store.reset()
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSettings()).toBe(before)
    expect(local.data.has(SETTINGS_STORAGE_KEY)).toBe(false)
  })

  it('reset 後の update は通常どおり動く', () => {
    const { store } = makeStore()
    store.update({ mode: 'raw' })
    store.reset()
    store.update({ mode: 'completion' })
    expect(store.getSettings().mode).toBe('completion')
  })
})

describe('Storage が使えない・例外を投げる環境', () => {
  it('getItem が例外を投げても既定値で始まる', () => {
    const throwing = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    const local = createFakeStorage({ getItem: throwing })
    const session = createFakeStorage({ getItem: throwing })
    const store = createSettingsStore({ local: local.storage, session: session.storage })
    expect(store.getSettings()).toEqual(createDefaultSettings())
  })

  it('setItem / removeItem が例外を投げても update・reset は続行し、メモリ上の値は更新される', () => {
    const throwing = () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    const local = createFakeStorage({ setItem: throwing, removeItem: throwing })
    const session = createFakeStorage({ setItem: throwing, removeItem: throwing })
    const store = createSettingsStore({ local: local.storage, session: session.storage })
    const listener = vi.fn()
    store.subscribe(listener)

    expect(() => store.update({ mode: 'raw', bearerToken: 'tok' })).not.toThrow()
    expect(store.getSettings().mode).toBe('raw')
    expect(store.getSettings().bearerToken).toBe('tok')
    expect(listener).toHaveBeenCalledTimes(1)

    expect(() => store.update({ bearerToken: '' })).not.toThrow()
    expect(() => store.reset()).not.toThrow()
    expect(store.getSettings()).toEqual(createDefaultSettings())
  })

  it('null を明示するとストレージ無しとして動く', () => {
    const store = createSettingsStore({ local: null, session: null })
    store.update({ mode: 'raw' })
    expect(store.getSettings().mode).toBe('raw')
    store.reset()
    expect(store.getSettings().mode).toBe('chat-ui')
  })

  it('local だけ null でも session のトークンは保存される', () => {
    const session = createFakeStorage()
    const store = createSettingsStore({ local: null, session: session.storage })
    store.update({ bearerToken: 'tok' })
    expect(session.data.get(BEARER_TOKEN_STORAGE_KEY)).toBe('tok')
  })

  it('引数省略時は globalThis の localStorage / sessionStorage を使う', () => {
    const local = createFakeStorage()
    const session = createFakeStorage()
    local.data.set(SETTINGS_STORAGE_KEY, JSON.stringify({ mode: 'completion' }))
    vi.stubGlobal('localStorage', local.storage)
    vi.stubGlobal('sessionStorage', session.storage)

    const store = createSettingsStore()
    expect(store.getSettings().mode).toBe('completion')
    store.update({ bearerToken: 'tok' })
    expect(session.data.get(BEARER_TOKEN_STORAGE_KEY)).toBe('tok')
    expect(local.data.get(SETTINGS_STORAGE_KEY)).toContain('completion')
  })

  it('一部だけ省略した場合、省略した側はグローバルを使う', () => {
    const session = createFakeStorage()
    vi.stubGlobal('sessionStorage', session.storage)
    const local = createFakeStorage()
    const store = createSettingsStore({ local: local.storage })
    store.update({ bearerToken: 'tok' })
    expect(session.data.get(BEARER_TOKEN_STORAGE_KEY)).toBe('tok')
  })

  it('グローバルの Storage へアクセスするだけで例外になる環境でも落ちない', () => {
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          throw new DOMException('access denied', 'SecurityError')
        },
      })
    }
    let store: ReturnType<typeof createSettingsStore> | undefined
    expect(() => {
      store = createSettingsStore()
    }).not.toThrow()
    expect(store?.getSettings()).toEqual(createDefaultSettings())
    expect(() => store?.update({ mode: 'raw' })).not.toThrow()
    expect(store?.getSettings().mode).toBe('raw')
  })

  it('グローバルに Storage が無い環境（Node など）でも動く', () => {
    expect(globalThis.localStorage).toBeUndefined()
    const store = createSettingsStore()
    store.update({ mode: 'raw' })
    expect(store.getSettings().mode).toBe('raw')
  })
})

describe('settingsStore（既定のシングルトン）', () => {
  it('SettingsStore の各メソッドを持ち、this に依存せず呼べる', () => {
    const { getSettings, subscribe, update, reset } = settingsStore
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    update({ mode: 'raw' })
    expect(getSettings().mode).toBe('raw')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    reset()
    expect(getSettings().mode).toBe('chat-ui')
  })
})
