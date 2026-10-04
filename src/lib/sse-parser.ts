/**
 * インクリメンタルな Server-Sent Events パーサー（WHATWG HTML Standard 9.2 準拠）。
 * チャンクの切れ目は任意でよく、改行は \n / \r\n / \r のどれでも扱える。
 * 行の切り出しは AI SDK が使う eventsource-parser に合わせてあり、未処理の末尾は「改行を含むチャンクが
 * 次に来たとき」にまとめて処理する。入力の最後の裸の \r も、\r\n の前半かもしれないので改行とは見なさない。
 * 以下の 3 点だけは意図して仕様から外している。
 * - end() は、空行の無い未完了の行 / イベントも（データがあれば）発火する。仕様は破棄で、
 *   AI SDK のクライアントも受け取らない。切断された通信の最後のイベントをデバッグ画面から失わないために
 *   発火するが、`incomplete: true` を付けて「SDK には届いていない」と区別できるようにする。
 * - コメント行は読み捨てずに 'comment' として通知する（": ping" などの確認用）。
 * - 1 行・1 イベントが保持する文字数に上限を設ける（maxChars）。改行の無い巨大な行や、空行の来ない
 *   data 行の連続でタブのメモリを使い切らないため。超えた分は捨て、`truncated: true` を付ける。
 */
export type SseItem =
  | {
      kind: 'message'
      event?: string
      data: string
      id?: string
      /** 最後が空行で終わっておらず、end() で救済したイベント */
      incomplete?: true
      /** maxChars を超えたので data は途中までしか入っていない */
      truncated?: true
    }
  | { kind: 'comment'; text: string; truncated?: true }

export interface SseParser {
  /** デコード済みのテキストを渡す。 */
  push(text: string): void
  /** ストリームの終端を通知する。以降の push / end は無視する。 */
  end(): void
}

export interface SseParserOptions {
  /** 1 行が保持する文字数と、1 イベントの data が保持する合計文字数の上限。既定 DEFAULT_SSE_MAX_CHARS */
  maxChars?: number
}

/**
 * 既定の上限。画像などを base64 で 1 イベントに載せる実用的なサイズ（数 MB）は解析できる大きさにしつつ、
 * 無限に続く行でメモリが際限なく増えることだけを防ぐ。
 */
export const DEFAULT_SSE_MAX_CHARS = 16_000_000

const BOM = 0xfeff

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function hasLineBreak(text: string): boolean {
  return text.includes('\n') || text.includes('\r')
}

