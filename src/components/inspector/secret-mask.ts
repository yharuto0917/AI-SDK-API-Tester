/**
 * URL・リクエスト本文・レスポンス本文に含まれる秘匿情報を伏せる純粋関数。
 *
 * ヘッダーのマスク（lib/curl.ts の maskHeaders）だけでは、`?key=...` や `{"apiKey":"..."}`、
 * エコー系バックエンドが返す Bearer が素通しになるため、次の 2 つで補う。
 *  1. キー名による判定: クエリ名・JSON のキー・フォームのキーが秘匿情報らしければ、値を伏せる。
 *  2. 既知の値の置換: 設定中のトークンなど、既に秘匿と分かっている値を、他の場所に現れても伏せる。
 * どちらもヒューリスティクスなので、秘密が残らない保証はしない。
 * 伏せ字の形式（末尾を残す長さのしきい値・Bearer / Basic の扱い）は lib/curl.ts の maskSecretValue に一本化し、
 * ここでは再実装しない（ヘッダーと本文で見え方がずれないように）。
 * 本文は JSON.parse → stringify せず、該当する値の部分だけを書き換える（それ以外は 1 文字も変えない）。
 */
import { isSensitiveHeaderName, maskSecretValue } from '@/lib/curl'
import type { Diagnostic, NetworkLogEntry, StreamEvent } from '@/types'

const MASK = '••••'

/** これより短い値は、本文のあちこちに偶然現れるので「既知の値」としては置換しない。 */
const MIN_KNOWN_SECRET_LENGTH = 6

/** データ構造を辿る深さの上限。これを超える入れ子は中身を見ずに丸ごと伏せる。 */
const MAX_TREE_DEPTH = 64

/** キー名の正規化（小文字・英数字のみ）後に、含まれていれば秘匿とみなす語。 */
const SENSITIVE_PARTS = [
  'secret',
  'password',
  'passwd',
  'passphrase',
  'sessionid',
  'apikey',
  'credential',
  'privatekey',
  'accesskey',
  'authorization',
  'cookie',
]

/**
 * 末尾が一致すれば秘匿とみなす語。
 * token は max_tokens / totalTokens のような使用量の項目を巻き込まないよう、複数形（tokens）は含めない。
 */
const SENSITIVE_SUFFIXES = ['token', 'signature']

/** 名前全体が一致したときだけ秘匿とみなす語（`key=...` や `sig=...` など、短くて他と紛れやすいもの）。 */
const SENSITIVE_EXACT = new Set(['key', 'sig', 'pwd', 'auth', 'jwt', 'sid'])

/** 本文に「秘匿キーが含まれるかもしれない」ことを素早く確かめる粗いふるい。外れたら走査を省く。 */
const KEY_HINT_RE = /key|token|secret|pass|pwd|sig|auth|credential|cookie|jwt/i

/** クエリ名・JSON のキー・フォームのキー・ヘッダー名から、値が秘匿情報らしいかを判定する。 */
export function isSensitiveKey(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized === '') return false
  return (
    SENSITIVE_EXACT.has(normalized) ||
    SENSITIVE_PARTS.some((part) => normalized.includes(part)) ||
    SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  )
}

/**
 * 値を、ヘッダーと同じ規則（十分長いときだけ末尾 4 文字を残す。Bearer / Basic は種別を残す）で伏せる。
 * 規則の本体は lib/curl.ts にあり、このモジュールの利用者（テストなど）が従来どおり import できるよう再公開する。
 */
export { maskSecretValue }

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text.replaceAll('+', ' '))
  } catch {
    return text
  }
}

// ---------------------------------------------------------------------------
// 既知の値
// ---------------------------------------------------------------------------

/** 既知の秘匿値の集まり。replace で、任意の文字列に現れた同じ値を伏せる。 */
export interface SecretSet {
  replace: (text: string) => string
}

interface Needle {
  variants: string[]
  mask: string
}

/** 本文では JSON のエスケープ、URL では %XX 形式で現れうるので、その表記も探す。 */
function variantsOf(secret: string): string[] {
  const variants = new Set([secret])
  variants.add(JSON.stringify(secret).slice(1, -1))
  variants.add(encodeURIComponent(secret))
  return [...variants]
}

