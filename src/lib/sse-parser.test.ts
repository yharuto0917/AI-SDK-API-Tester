import { describe, expect, it } from 'vitest'
import { createSseParser } from '@/lib/sse-parser'
import type { SseItem } from '@/lib/sse-parser'

/** チャンク列を順に push し、最後に end() するかを選べる。 */
function parse(chunks: string[], opts: { end?: boolean } = {}): SseItem[] {
  const items: SseItem[] = []
  const parser = createSseParser((item) => items.push(item))
  for (const chunk of chunks) parser.push(chunk)
  if (opts.end ?? true) parser.end()
  return items
}

const msg = (
  data: string,
  extra: { event?: string; id?: string; incomplete?: true; truncated?: true } = {},
): SseItem => ({
  kind: 'message',
  data,
  ...extra,
})

/** end() で救済された（空行で終わっていない）イベント。AI SDK は受け取らない。 */
const unterminated = (data: string, extra: { event?: string; id?: string } = {}): SseItem =>
  msg(data, { ...extra, incomplete: true })

describe('createSseParser: 基本', () => {
  it('data 行 + 空行で 1 イベント', () => {
    expect(parse(['data: hello\n\n'])).toEqual([msg('hello')])
  })

  it('空行が来るまでは発火しない', () => {
    expect(parse(['data: hello\n'], { end: false })).toEqual([])
    expect(parse(['data: hello\n\n'], { end: false })).toEqual([msg('hello')])
  })

  it('連続するイベントを順に発火する', () => {
    expect(parse(['data: a\n\ndata: b\n\ndata: c\n\n'])).toEqual([msg('a'), msg('b'), msg('c')])
  })

  it('AI SDK の UI Message Stream 形式（JSON + [DONE]）', () => {
    const wire =
      'data: {"type":"start","messageId":"m1"}\n\n' +
      'data: {"type":"text-delta","id":"t","delta":"hi"}\n\n' +
      'data: [DONE]\n\n'
    expect(parse([wire])).toEqual([
      msg('{"type":"start","messageId":"m1"}'),
      msg('{"type":"text-delta","id":"t","delta":"hi"}'),
      msg('[DONE]'),
    ])
  })

  it('値の先頭の空白は 1 つだけ取り除く', () => {
    expect(parse(['data:x\n\n'])).toEqual([msg('x')])
    expect(parse(['data: x\n\n'])).toEqual([msg('x')])
    expect(parse(['data:  x\n\n'])).toEqual([msg(' x')])
  })

  it('値に ":" を含んでいても最初の ":" だけで分割する', () => {
    expect(parse(['data: {"a":"b:c"}\n\n'])).toEqual([msg('{"a":"b:c"}')])
  })

  it('コロンの無い行はフィールド名のみ（値は空）として扱う', () => {
    // "data" だけの行は data: と同じ（空の data 行が 1 つ）
    expect(parse(['data\n\n'])).toEqual([msg('')])
  })
})

describe('createSseParser: 複数 data 行', () => {
  it('data 行は \\n で連結する', () => {
    expect(parse(['data: line1\ndata: line2\ndata: line3\n\n'])).toEqual([
      msg('line1\nline2\nline3'),
    ])
  })

  it('空の data 行も 1 行として連結する', () => {
    expect(parse(['data: a\ndata:\ndata: b\n\n'])).toEqual([msg('a\n\nb')])
    expect(parse(['data:\ndata:\n\n'])).toEqual([msg('\n')])
  })
})

describe('createSseParser: 空 data', () => {
  it('data 行がひとつも無いブロックは発火しない', () => {
    expect(parse(['event: ping\n\n'])).toEqual([])
    expect(parse(['id: 1\n\n'])).toEqual([])
    expect(parse(['retry: 1000\n\n'])).toEqual([])
  })

  it('空行だけの連続は何も発火しない', () => {
    expect(parse(['\n\n\n'])).toEqual([])
  })

  it('値が空の data 行は 1 行として数えるので data "" で発火する（eventsource-parser と同じ）', () => {
    expect(parse(['data:\n\n'])).toEqual([msg('')])
  })

  it('発火しなかったブロックの event 名は次のイベントに持ち越さない', () => {
    expect(parse(['event: ignored\n\ndata: x\n\n'])).toEqual([msg('x')])
  })
})

