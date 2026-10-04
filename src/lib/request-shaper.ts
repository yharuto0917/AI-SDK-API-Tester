import { isForbiddenRequestHeader } from '@/lib/forbidden-headers'
import { PROXY_PATH, PROXY_TARGET_HEADER } from '@/lib/proxy'
import { parseExtraBody, validateEndpoint } from '@/lib/settings'
import type { ConnectionSettings, Mode } from '@/types'

/**
 * リクエスト整形の唯一の場所。
 * AI SDK のトランスポートが組み立てた fetch の引数に、設定画面の内容（エンドポイント・ヘッダー・
 * 追加ボディ・プロキシ）を重ねて「実際に送るもの」と「ログ用の表現」を同時に決める。
 */
export class RequestShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestShapeError'
  }
}

export interface ShapeRequestInput {
  mode: Mode
  settings: ConnectionSettings
  init?: RequestInit
}

export interface ShapedRequest {
  /** ユーザーが指定した実際の宛先（プロキシ経由でも /__proxy ではなくこちら） */
  targetUrl: string
  method: string
  /**
   * 宛先に届く実効ヘッダー（キーは小文字、マスクなし）。x-proxy-target は含めない。
   * ブラウザの fetch が捨てるヘッダー（Cookie / Origin など）は、送られないので含めない
   */
  headers: Record<string, string>
  /** 指定されたが、ブラウザの仕様で送信されないヘッダー名（小文字）。値は載せない（Cookie など機密のため） */
  droppedHeaders: string[]
  /** ログ・curl 用の body 文字列表現（body なしなら undefined） */
  requestBody?: string
  viaProxy: boolean
  /** fetch に渡す URL（プロキシ経由なら PROXY_PATH） */
  fetchUrl: string
  /** fetch に渡す init。プロキシ経由なら headers に x-proxy-target が加わる */
  fetchInit: RequestInit
}

/** RFC 7230 の token。ヘッダー名・メソッド名に使える文字。 */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const NO_BODY_METHODS = new Set(['GET', 'HEAD'])

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function resolveTargetUrl(endpoint: string): string {
  if (isAbsoluteHttpUrl(endpoint)) return endpoint
  const location = (globalThis as { location?: { href?: string } }).location
  if (typeof location?.href === 'string') {
    try {
      return new URL(endpoint, location.href).href
    } catch {
      // 検証済みなので通常は到達しない。解決できなければそのまま返す
    }
  }
  return endpoint
}

/** Headers / [string, string][] / Record のいずれも [name, value][] にそろえる。 */
function headerPairs(headers: HeadersInit | undefined): Array<[string, string]> {
  if (headers === undefined || headers === null) return []
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const pairs: Array<[string, string]> = []
    headers.forEach((value, name) => pairs.push([name, value]))
    return pairs
  }
  if (Array.isArray(headers)) {
    return headers.map((pair): [string, string] => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new RequestShapeError('ヘッダーの形式が正しくありません（[名前, 値] の組が必要です）')
      }
      return [String(pair[0]), String(pair[1])]
    })
  }
  const pairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(headers)) {
    // SDK は Record<string, string | undefined> を渡すことがあるため、undefined は「指定なし」として捨てる
    if (value === undefined || value === null) continue
    pairs.push([name, String(value)])
  }
  return pairs
}

function hasInvalidHeaderValueChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0 || code === 0x0a || code === 0x0d || code > 0xff) return true
  }
  return false
}

function assertValidHeader(name: string, value: string): void {
  if (!TOKEN_RE.test(name)) {
    throw new RequestShapeError(`ヘッダー名「${name}」に使えない文字が含まれています`)
  }
  // fetch は ISO-8859-1 外の文字と CR / LF / NUL を含む値を TypeError で拒否するため、先に分かりやすく止める
  if (hasInvalidHeaderValueChar(value)) {
    throw new RequestShapeError(
      `ヘッダー「${name}」の値に使えない文字（改行・NUL・非 ISO-8859-1 文字）が含まれています`,
    )
  }
}

function mergeHeaders(
  initHeaders: HeadersInit | undefined,
  settings: ConnectionSettings,
): Record<string, string> {
  const merged = new Map<string, string>()
  for (const [rawName, rawValue] of headerPairs(initHeaders)) {
    const name = rawName.trim()
    const value = rawValue.trim()
    assertValidHeader(name, value)
    merged.set(name.toLowerCase(), value)
  }
  // 設定画面のヘッダーは SDK 側の指定より優先する（後勝ち）
  for (const entry of settings.headers) {
    const name = entry.name.trim()
    if (!entry.enabled || name === '') continue
    const value = entry.value.trim()
    assertValidHeader(name, value)
    merged.set(name.toLowerCase(), value)
  }
  const token = settings.bearerToken.trim()
  if (token !== '' && !merged.has('authorization')) {
    const value = `Bearer ${token}`
    assertValidHeader('authorization', value)
    merged.set('authorization', value)
  }
  return Object.fromEntries(merged)
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 文字列以外の body をログ用の説明文字列にする。 */
function describeBody(body: BodyInit): string {
  if (typeof FormData !== 'undefined' && body instanceof FormData) return '[FormData]'
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString()
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return `[Blob ${body.size} bytes]`
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return `[binary ${body.byteLength} bytes]`
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return '[ReadableStream]'
  }
  return '[binary body]'
}

