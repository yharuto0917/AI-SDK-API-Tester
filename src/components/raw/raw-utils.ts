import type { RawMethod } from '@/types'

export const RAW_METHODS: readonly RawMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

export function isRawMethod(value: string): value is RawMethod {
  return (RAW_METHODS as readonly string[]).includes(value)
}

/** 画面に保持するレスポンスボディの最大文字数。超えた分は表示から切り捨てる（受信は最後まで続ける）。 */
export const MAX_BODY_CHARS = 1_000_000

export type JsonState = { kind: 'empty' } | { kind: 'valid' } | { kind: 'invalid'; message: string }

/** 文字列が JSON として有効かを調べる。空白だけの文字列は「空」として区別する。 */
export function inspectJson(text: string): JsonState {
  if (text.trim() === '') return { kind: 'empty' }
  try {
    JSON.parse(text)
    return { kind: 'valid' }
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) }
  }
}

function isJsonWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

const LITERAL_END = new Set([',', ':', '[', ']', '{', '}', '"'])

/**
 * JSON を字下げして整形する。無効な JSON なら null。
 * JSON.stringify(JSON.parse(x)) では大きな整数の桁落ちや重複キーの脱落が起きるため、
 * 値には触れずに空白だけを組み替える（文字列のエスケープも数値の表記もそのまま残る）。
 */
export function prettyPrintJson(text: string, indent = 2): string | null {
  if (inspectJson(text).kind !== 'valid') return null

  let out = ''
  let depth = 0
  let i = 0
  const lineBreak = () => `\n${' '.repeat(depth * indent)}`

  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === '"') {
      // 文字列は閉じる引用符までそのまま写す（\" などのエスケープを読み飛ばす）
      let j = i + 1
      while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']'
      let k = i + 1
      while (isJsonWhitespace(text[k])) k++
      if (text[k] === close) {
        // 空のオブジェクト・配列は 1 行のまま
        out += ch + close
        i = k + 1
      } else {
        depth++
        out += ch + lineBreak()
        i++
      }
    } else if (ch === '}' || ch === ']') {
      depth--
      out += lineBreak() + ch
      i++
    } else if (ch === ',') {
      out += `,${lineBreak()}`
      i++
    } else if (ch === ':') {
      out += ': '
      i++
    } else if (isJsonWhitespace(ch)) {
      i++
    } else {
      // 数値・true / false / null
      let j = i
      while (j < text.length && !LITERAL_END.has(text.charAt(j)) && !isJsonWhitespace(text[j])) j++
      out += text.slice(i, j)
      i = j
    }
  }
  return out
}

export interface LimitedAppend {
  text: string
  truncated: boolean
}

/** current に chunk を足す。合計が max 文字を超える分は切り捨て、切り捨てたら truncated を立てる。 */
export function appendLimited(
  current: string,
  chunk: string,
  max: number = MAX_BODY_CHARS,
): LimitedAppend {
  const room = max - current.length
  if (chunk.length <= room) return { text: current + chunk, truncated: false }
  let cut = Math.max(0, room)
  // サロゲートペアの途中で切って文字化けさせない
  const last = chunk.charCodeAt(cut - 1)
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut--
  return { text: current + chunk.slice(0, cut), truncated: true }
}

export type StatusTone =
  'info' | 'success' | 'redirect' | 'client-error' | 'server-error' | 'unknown'

export function statusTone(status: number | undefined): StatusTone {
  if (status === undefined || !Number.isInteger(status)) return 'unknown'
  if (status >= 100 && status < 200) return 'info'
  if (status >= 200 && status < 300) return 'success'
  if (status >= 300 && status < 400) return 'redirect'
  if (status >= 400 && status < 500) return 'client-error'
  if (status >= 500 && status < 600) return 'server-error'
  return 'unknown'
}

const BINARY_PREFIXES = ['image/', 'audio/', 'video/', 'font/']
const BINARY_TYPES = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/wasm',
  'application/protobuf',
  'application/x-protobuf',
])

/** Content-Type から、UTF-8 として読むと文字化けしそうなバイナリかを推定する。 */
export function isLikelyBinaryContentType(contentType: string | null | undefined): boolean {
  if (contentType === null || contentType === undefined) return false
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  // SVG は画像だがテキストとして読める
  if (mime === 'image/svg+xml') return false
  return BINARY_PREFIXES.some((prefix) => mime.startsWith(prefix)) || BINARY_TYPES.has(mime)
}