describe('createSseParser: 改行コード', () => {
  it('CRLF', () => {
    expect(parse(['data: a\r\n\r\ndata: b\r\n\r\n'])).toEqual([msg('a'), msg('b')])
  })

  it('CR のみ', () => {
    // 続きの入力が来て初めて、最後の \r も改行として確定する
    expect(parse(['data: a\r\rdata: b\r\r', 'event: z\n'])).toEqual([msg('a'), msg('b')])
  })

  it('LF / CRLF / CR が混在していても 1 行ずつ数える', () => {
    expect(parse(['data: a\r\ndata: b\ndata: c\r\r\n'])).toEqual([msg('a\nb\nc')])
  })

  it('CRLF の CR と LF の間でチャンクが割れても 1 つの改行として扱う', () => {
    expect(parse(['data: a\r', '\n\r', '\n'])).toEqual([msg('a')])
    // 空行（\r\n）が割れた場合も、余計な空行として二重にイベントを切らない
    expect(parse(['data: a\r\n\r', '\ndata: b\r\n\r\n'])).toEqual([msg('a'), msg('b')])
  })

  it('チャンク末尾の \\r の次が \\n 以外なら、\\r 単独の改行として扱う', () => {
    // b は最後の \r が入力の末尾なので、空行の区切りが SDK に届いていない
    expect(parse(['data: a\r', '\rdata: b\r', '\r'])).toEqual([msg('a'), unterminated('b')])
    expect(parse(['data: a\r', '\rdata: b\r', '\rdata: c\n\n'])).toEqual([
      msg('a'),
      msg('b'),
      msg('c'),
    ])
  })

  it('チャンク末尾の \\r は、次の入力が来るまで行を確定しない（SDK と同じ）', () => {
    expect(parse(['data: a\r\r'], { end: false })).toEqual([])
    expect(parse(['data: a\r\r', 'event: z\n'], { end: false })).toEqual([msg('a')])
  })
})

describe('createSseParser: チャンク境界', () => {
  const wire =
    '﻿: ping\r\n' +
    'event: custom\n' +
    'id: 42\n' +
    'data: {"type":"text-delta","delta":"こんにちは"}\n' +
    'data: second\r' +
    '\r' +
    'data: [DONE]\n\n'

  it('どこで分割しても一括 push と同じ結果になる（2 分割の全位置）', () => {
    const expected = parse([wire])
    expect(expected.length).toBeGreaterThan(0)
    for (let i = 0; i <= wire.length; i++) {
      expect(parse([wire.slice(0, i), wire.slice(i)])).toEqual(expected)
    }
  })

  it('1 文字ずつ push しても一括 push と同じ結果になる', () => {
    expect(parse([...wire])).toEqual(parse([wire]))
  })

  it('3 分割の全位置でも同じ結果になる', () => {
    const expected = parse([wire])
    for (let i = 0; i <= wire.length; i += 3) {
      for (let j = i; j <= wire.length; j += 5) {
        expect(parse([wire.slice(0, i), wire.slice(i, j), wire.slice(j)])).toEqual(expected)
      }
    }
  })

  it('フィールド名の途中・値の途中で割れても連結される', () => {
    expect(parse(['da', 'ta: hel', 'lo\n', '\n'])).toEqual([msg('hello')])
  })

  it('空文字の push は何もしない', () => {
    expect(parse(['', 'data: a\n\n', ''])).toEqual([msg('a')])
  })
})

describe('createSseParser: コメント', () => {
  it("':' 始まりの行はコメントとして通知する（先頭の空白 1 つは除く）", () => {
    expect(parse([': ping\n\n'])).toEqual([{ kind: 'comment', text: 'ping' }])
    expect(parse([':ping\n\n'])).toEqual([{ kind: 'comment', text: 'ping' }])
    expect(parse([':  two\n\n'])).toEqual([{ kind: 'comment', text: ' two' }])
    expect(parse([':\n\n'])).toEqual([{ kind: 'comment', text: '' }])
  })

  it('コメントはイベントの区切りにならず、データも壊さない', () => {
    expect(parse(['data: a\n: keep-alive\ndata: b\n\n'])).toEqual([
      { kind: 'comment', text: 'keep-alive' },
      msg('a\nb'),
    ])
  })

  it('コメント行のみのストリーム', () => {
    expect(parse([': a\n', ': b\n'])).toEqual([
      { kind: 'comment', text: 'a' },
      { kind: 'comment', text: 'b' },
    ])
  })
})