/** Chat / Completion の JSON body に、設定（最後の 1 件のみ・追加ボディ）を反映する。 */
function shapeJsonBody(
  mode: Mode,
  settings: ConnectionSettings,
  parsed: Record<string, unknown>,
): string {
  const shaped: Record<string, unknown> = { ...parsed }
  const isChat = mode === 'chat-ui' || mode === 'chat-text'
  if (isChat && settings.sendLastMessageOnly && Array.isArray(shaped.messages)) {
    shaped.messages = shaped.messages.slice(-1)
  }
  const extra = parseExtraBody(settings.extraBody)
  if (!extra.ok) throw new RequestShapeError(extra.error)
  // 追加ボディが優先（SDK が付けたキーも上書きできる）
  if (extra.value !== undefined) Object.assign(shaped, extra.value)
  return JSON.stringify(shaped)
}

export function shapeRequest(input: ShapeRequestInput): ShapedRequest {
  const { mode, settings, init } = input

  // エンドポイントは SDK に固定された api 文字列ではなく、常に最新の設定から解決する
  const endpoint = settings.endpoints[mode].trim()
  const endpointError = validateEndpoint(endpoint)
  if (endpointError !== null) throw new RequestShapeError(endpointError)

  const viaProxy = settings.useDevProxy
  if (viaProxy && !isAbsoluteHttpUrl(endpoint)) {
    throw new RequestShapeError('プロキシ利用時は絶対URLを指定してください')
  }
  const targetUrl = resolveTargetUrl(endpoint)

  const method = (init?.method || (mode === 'raw' ? settings.rawMethod : 'POST'))
    .trim()
    .toUpperCase()
  if (!TOKEN_RE.test(method)) {
    throw new RequestShapeError(`HTTPメソッド「${method}」が正しくありません`)
  }

  const headers: Record<string, string> = {}
  const droppedHeaders: string[] = []
  for (const [name, value] of Object.entries(mergeHeaders(init?.headers, settings))) {
    // fetch に渡しても黙って捨てられるので、最初から「送らないもの」として分ける
    if (isForbiddenRequestHeader(name, value)) droppedHeaders.push(name)
    else headers[name] = value
  }
  if (viaProxy) {
    // プロキシが自分宛ての制御ヘッダーとして取り除くため、実効ヘッダーには含めない
    delete headers[PROXY_TARGET_HEADER]
  }

  let body: BodyInit | undefined
  if (!NO_BODY_METHODS.has(method)) {
    if (mode === 'raw') {
      const initBody = init?.body ?? undefined
      body =
        initBody !== undefined
          ? initBody
          : settings.rawBody.trim() !== ''
            ? settings.rawBody
            : undefined
    } else {
      body = init?.body ?? undefined
      if (typeof body === 'string') {
        const parsed = parseJsonObject(body)
        // JSON オブジェクトでない body は意図が分からないので触らずそのまま通す
        if (parsed !== undefined) body = shapeJsonBody(mode, settings, parsed)
      }
    }
  }

  if (typeof body === 'string' && !('content-type' in headers)) {
    if (mode !== 'raw' || isJson(body)) headers['content-type'] = 'application/json'
  }

  const requestBody =
    body === undefined ? undefined : typeof body === 'string' ? body : describeBody(body)

  const fetchHeaders = viaProxy ? { ...headers, [PROXY_TARGET_HEADER]: targetUrl } : headers
  const fetchInit: RequestInit = {
    method,
    headers: fetchHeaders,
    credentials: viaProxy ? 'omit' : settings.credentials,
    // 動作確認では毎回サーバーに届く必要がある。プロキシ経由は URL が常に /__proxy で、宛先は
    // リクエストヘッダーにしか無いため、HTTP キャッシュが別の宛先の応答を返してしまう
    cache: 'no-store',
  }
  if (body !== undefined) fetchInit.body = body
  if (init?.signal) fetchInit.signal = init.signal

  return {
    targetUrl,
    method,
    headers,
    droppedHeaders,
    requestBody,
    viaProxy,
    fetchUrl: viaProxy ? PROXY_PATH : targetUrl,
    fetchInit,
  }
}