/** 空・短すぎる値を除き、長い値から順に置換できるようにまとめる（長い値が短い値に食われないように）。 */
export function createSecretSet(values: Iterable<string>): SecretSet {
  const unique = [...new Set(values)]
    .filter((value) => value.length >= MIN_KNOWN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  const needles: Needle[] = unique.map((secret) => ({
    variants: variantsOf(secret),
    mask: maskSecretValue(secret),
  }))
  return {
    replace(text) {
      let result = text
      for (const { variants, mask } of needles) {
        for (const variant of variants) {
          if (result.includes(variant)) result = result.split(variant).join(mask)
        }
      }
      return result
    },
  }
}

const AUTH_SCHEME_RE = /^(Bearer|Basic)\s+(\S.*)$/i
const SCHEME_ONLY_RE = /^(Bearer|Basic)$/i

/** 秘匿扱いのヘッダー値から、本文などに写りそうな部分（値そのもの・認証方式を除いたトークン・Cookie の値）を集める。 */
export function collectHeaderSecrets(headers: Record<string, string>): string[] {
  const secrets: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    // 秘匿扱いかは lib の名前判定に従う（インスペクタ・cURL が値を伏せるヘッダーと同じ）。空の値は伏せるものが無いので除く
    if (!isSensitiveHeaderName(name) || value === '') continue
    // 認証方式の名前だけの値（"Bearer" など）を既知の値にすると、本文中の同じ単語を潰してしまう
    if (SCHEME_ONLY_RE.test(value.trim())) continue
    secrets.push(value)
    const scheme = AUTH_SCHEME_RE.exec(value)
    if (scheme?.[2] !== undefined) secrets.push(scheme[2])
    if (/cookie/i.test(name)) {
      for (const pair of value.split(';')) {
        const eq = pair.indexOf('=')
        if (eq !== -1) secrets.push(pair.slice(eq + 1).trim())
      }
    }
  }
  return secrets
}

// ---------------------------------------------------------------------------
// URL・フォーム
// ---------------------------------------------------------------------------

/** `a=1&b=2` 形式（クエリ・フラグメント・フォーム本文）の、秘匿キーの値だけを伏せる。見つけた元の値は sink に足す。 */
function maskPairs(pairs: string, sink: string[]): string {
  return pairs
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq <= 0 || pair.length === eq + 1) return pair
      if (!isSensitiveKey(decodeSafe(pair.slice(0, eq)))) return pair
      const value = decodeSafe(pair.slice(eq + 1))
      sink.push(value)
      return `${pair.slice(0, eq)}=${maskSecretValue(value)}`
    })
    .join('&')
}

/**
 * URL の `user:pass@` のパスワードと、クエリ・フラグメントの秘匿キーの値を伏せる。
 * new URL で作り直さず文字列のまま扱うので、相対パスや壊れた URL でも、伏せた部分以外は元のまま。
 */
export function maskUrlSecrets(url: string, sink: string[] = []): string {
  let head = ''
  let rest = url
  const authority = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i.exec(url)
  if (authority !== null) {
    const [whole = '', scheme = '', netloc = ''] = authority
    const at = netloc.lastIndexOf('@')
    head = whole
    if (at !== -1) {
      const userinfo = netloc.slice(0, at)
      const colon = userinfo.indexOf(':')
      const secret = colon === -1 ? userinfo : userinfo.slice(colon + 1)
      if (secret !== '') {
        sink.push(decodeSafe(secret))
        const user = colon === -1 ? '' : `${userinfo.slice(0, colon)}:`
        head = `${scheme}${user}${MASK}${netloc.slice(at)}`
      }
    }
    rest = url.slice(whole.length)
  }

  const hashAt = rest.indexOf('#')
  const beforeHash = hashAt === -1 ? rest : rest.slice(0, hashAt)
  const queryAt = beforeHash.indexOf('?')
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)
  const query = queryAt === -1 ? '' : `?${maskPairs(beforeHash.slice(queryAt + 1), sink)}`
  const hash = hashAt === -1 ? '' : `#${maskPairs(rest.slice(hashAt + 1), sink)}`
  return `${head}${path}${query}${hash}`
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** text[start] の `"` から始まる文字列の、閉じ引用符の次の位置。閉じていなければ末尾。 */
function stringEnd(text: string, start: number): number {
  let from = start + 1
  for (;;) {
    const quote = text.indexOf('"', from)
    if (quote === -1) return text.length
    // 直前の連続する \ が奇数個なら、この " はエスケープされている
    let slashes = 0
    while (quote - 1 - slashes > start && text.charCodeAt(quote - 1 - slashes) === 92) slashes++
    if (slashes % 2 === 0) return quote + 1
    from = quote + 1
  }
}