describe('createSseParser: BOM', () => {
  it('ストリーム先頭の BOM を取り除く', () => {
    expect(parse(['﻿data: a\n\n'])).toEqual([msg('a')])
  })

  it('BOM だけの最初の push のあとに続きが来ても正しく動く', () => {
    expect(parse(['﻿', 'data: a\n\n'])).toEqual([msg('a')])
  })

  it('最初の push が空文字でも、次の push の先頭 BOM を取り除く', () => {
    expect(parse(['', '﻿data: a\n\n'])).toEqual([msg('a')])
  })

  it('2 回目以降の push 先頭の BOM は取り除かない（ストリーム先頭だけが対象）', () => {
    // BOM はフィールド名の一部になり、未知のフィールドとして無視される
    expect(parse(['data: a\n\n', '﻿data: b\n\n'])).toEqual([msg('a')])
  })

  it('先頭以外の BOM は取り除かない', () => {
    expect(parse(['data: ﻿a\n\n'])).toEqual([msg('﻿a')])
  })
})

describe('createSseParser: event / id / retry', () => {
  it('event 名を付ける', () => {
    expect(parse(['event: update\ndata: x\n\n'])).toEqual([msg('x', { event: 'update' })])
  })

  it('event 名は次のイベントに持ち越さない', () => {
    expect(parse(['event: a\ndata: 1\n\ndata: 2\n\n'])).toEqual([
      msg('1', { event: 'a' }),
      msg('2'),
    ])
  })

  it('event の値が空なら event は付かない', () => {
    expect(parse(['event:\ndata: x\n\n'])).toEqual([msg('x')])
  })

  it('同じブロックに event が複数あれば最後のものを使う', () => {
    expect(parse(['event: a\nevent: b\ndata: x\n\n'])).toEqual([msg('x', { event: 'b' })])
  })

  it('id を付ける', () => {
    expect(parse(['id: 7\ndata: x\n\n'])).toEqual([msg('x', { id: '7' })])
  })

  it('id は仕様どおり後続のイベントにも保持される', () => {
    expect(parse(['id: 7\ndata: a\n\ndata: b\n\nid: 8\ndata: c\n\n'])).toEqual([
      msg('a', { id: '7' }),
      msg('b', { id: '7' }),
      msg('c', { id: '8' }),
    ])
  })

  it('値が空の id: は保持している id を消す', () => {
    expect(parse(['id: 7\ndata: a\n\nid:\ndata: b\n\n'])).toEqual([msg('a', { id: '7' }), msg('b')])
  })

  it('NUL を含む id は無視する（直前の id を保つ）', () => {
    expect(parse(['id: 1\ndata: a\n\nid: 2\0x\ndata: b\n\n'])).toEqual([
      msg('a', { id: '1' }),
      msg('b', { id: '1' }),
    ])
  })

  it('data の無いブロックの id も保持される（仕様の last event ID buffer）', () => {
    expect(parse(['id: 5\n\ndata: x\n\n'])).toEqual([msg('x', { id: '5' })])
  })

  it('retry と未知のフィールドは無視する', () => {
    expect(parse(['retry: 3000\nfoo: bar\ndata: x\n\n'])).toEqual([msg('x')])
  })

  it('フィールド名は大文字小文字を区別する（"Data:" は未知のフィールド）', () => {
    expect(parse(['Data: x\n\n'])).toEqual([])
  })
})

