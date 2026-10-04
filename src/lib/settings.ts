import { MODES } from '@/types'
import type {
  CompletionProtocol,
  ConnectionSettings,
  CredentialsMode,
  HeaderEntry,
  Mode,
  RawMethod,
} from '@/types'

export const MOCK_ENDPOINTS: Record<Mode, string> = {
  'chat-ui': 'http://localhost:28787/api/chat',
  'chat-text': 'http://localhost:28787/api/text',
  completion: 'http://localhost:28787/api/completion',
  raw: 'http://localhost:28787/api/json',
}

const CREDENTIALS_MODES: readonly CredentialsMode[] = ['omit', 'same-origin', 'include']
const COMPLETION_PROTOCOLS: readonly CompletionProtocol[] = ['data', 'text']
const RAW_METHODS: readonly RawMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const DEFAULT_RAW_BODY = '{\n  "hello": "world"\n}'

export function createDefaultSettings(): ConnectionSettings {
  return {
    mode: 'chat-ui',
    // 呼び出しごとに別オブジェクトにする（共有すると update 側の変更が定数を汚染する）
    endpoints: { ...MOCK_ENDPOINTS },
    headers: [],
    bearerToken: '',
    extraBody: '',
    credentials: 'same-origin',
    useDevProxy: false,
    sendLastMessageOnly: false,
    autoSendAfterToolOutput: true,
    completionProtocol: 'data',
    rawMethod: 'POST',
    rawBody: DEFAULT_RAW_BODY,
  }
}

export function applyMockPreset(s: ConnectionSettings): ConnectionSettings {
  return { ...s, endpoints: { ...MOCK_ENDPOINTS } }
}

let idCounter = 0

/** crypto.randomUUID が無い環境（非セキュアコンテキストなど）向けのフォールバック付き ID 生成。 */
function generateId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (typeof c?.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      // 下のフォールバックに進む
    }
  }
  idCounter += 1
  return `h-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function newHeaderEntry(init?: Partial<Omit<HeaderEntry, 'id'>>): HeaderEntry {
  return {
    id: generateId(),
    name: init?.name ?? '',
    value: init?.value ?? '',
    enabled: init?.enabled ?? true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeHeaders(raw: unknown): HeaderEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: HeaderEntry[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    let id = typeof item.id === 'string' && item.id !== '' ? item.id : generateId()
    // 保存値の改変や重複で React key が衝突しないよう、重複 ID は採番し直す
    while (seen.has(id)) id = generateId()
    seen.add(id)
    result.push({
      id,
      name: pickString(item.name, ''),
      value: pickString(item.value, ''),
      enabled: pickBoolean(item.enabled, true),
    })
  }
  return result
}

/** 永続化された値など信頼できない入力から ConnectionSettings を復元する。絶対に throw しない。 */
export function normalizeSettings(raw: unknown): ConnectionSettings {
  try {
    return normalizeRecord(raw)
  } catch {
    // JSON 由来の値では起きないが、getter が例外を投げる入力などでも起動を止めない
    return createDefaultSettings()
  }
}

function normalizeRecord(raw: unknown): ConnectionSettings {
  const defaults = createDefaultSettings()
  if (!isRecord(raw)) return defaults

  const rawEndpoints = isRecord(raw.endpoints) ? raw.endpoints : {}
  const endpoints = { ...defaults.endpoints }
  for (const mode of MODES) {
    // 空文字は「ユーザーがあえて消した状態」なので保持する（検証は validateEndpoint の役目）
    endpoints[mode] = pickString(rawEndpoints[mode], defaults.endpoints[mode])
  }

  return {
    mode: pickEnum(raw.mode, MODES, defaults.mode),
    endpoints,
    headers: normalizeHeaders(raw.headers),
    bearerToken: pickString(raw.bearerToken, ''),
    extraBody: pickString(raw.extraBody, defaults.extraBody),
    credentials: pickEnum(raw.credentials, CREDENTIALS_MODES, defaults.credentials),
    useDevProxy: pickBoolean(raw.useDevProxy, defaults.useDevProxy),
    sendLastMessageOnly: pickBoolean(raw.sendLastMessageOnly, defaults.sendLastMessageOnly),
    autoSendAfterToolOutput: pickBoolean(
      raw.autoSendAfterToolOutput,
      defaults.autoSendAfterToolOutput,
    ),
    completionProtocol: pickEnum(
      raw.completionProtocol,
      COMPLETION_PROTOCOLS,
      defaults.completionProtocol,
    ),
    rawMethod: pickEnum(raw.rawMethod, RAW_METHODS, defaults.rawMethod),
    rawBody: pickString(raw.rawBody, defaults.rawBody),
  }
}

export type ParsedExtraBody =
  { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string }

export function parseExtraBody(text: string): ParsedExtraBody {
  if (text.trim() === '') return { ok: true, value: undefined }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `追加ボディが正しいJSONではありません（${detail}）` }
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: '追加ボディはJSONオブジェクト（{ ... }）で指定してください' }
  }
  return { ok: true, value: parsed }
}

/** OK なら null、NG なら日本語のエラー文を返す。 */
export function validateEndpoint(value: string): string | null {
  const v = value.trim()
  if (v === '') return 'エンドポイントを入力してください'

  if (/^https?:\/\//i.test(v)) {
    try {
      new URL(v)
    } catch {
      return 'URLの形式が正しくありません'
    }
    return null
  }

  if (v.startsWith('/')) {
    try {
      new URL(v, 'http://localhost')
    } catch {
      return 'パスの形式が正しくありません'
    }
    return null
  }

  return 'http:// か https:// で始まる絶対URL、または / で始まるパスを指定してください'
}