function decodeJsonString(token: string): string {
  const inner = token.endsWith('"') && token.length >= 2 ? token.slice(1, -1) : token.slice(1)
  if (!inner.includes('\\')) return inner
  try {
    return String(JSON.parse(token))
  } catch {
    return inner
  }
}

interface Frame {
  object: boolean
  /** 親のキーが秘匿で、中身の値をすべて伏せるか */
  inherit: boolean
  key: string | undefined
  expectKey: boolean
}

const LITERAL_STOP = new Set([',', ':', '[', ']', '{', '}', '"', ' ', '\t', '\n', '\r'])

/**
 * JSON テキストのうち、秘匿キー（isSensitiveKey）の値だけを伏せる。値の外側は 1 文字も変えない。
 * 壊れた JSON や途中で切れた JSON でも例外を投げず、読めた範囲で処理する。
 * 秘匿キーの値がオブジェクト・配列なら、その中の値はキーによらずすべて伏せる。
 */
export function maskJsonSecrets(text: string, sink: string[] = []): string {
  const stack: Frame[] = []
  let out = ''
  let cursor = 0
  const replace = (start: number, end: number, replacement: string) => {
    out += text.slice(cursor, start) + replacement
    cursor = end
  }
  const valueIsSensitive = (): boolean => {
    const top = stack[stack.length - 1]
    if (top === undefined) return false
    return top.inherit || (top.object && top.key !== undefined && isSensitiveKey(top.key))
  }

  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    const top = stack[stack.length - 1]
    if (ch === '"') {
      const end = stringEnd(text, i)
      const token = text.slice(i, end)
      if (top?.object === true && top.expectKey) {
        top.key = decodeJsonString(token)
      } else if (valueIsSensitive()) {
        const value = decodeJsonString(token)
        if (value !== '') {
          sink.push(value)
          replace(i, end, JSON.stringify(maskSecretValue(value)))
        }
      }
      i = end
    } else if (ch === '{' || ch === '[') {
      stack.push({
        object: ch === '{',
        inherit: valueIsSensitive(),
        key: undefined,
        expectKey: true,
      })
      i++
    } else if (ch === '}' || ch === ']') {
      stack.pop()
      i++
    } else if (ch === ',') {
      if (top !== undefined) {
        top.key = undefined
        top.expectKey = true
      }
      i++
    } else if (ch === ':') {
      if (top !== undefined) top.expectKey = false
      i++
    } else if (LITERAL_STOP.has(ch)) {
      i++
    } else {
      // 数値・true / false / null
      let end = i + 1
      while (end < text.length && !LITERAL_STOP.has(text.charAt(end))) end++
      const literal = text.slice(i, end)
      if (valueIsSensitive() && literal !== 'true' && literal !== 'false' && literal !== 'null') {
        sink.push(literal)
        replace(i, end, JSON.stringify(MASK))
      }
      i = end
    }
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

/** parse 済みの値（イベントの data など）を、元を書き換えずに辿り、秘匿キーの値と既知の値を伏せた複製を返す。 */
export function maskValueTree(
  value: unknown,
  secrets: SecretSet,
  inherit = false,
  depth = 0,
): unknown {
  if (typeof value === 'string') return inherit ? maskSecretValue(value) : secrets.replace(value)
  if (typeof value === 'number') return inherit ? MASK : value
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_TREE_DEPTH) return MASK
  if (Array.isArray(value)) {
    return value.map((item: unknown) => maskValueTree(item, secrets, inherit, depth + 1))
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      maskValueTree(item, secrets, inherit || isSensitiveKey(key), depth + 1),
    ]),
  )
}

// ---------------------------------------------------------------------------
// リクエスト・レスポンス
// ---------------------------------------------------------------------------

function firstNonSpace(text: string): string {
  return /\S/.exec(text)?.[0] ?? ''
}

/** 1 行・空白なしの `k=v&k2=v2`（application/x-www-form-urlencoded）らしい本文か。 */
const FORM_BODY_RE = /^[^\s=&]+=\S*$/

export interface RequestMask {
  /** 宛先 URL */
  url: string
  /** リクエスト本文（無ければ undefined） */
  body: string | undefined
  /** 設定中のトークン・URL や本文で見つけた秘匿値。レスポンスなど他の場所の置換に使う */
  secrets: SecretSet
}