describe('createSseParser: end()', () => {
  it('末尾の空行が無くても、データがあれば発火する（SDK は受け取らないので incomplete）', () => {
    expect(parse(['data: a\n'])).toEqual([unterminated('a')])
  })

  it('改行すら無い最後の行も処理して発火する', () => {
    expect(parse(['data: tail'])).toEqual([unterminated('tail')])
    expect(parse(['data: a\n\ndata: tail'])).toEqual([msg('a'), unterminated('tail')])
  })

  it('空行で終わったイベントは、end() があっても incomplete にならない', () => {
    expect(parse(['data: a\n\n'])).toEqual([msg('a')])
    expect(parse(['data: a\r\n\r\n'])).toEqual([msg('a')])
    expect(parse(['data: a\r\rdata: b\r\r\n'])).toEqual([msg('a'), msg('b')])
  })

  it('途中で切れた JSON もそのまま data として発火する（解析側で検出できる）', () => {
    expect(parse(['data: {"type":"text-de'])).toEqual([unterminated('{"type":"text-de')])
  })

  it('event / id も未完了のイベントに付く', () => {
    expect(parse(['event: x\nid: 3\ndata: a'])).toEqual([
      unterminated('a', { event: 'x', id: '3' }),
    ])
  })

  it('データが無ければ何も発火しない', () => {
    expect(parse(['event: x\n'])).toEqual([])
    expect(parse([''])).toEqual([])
    expect(parse([])).toEqual([])
    expect(parse(['\n\n'])).toEqual([])
  })

  it('未完了のコメント行も通知する', () => {
    expect(parse([': tail'])).toEqual([{ kind: 'comment', text: 'tail' }])
  })

  it('入力の最後の裸の \\r は改行と見なさない（\\r\\n の前半かもしれない。SDK も同じ）', () => {
    expect(parse(['data: a\r'])).toEqual([unterminated('a')])
    // 空行の代わりの最後の \r も、イベントの区切りとしては処理されない
    expect(parse(['data: a\r\r'])).toEqual([unterminated('a')])
    // 続きが来れば改行と確定する
    expect(parse(['data: a\r', '\n\r\n'])).toEqual([msg('a')])
    expect(parse(['data: a\r', '\r', 'data: b\n\n'])).toEqual([msg('a'), msg('b')])
  })

  it('改行の無いチャンクが続くあいだは、保留した \\r の行も処理しない（SDK と同じ）', () => {
    // SDK は最後の \r のあと、改行を含むチャンクが来るまで何も処理しない
    expect(parse(['data:a\n', '\r', 'data:', '{}'])).toEqual([
      unterminated('a'),
      unterminated('{}'),
    ])
    expect(parse(['data:a\n', '\r', 'data:{}\n\n'])).toEqual([msg('a'), msg('{}')])
  })

  it('end() は 2 回呼んでも二重に発火しない', () => {
    const items: SseItem[] = []
    const parser = createSseParser((item) => items.push(item))
    parser.push('data: a')
    parser.end()
    parser.end()
    expect(items).toEqual([unterminated('a')])
  })

  it('end() のあとの push / end は無視する', () => {
    const items: SseItem[] = []
    const parser = createSseParser((item) => items.push(item))
    parser.push('data: a\n\n')
    parser.end()
    parser.push('data: b\n\n')
    parser.end()
    expect(items).toEqual([msg('a')])
  })
})

describe('createSseParser: 上限（maxChars）', () => {
  const small = (chunks: string[], maxChars: number, end = true): SseItem[] => {
    const items: SseItem[] = []
    const parser = createSseParser((item) => items.push(item), { maxChars })
    for (const chunk of chunks) parser.push(chunk)
    if (end) parser.end()
    return items
  }

  it('上限以内なら truncated を付けない', () => {
    // 上限は 'data: ' を含む行全体の文字数
    expect(small(['data: 12345\n\n'], 11)).toEqual([msg('12345')])
  })

  it('1 行が上限を超えたら、先頭の上限文字だけ残して truncated にする', () => {
    expect(small(['data: 1234567890\n\n'], 11)).toEqual([msg('12345', { truncated: true })])
  })

  it('改行の無い行がチャンクをまたいで続いても、保持するのは上限まで', () => {
    const chunks = ['data: ', ...Array.from({ length: 50 }, () => 'abcdefghij'), '\n\n']
    // 行全体（'data: ' を含む）の先頭 12 文字だけ残る
    expect(small(chunks, 12)).toEqual([msg('abcdef', { truncated: true })])
  })

  it('超過した行のあとのイベントは通常どおり解析する', () => {
    expect(small(['data: ' + 'x'.repeat(100) + '\n\ndata: ok\n\n'], 10)).toEqual([
      msg('x'.repeat(4), { truncated: true }),
      msg('ok'),
    ])
  })

  it('data 行が何行も続くイベントも、合計が上限を超えたら truncated にする', () => {
    const lines = Array.from({ length: 20 }, () => 'data: abcd\n').join('')
    const [item, ...rest] = small([lines + '\n'], 15)
    expect(rest).toEqual([])
    expect(item).toMatchObject({ kind: 'message', truncated: true })
    expect((item as { data: string }).data.length).toBeLessThanOrEqual(15)
  })

  it('空行の来ない data 行が続いても、保持は上限まで（end() でも truncated）', () => {
    const items = small(
      Array.from({ length: 1000 }, () => 'data: abcdefgh\n'),
      40,
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'message', incomplete: true, truncated: true })
    expect((items[0] as { data: string }).data.length).toBeLessThanOrEqual(40)
  })

  it('コメント行にも上限を適用する', () => {
    expect(small([': ' + 'c'.repeat(50) + '\n'], 10)).toEqual([
      { kind: 'comment', text: 'c'.repeat(8), truncated: true },
    ])
  })

  it('代用対の途中では切らない', () => {
    // 'data: ' の 6 文字のあと、上限 7 文字目に絵文字（2 文字）の前半が来る
    const [item] = small(['data: 😀😀\n\n'], 7)
    expect(item).toMatchObject({ data: '', truncated: true })
  })

  it('既定の上限は実用的な画像サイズ（数 MB）の 1 イベントを切らない', () => {
    const big = 'a'.repeat(5_000_000)
    const items = parse([`data: ${big}\n\n`])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'message', data: big })
    expect(items[0]).not.toHaveProperty('truncated')
  })
})