export function createSseParser(
  onItem: (item: SseItem) => void,
  opts: SseParserOptions = {},
): SseParser {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_SSE_MAX_CHARS))

  /** まだ処理していない末尾（改行を含むチャンクが来るまでためる。maxChars まで） */
  let tail = ''
  /** tail が maxChars を超え、以降の文字を捨てている（最初の行が途中までしか無い） */
  let tailOverflow = false
  /** 先頭 BOM の判定を済ませたか（push ごとではなくストリームの先頭だけが対象） */
  let started = false
  let ended = false
  /** end() の中か。ここで発火するイベントは空行で終わっていない */
  let flushing = false

  let dataLines: string[] = []
  /** 現在のイベントが保持している data の合計文字数 */
  let dataChars = 0
  let dataTruncated = false
  let eventName = ''
  /** 仕様どおりイベントをまたいで保持する（id: が来たときだけ更新） */
  let lastEventId = ''

  /** 上限で切るとき、代用対の途中では切らない。 */
  function clip(text: string, limit: number): string {
    if (text.length <= limit) return text
    const cut = limit > 0 && isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit
    return text.slice(0, cut)
  }

  function dispatch(): void {
    // data 行がひとつも無いイベントは発火しない。`data:`（値が空）は 1 行として数えるので data '' で発火する
    if (dataLines.length > 0) {
      onItem({
        kind: 'message',
        data: dataLines.join('\n'),
        ...(eventName !== '' ? { event: eventName } : {}),
        ...(lastEventId !== '' ? { id: lastEventId } : {}),
        ...(flushing ? { incomplete: true as const } : {}),
        ...(dataTruncated ? { truncated: true as const } : {}),
      })
    }
    dataLines = []
    dataChars = 0
    dataTruncated = false
    eventName = ''
  }

  function addDataLine(value: string, lineTruncated: boolean): void {
    if (lineTruncated) dataTruncated = true
    // data 行どうしは \n でつながるので、その 1 文字ぶんも数える
    const separator = dataLines.length > 0 ? 1 : 0
    const room = maxChars - dataChars - separator
    if (room <= 0) {
      dataTruncated = true
      return
    }
    const kept = clip(value, room)
    if (kept.length < value.length) dataTruncated = true
    dataLines.push(kept)
    dataChars += kept.length + separator
  }

  function processLine(raw: string, alreadyTruncated: boolean): void {
    let text = raw
    let truncated = alreadyTruncated
    if (text.length > maxChars) {
      text = clip(text, maxChars)
      truncated = true
    }
    if (text === '') {
      dispatch()
      return
    }
    if (text.charCodeAt(0) === 0x3a /* ':' */) {
      onItem({
        kind: 'comment',
        text: text.startsWith(': ') ? text.slice(2) : text.slice(1),
        ...(truncated ? { truncated: true as const } : {}),
      })
      return
    }
    const colon = text.indexOf(':')
    const field = colon === -1 ? text : text.slice(0, colon)
    let value = colon === -1 ? '' : text.slice(colon + 1)
    // 値の先頭の空白は 1 つだけ取り除く
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'event':
        eventName = value
        break
      case 'data':
        addDataLine(value, truncated)
        break
      case 'id':
        // NUL を含む id は無視する（仕様）
        if (!value.includes('\0')) lastEventId = value
        break
      // retry と未知のフィールドは仕様どおり無視する
    }
  }

  /**
   * 改行で区切られた行を順に処理する。
   * final でなければ、処理できなかった末尾（最後の \r・改行の無い行）を tail に残す。
   * final（end()）なら、末尾の \r も行の終わりとして扱い、改行の無い最後の行も処理する。
   */
  function processInput(input: string, firstLineTruncated: boolean, final: boolean): void {
    let start = 0
    let first = true
    for (;;) {
      let end = -1
      for (let i = start; i < input.length; i++) {
        const c = input.charCodeAt(i)
        if (c === 0x0a || c === 0x0d) {
          end = i
          break
        }
      }
      if (end === -1) break
      const isCr = input.charCodeAt(end) === 0x0d
      // 入力の最後の \r は、直後の \n で \r\n 1 つの改行になるかもしれないので、次の入力まで処理しない
      if (isCr && end === input.length - 1 && !final) break
      processLine(input.slice(start, end), first && firstLineTruncated)
      first = false
      start = end + 1
      if (isCr && input.charCodeAt(start) === 0x0a) start++
    }
    const rest = input.slice(start)
    if (final) {
      if (rest !== '') processLine(rest, first && firstLineTruncated)
      return
    }
    tail = rest
    tailOverflow = false
    if (tail.length > maxChars) {
      tail = clip(tail, maxChars)
      tailOverflow = true
    }
  }

  return {
    push(text) {
      if (ended || text === '') return
      let chunk = text
      if (!started) {
        started = true
        if (chunk.charCodeAt(0) === BOM) chunk = chunk.slice(1)
      }
      if (chunk === '') return

      if (!hasLineBreak(chunk)) {
        // 改行が無ければ行は完成しない。上限までためて、超えた分は捨てる
        if (tailOverflow) return
        if (tail.length + chunk.length > maxChars) {
          tail = clip(tail + chunk.slice(0, maxChars - tail.length), maxChars)
          tailOverflow = true
        } else {
          tail += chunk
        }
        return
      }
      const input = tail + chunk
      const truncated = tailOverflow
      tail = ''
      tailOverflow = false
      processInput(input, truncated, false)
    },

    end() {
      if (ended) return
      ended = true
      flushing = true
      // 保留中の末尾（最後の \r・未完了の行）と、空行の無いイベントも発火する
      const rest = tail
      const truncated = tailOverflow
      tail = ''
      tailOverflow = false
      processInput(rest, truncated, true)
      dispatch()
    },
  }
}