/**
 * リクエストの URL と本文を伏せ、そこから分かった秘匿値（ヘッダーの認証情報・URL や本文の秘匿キーの値）を
 * 既知の値にまとめる。本文が JSON ならキー名で、フォーム形式ならキー名で、それ以外は既知の値の置換だけで伏せる。
 */
export function maskRequest(
  entry: Pick<NetworkLogEntry, 'targetUrl' | 'requestHeaders' | 'requestBody'>,
): RequestMask {
  const found = collectHeaderSecrets(entry.requestHeaders)
  const url = maskUrlSecrets(entry.targetUrl, found)
  const { requestBody } = entry
  let body: string | undefined
  if (requestBody !== undefined) {
    const head = firstNonSpace(requestBody)
    if (head === '{' || head === '[') body = maskJsonSecrets(requestBody, found)
    else if (FORM_BODY_RE.test(requestBody)) body = maskPairs(requestBody, found)
    else body = requestBody
  }
  const secrets = createSecretSet(found)
  return {
    url: secrets.replace(url),
    body: body === undefined ? undefined : secrets.replace(body),
    secrets,
  }
}

/** 一覧のように本文まで見ない場面で、URL だけを伏せる。 */
export function maskUrlForDisplay(url: string, requestHeaders: Record<string, string>): string {
  return createSecretSet(collectHeaderSecrets(requestHeaders)).replace(maskUrlSecrets(url))
}

/** `data: {...}` の行（SSE）の JSON だけを対象にする。 */
const SSE_JSON_LINE_RE = /^(data:[ \t]?)([[{][^\r\n]*)/gm

/**
 * レスポンス本文を伏せる。JSON ならキー名で、SSE なら `data:` 行の JSON ごとにキー名で、
 * そのうえでどの形式でも既知の値を置換する。
 */
export function maskResponseText(text: string, secrets: SecretSet): string {
  let result = text
  if (KEY_HINT_RE.test(text)) {
    const head = firstNonSpace(text)
    if (head === '{' || head === '[') {
      result = maskJsonSecrets(text)
    } else {
      result = text.replace(SSE_JSON_LINE_RE, (_line, prefix: string, payload: string) =>
        KEY_HINT_RE.test(payload) ? `${prefix}${maskJsonSecrets(payload)}` : `${prefix}${payload}`,
      )
    }
  }
  return secrets.replace(result)
}

/** ストリームイベント 1 件を伏せた複製を返す。 */
export function maskStreamEvent(event: StreamEvent, secrets: SecretSet): StreamEvent {
  return {
    ...event,
    raw: maskResponseText(event.raw, secrets),
    ...(event.data !== undefined ? { data: maskValueTree(event.data, secrets) } : {}),
    ...(event.parseError !== undefined ? { parseError: secrets.replace(event.parseError) } : {}),
    // スキーマ不一致の理由には、不一致だったフィールドの実際の値が入りうる
    ...(event.schemaError !== undefined ? { schemaError: secrets.replace(event.schemaError) } : {}),
  }
}

/**
 * ヘッダーの値に現れた既知の秘匿値だけを伏せた複製を返す（名前による判定はしない）。
 * ヘッダー名に基づく伏せ方は entry-utils の displayHeaders / displayResponseHeaders が担う。
 */
export function replaceSecretsInHeaders(
  headers: Record<string, string>,
  secrets: SecretSet,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, secrets.replace(value)]),
  )
}

/** 診断の見出し・詳細に紛れた秘匿値（転送先 URL を引用した文など）を伏せた複製を返す。 */
export function maskDiagnostic(diagnostic: Diagnostic, secrets: SecretSet): Diagnostic {
  return {
    ...diagnostic,
    title: secrets.replace(diagnostic.title),
    ...(diagnostic.detail !== undefined ? { detail: secrets.replace(diagnostic.detail) } : {}),
  }
}

/** 通信エラーの文言（fetch のエラーは URL を含みうる）を伏せた複製を返す。 */
export function maskEntryError(
  error: NonNullable<NetworkLogEntry['error']>,
  secrets: SecretSet,
): NonNullable<NetworkLogEntry['error']> {
  return {
    ...error,
    message: secrets.replace(error.message),
    ...(error.hint !== undefined ? { hint: secrets.replace(error.hint) } : {}),
  }
}