describe('createSseParser: AI SDK が受け取るイベントと一致する', () => {
  /** SDK（parseJsonEventStream = TextDecoderStream + eventsource-parser）が受け取る data の列。 */
  async function sdkEvents(chunks: string[]): Promise<string[]> {
    const { jsonSchema, parseJsonEventStream } = await import('ai')
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const out: string[] = []
    // スキーマ無しなら JSON として読めたかだけを見る。読めなかった data は error.text に元の文字列が入る
    const reader = parseJsonEventStream({ stream, schema: jsonSchema({}) }).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.push(
        value.success ? JSON.stringify(value.rawValue) : (value.error as { text: string }).text,
      )
    }
    return out
  }

  /** SDK は JSON として読めた data を再シリアライズして返すので、こちらも同じ形にそろえる。 */
  function canonical(data: string): string {
    try {
      return JSON.stringify(JSON.parse(data))
    } catch {
      return data
    }
  }

  it('乱択した改行・チャンクの切れ目で、end() の救済分（incomplete）を除くと SDK の受信と同じ', async () => {
    // data は JSON として正規化されても変わらない文字列だけにする（比較を単純にするため）
    const tokens = [
      'data: 1',
      'data:2',
      'data: "a"',
      'data:',
      '\n',
      '\r',
      '\r\n',
      '\n\n',
      ': c',
      'event: e',
      'id: 9',
      ' ',
      'x',
    ]
    let seed = 20260607
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    const mismatches: string[] = []
    let withIncomplete = 0
    for (let n = 0; n < 600; n++) {
      let wire = ''
      for (let i = 0, len = 1 + Math.floor(rnd() * 12); i < len; i++) {
        wire += tokens[Math.floor(rnd() * tokens.length)] as string
      }
      const chunks: string[] = []
      for (let pos = 0; pos < wire.length;) {
        const size = 1 + Math.floor(rnd() * 5)
        chunks.push(wire.slice(pos, pos + size))
        pos += size
      }
      const ours = parse(chunks)
      if (ours.some((item) => item.kind === 'message' && item.incomplete)) withIncomplete++
      const received = ours
        .filter((item) => item.kind === 'message' && item.incomplete !== true)
        .map((item) => canonical((item as { data: string }).data))
      const sdk = await sdkEvents(chunks)
      if (JSON.stringify(received) !== JSON.stringify(sdk)) {
        mismatches.push(
          `${JSON.stringify(chunks)} ours=${JSON.stringify(received)} sdk=${JSON.stringify(sdk)}`,
        )
      }
    }
    // 救済（incomplete）が起きるケースも含めて確かめている
    expect(withIncomplete).toBeGreaterThan(30)
    expect(mismatches).toEqual([])
  })
})

describe('createSseParser: 独立性', () => {
  it('複数のパーサーは状態を共有しない', () => {
    const a: SseItem[] = []
    const b: SseItem[] = []
    const pa = createSseParser((item) => a.push(item))
    const pb = createSseParser((item) => b.push(item))
    pa.push('data: a')
    pb.push('data: b\n\n')
    pa.push('\n\n')
    expect(a).toEqual([msg('a')])
    expect(b).toEqual([msg('b')])
  })
})
