import { PROXY_NAME } from '@/lib/proxy'

/**
 * ブラウザの fetch が JavaScript からは設定させず、指定しても黙って捨てるリクエストヘッダー。
 * 出典: Fetch Standard の「forbidden request-header」。捨てられたことは fetch から分からないので、
 * 送信前にこちらで取り除き、「送ったつもり」の表示（インスペクタ・cURL）と実際の通信を食い違わせない。
 */

/** 名前だけで禁止されるヘッダー（小文字）。 */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
])

/** 接頭辞で禁止されるヘッダー（小文字）。 */
const FORBIDDEN_PREFIXES = ['proxy-', 'sec-']

/** 値が CONNECT / TRACE / TRACK のときだけ禁止されるメソッド上書きヘッダー（小文字）。 */
const METHOD_OVERRIDE_NAMES: ReadonlySet<string> = new Set([
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
])
const FORBIDDEN_OVERRIDE_METHODS: ReadonlySet<string> = new Set(['connect', 'trace', 'track'])

/** ブラウザの fetch に捨てられるヘッダーか。メソッド上書きヘッダーだけは値も見る。 */
export function isForbiddenRequestHeader(name: string, value?: string): boolean {
  const lower = name.trim().toLowerCase()
  if (FORBIDDEN_NAMES.has(lower)) return true
  if (FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  if (METHOD_OVERRIDE_NAMES.has(lower) && value !== undefined) {
    return value
      .split(',')
      .some((method) => FORBIDDEN_OVERRIDE_METHODS.has(method.trim().toLowerCase()))
  }
  return false
}

/** 設定画面の入力時やログの注記に使う、送れない理由と代替手段（送れるヘッダーなら null）。 */
export function forbiddenHeaderHint(name: string, value?: string): string | null {
  if (!isForbiddenRequestHeader(name, value)) return null
  const lower = name.trim().toLowerCase()
  if (lower === 'cookie' || lower === 'cookie2') {
    return `Cookie はブラウザの仕様で JavaScript から送れません。ブラウザに保存済みの対象サイトの Cookie を送るには、設定の credentials を include にしてください（任意の値の Cookie は送れません。${PROXY_NAME}経由でも送れません）。`
  }
  return `「${name.trim()}」はブラウザの仕様で JavaScript から設定できず、指定しても送信されません（${PROXY_NAME}経由でも同じです）。`
}
