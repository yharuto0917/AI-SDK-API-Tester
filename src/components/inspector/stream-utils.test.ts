import { describe, expect, it } from 'vitest'
import {
  computeVirtualWindow,
  eventDetail,
  eventDetailHeight,
  eventFamily,
  eventLabel,
  eventNoteLines,
  eventNotes,
  eventPreview,
  eventsToJson,
  filterEvents,
  findEventPosition,
  isFilterEmpty,
  STREAM_ROW_HEIGHT,
  type VirtualExtra,
} from '@/components/inspector/stream-utils'
import type { StreamEvent } from '@/types'

function json(index: number, data: Record<string, unknown>, extra: Partial<StreamEvent> = {}) {
  const type = typeof data.type === 'string' ? data.type : undefined
  const event: StreamEvent = {
    index,
    atMs: index * 10,
    kind: 'sse-json',
    data,
    raw: JSON.stringify(data),
    ...(type !== undefined ? { type } : {}),
    ...extra,
  }
  return event
}

function other(
  index: number,
  kind: StreamEvent['kind'],
  raw: string,
  extra: Partial<StreamEvent> = {},
) {
  const event: StreamEvent = { index, atMs: index, kind, raw, ...extra }
  return event
}

describe('eventLabel', () => {
  it('type があればそれ、無ければ種別名', () => {
    expect(eventLabel({ kind: 'sse-json', type: 'text-delta' })).toBe('text-delta')
    expect(eventLabel({ kind: 'sse-json' })).toBe('json')
    expect(eventLabel({ kind: 'sse-done' })).toBe('[DONE]')
    expect(eventLabel({ kind: 'sse-comment' })).toBe('comment')
    expect(eventLabel({ kind: 'text-chunk' })).toBe('chunk')
    expect(eventLabel({ kind: 'sse-text' })).toBe('sse-text')
  })
})

describe('eventFamily', () => {
  const family = (type: string) => eventFamily({ kind: 'sse-json', type })

  it('text / reasoning は text', () => {
    for (const type of [
      'text-start',
      'text-delta',
      'text-end',
      'reasoning-start',
      'reasoning-delta',
    ]) {
      expect(family(type)).toBe('text')
    }
  })

  it('tool-* は tool', () => {
    for (const type of [
      'tool-input-start',
      'tool-input-available',
      'tool-output-error',
      'tool-approval-request',
    ]) {
      expect(family(type)).toBe('tool')
    }
  })

  it('data-* は data', () => {
    expect(family('data-weather')).toBe('data')
  })

  it('error は error', () => {
    expect(family('error')).toBe('error')
  })

  it('start / finish 系 / abort は lifecycle', () => {
    for (const type of ['start', 'finish', 'abort', 'start-step', 'finish-step', 'reset-step']) {
      expect(family(type)).toBe('lifecycle')
    }
  })

  it('それ以外の type は other', () => {
    for (const type of ['file', 'source-url', 'message-metadata', 'reasoning-file', 'whatever']) {
      expect(family(type)).toBe('other')
    }
  })

  it('type の無い JSON は other', () => {
    expect(eventFamily({ kind: 'sse-json' })).toBe('other')
  })

  it('SSE の done / comment は control、text-chunk は chunk', () => {
    expect(eventFamily({ kind: 'sse-done' })).toBe('control')
    expect(eventFamily({ kind: 'sse-comment' })).toBe('control')
    expect(eventFamily({ kind: 'text-chunk' })).toBe('chunk')
  })

  it('JSON として壊れた SSE（parseError あり）は error', () => {
    expect(eventFamily({ kind: 'sse-text', parseError: 'Unexpected token' })).toBe('error')
    expect(eventFamily({ kind: 'sse-text' })).toBe('other')
  })
})

describe('eventNotes', () => {
  it('フラグが無ければ注記は無い', () => {
    expect(eventNotes({})).toEqual([])
    expect(eventNotes(json(0, { type: 'start' }))).toEqual([])
    expect(eventNotes({ incomplete: false, rawTruncated: false, parseSkipped: false })).toEqual([])
  })

  it('incomplete は「未完了・SDK未受信」（控えめな muted）', () => {
    const [note, ...rest] = eventNotes({ incomplete: true })
    expect(rest).toEqual([])
    expect(note).toMatchObject({ id: 'incomplete', label: '未完了・SDK未受信', tone: 'muted' })
    expect(note?.description).toContain('空行')
    expect(note?.description).toContain('SDK')
  })

  it('rawTruncated は「切り詰め」', () => {
    const [note, ...rest] = eventNotes({ rawTruncated: true })
    expect(rest).toEqual([])
    expect(note).toMatchObject({ id: 'rawTruncated', label: '切り詰め', tone: 'muted' })
  })

  it('parseSkipped は「巨大のためJSON判定を省略」', () => {
    const [note, ...rest] = eventNotes({ parseSkipped: true })
    expect(rest).toEqual([])
    expect(note).toMatchObject({
      id: 'parseSkipped',
      label: '巨大のためJSON判定を省略',
      tone: 'muted',
    })
  })

  it('schemaError は warn 色で、日本語の理由を説明に含める', () => {
    const reason = '「delta」が数値 1 です（string が必要）'
    const [note, ...rest] = eventNotes({ schemaError: reason })
    expect(rest).toEqual([])
    expect(note).toMatchObject({ id: 'schemaError', label: 'スキーマ不一致', tone: 'warn' })
    expect(note?.description).toContain(reason)
  })

  it('理由が空文字でも schemaError の注記は出る（理由なしの説明になる）', () => {
    const [note] = eventNotes({ schemaError: '' })
    expect(note?.id).toBe('schemaError')
    expect(note?.description).toBe('SDK のスキーマ（UIMessageChunk）に合いません')
  })

  it('複数あるときは warn（スキーマ不一致）を先頭に、残りは固定の順で並べる', () => {
    expect(
      eventNotes({
        parseSkipped: true,
        rawTruncated: true,
        incomplete: true,
        schemaError: 'x',
      }).map((note) => note.id),
    ).toEqual(['schemaError', 'incomplete', 'rawTruncated', 'parseSkipped'])
  })

  it('イベントを書き換えない', () => {
    const event = json(0, { type: 'x' }, { incomplete: true, schemaError: 'x' })
    const copy = structuredClone(event)
    eventNotes(event)
    expect(event).toEqual(copy)
  })
})

describe('eventNoteLines', () => {
  it('注記が無ければ 0 行', () => {
    expect(eventNoteLines([])).toBe(0)
  })

  it('短い注記は 1 件 1 行、長い説明は折り返しの分だけ増える', () => {
    const [short] = eventNotes({ rawTruncated: true })
    expect(eventNoteLines(short ? [short] : [])).toBeLessThanOrEqual(2)
    const [long] = eventNotes({ schemaError: 'あ'.repeat(200) })
    expect(eventNoteLines(long ? [long] : [])).toBeGreaterThan(4)
  })
})

describe('eventPreview', () => {
  it('text-delta は本文だけを JSON 文字列の形で出す', () => {
    expect(eventPreview(json(0, { type: 'text-delta', id: 't1', delta: 'Hello\nworld' }))).toBe(
      '"Hello\\nworld"',
    )
  })

  it('type 以外のフィールドを JSON で出す', () => {
    expect(
      eventPreview(json(0, { type: 'tool-input-start', toolCallId: 'c1', toolName: 'weather' })),
    ).toBe('{"toolCallId":"c1","toolName":"weather"}')
  })

  it('type だけのイベントは空', () => {
    expect(eventPreview(json(0, { type: 'start' }))).toBe('')
  })

  it('長いプレビューは 80 文字 + … に切る', () => {
    const preview = eventPreview(json(0, { type: 'text-delta', id: '1', delta: 'a'.repeat(500) }))
    expect(preview.length).toBe(81)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('max を指定できる', () => {
    expect(eventPreview(json(0, { type: 'error', errorText: 'x'.repeat(50) }), 10).length).toBe(11)
  })

  it('[DONE] / コメント / テキストチャンク / 非 JSON の SSE', () => {
    expect(eventPreview(other(0, 'sse-done', '[DONE]'))).toBe('[DONE]')
    expect(eventPreview(other(0, 'sse-comment', ' ping\n'))).toBe('ping')
    expect(eventPreview(other(0, 'text-chunk', 'Hel\nlo'))).toBe('"Hel\\nlo"')
    expect(eventPreview(other(0, 'sse-text', 'not   json\n'))).toBe('not json')
  })

  it('data がオブジェクトでない JSON も落ちない', () => {
    const event: StreamEvent = { index: 0, atMs: 0, kind: 'sse-json', data: [1, 2], raw: '[1,2]' }
    expect(eventPreview(event)).toBe('[1,2]')
    const nullEvent: StreamEvent = { index: 0, atMs: 0, kind: 'sse-json', data: null, raw: 'null' }
    expect(eventPreview(nullEvent)).toBe('null')
  })
})

describe('filterEvents', () => {
  const events: StreamEvent[] = [
    json(0, { type: 'start' }),
    json(1, { type: 'text-delta', delta: 'a' }),
    json(2, { type: 'tool-input-start' }),
    json(3, { type: 'text-delta', delta: 'b' }, { eventName: 'message' }),
    other(4, 'sse-comment', 'ping'),
    other(5, 'sse-done', '[DONE]'),
    other(6, 'text-chunk', 'chunk'),
  ]

  it('フィルタが空なら元の配列をそのまま返す', () => {
    expect(filterEvents(events, { query: '', kind: 'all' })).toBe(events)
    expect(filterEvents(events, { query: '   ', kind: 'all' })).toBe(events)
    expect(isFilterEmpty({ query: ' ', kind: 'all' })).toBe(true)
  })

  it('type の部分一致（大文字小文字を区別しない）', () => {
    expect(filterEvents(events, { query: 'DELTA', kind: 'all' }).map((e) => e.index)).toEqual([
      1, 3,
    ])
    expect(filterEvents(events, { query: 'tool', kind: 'all' }).map((e) => e.index)).toEqual([2])
  })

  it('type の無いイベントは種別名に一致する', () => {
    expect(filterEvents(events, { query: 'done', kind: 'all' }).map((e) => e.index)).toEqual([5])
    expect(filterEvents(events, { query: 'comment', kind: 'all' }).map((e) => e.index)).toEqual([4])
  })

  it('SSE の event 名にも一致する', () => {
    expect(filterEvents(events, { query: 'message', kind: 'all' }).map((e) => e.index)).toEqual([3])
  })

  it('種別で絞る', () => {
    expect(filterEvents(events, { query: '', kind: 'sse-json' }).map((e) => e.index)).toEqual([
      0, 1, 2, 3,
    ])
    expect(filterEvents(events, { query: '', kind: 'text-chunk' }).map((e) => e.index)).toEqual([6])
  })

  it('種別とタイプは AND で絞る', () => {
    expect(filterEvents(events, { query: 'text', kind: 'sse-json' }).map((e) => e.index)).toEqual([
      1, 3,
    ])
    expect(filterEvents(events, { query: 'text', kind: 'sse-done' })).toEqual([])
  })

  it('何も一致しなければ空配列', () => {
    expect(filterEvents(events, { query: 'zzz', kind: 'all' })).toEqual([])
  })
})

describe('findEventPosition', () => {
  const events = [0, 2, 3, 7, 9].map((index) => other(index, 'text-chunk', 'x'))

  it('index の位置を二分探索で返す', () => {
    expect(findEventPosition(events, 0)).toBe(0)
    expect(findEventPosition(events, 3)).toBe(2)
    expect(findEventPosition(events, 9)).toBe(4)
  })

  it('無ければ -1', () => {
    expect(findEventPosition(events, 1)).toBe(-1)
    expect(findEventPosition(events, 100)).toBe(-1)
    expect(findEventPosition([], 0)).toBe(-1)
  })
})

describe('eventsToJson', () => {
  it('全イベントを整形 JSON にする', () => {
    const events = [json(0, { type: 'start' })]
    expect(JSON.parse(eventsToJson(events))).toEqual(events)
  })
})

describe('eventDetail', () => {
  it('sse-json は data を整形して json として返す', () => {
    const detail = eventDetail(json(0, { type: 'text-delta', delta: 'x' }))
    expect(detail.language).toBe('json')
    expect(JSON.parse(detail.code)).toEqual({ type: 'text-delta', delta: 'x' })
    expect(detail.code).toContain('\n  "type"')
    expect(detail.clipped).toBe(false)
  })

  it('data は parse 済みで桁落ちしているので、整形は raw から行う', () => {
    const raw = '{"type":"x","id":12345678901234567890,"a":1,"a":2}'
    const detail = eventDetail({
      index: 0,
      atMs: 0,
      kind: 'sse-json',
      type: 'x',
      data: JSON.parse(raw),
      raw,
    })
    expect(detail.code).toContain('"id": 12345678901234567890')
    expect(detail.code.match(/"a": /g)).toHaveLength(2)
  })

  it('raw が読めない sse-json は data を整形して返す', () => {
    const detail = eventDetail({
      index: 0,
      atMs: 0,
      kind: 'sse-json',
      data: { a: 1 },
      raw: 'not json',
    })
    expect(detail).toEqual({ language: 'json', code: '{\n  "a": 1\n}', clipped: false })
  })

  it('それ以外は raw をそのまま text で返す', () => {
    expect(eventDetail(other(0, 'text-chunk', 'hello'))).toEqual({
      language: 'text',
      code: 'hello',
      clipped: false,
    })
    expect(eventDetail(other(0, 'sse-text', '{broken', { parseError: 'x' })).code).toBe('{broken')
  })

  it('巨大なペイロードは切り詰めて clipped を立てる', () => {
    const detail = eventDetail(other(0, 'text-chunk', 'a'.repeat(60_000)))
    expect(detail.clipped).toBe(true)
    expect(detail.code.length).toBe(50_000)
  })
})

describe('eventDetailHeight（注記の行を加える）', () => {
  it('注記の行数ぶん、1 行 16px で高くなる', () => {
    expect(eventDetailHeight('a', 0)).toBe(80)
    expect(eventDetailHeight('a', 2)).toBe(112)
    expect(eventDetailHeight('a')).toBe(eventDetailHeight('a', 0))
  })

  it('上限（280px）は超えず、負の行数は無視する', () => {
    expect(eventDetailHeight('a', 100)).toBe(280)
    expect(eventDetailHeight('a', -5)).toBe(80)
  })
})

describe('eventDetailHeight', () => {
  it('行数に応じて増え、上下限で頭打ちになる', () => {
    expect(eventDetailHeight('a')).toBe(80)
    expect(eventDetailHeight('a\nb\nc\nd\ne')).toBe(144)
    expect(eventDetailHeight(Array.from({ length: 1000 }, () => 'x').join('\n'))).toBe(280)
  })
})

describe('computeVirtualWindow', () => {
  const base = { rowHeight: 10, viewportHeight: 100, overscan: 0 }

  it('行が無ければ全部 0', () => {
    expect(computeVirtualWindow({ ...base, total: 0, scrollTop: 0 })).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
    })
  })

  it('先頭では表示領域に収まる行だけを返す', () => {
    expect(computeVirtualWindow({ ...base, total: 1000, scrollTop: 0 })).toEqual({
      start: 0,
      end: 10,
      offsetTop: 0,
      totalHeight: 10_000,
    })
  })

  it('途中のスクロール位置では行の境界に合わせた範囲を返す', () => {
    expect(computeVirtualWindow({ ...base, total: 1000, scrollTop: 500 })).toEqual({
      start: 50,
      end: 60,
      offsetTop: 500,
      totalHeight: 10_000,
    })
  })

  it('行の途中までスクロールしたときは、かかっている行を両端とも含める', () => {
    const w = computeVirtualWindow({ ...base, total: 1000, scrollTop: 505 })
    expect(w.start).toBe(50)
    expect(w.end).toBe(61)
    expect(w.offsetTop).toBe(500)
  })

  it('overscan の分だけ前後に広げ、端では範囲内に収める', () => {
    const middle = computeVirtualWindow({ ...base, overscan: 3, total: 1000, scrollTop: 500 })
    expect([middle.start, middle.end, middle.offsetTop]).toEqual([47, 63, 470])
    const top = computeVirtualWindow({ ...base, overscan: 3, total: 1000, scrollTop: 0 })
    expect([top.start, top.end]).toEqual([0, 13])
    const bottom = computeVirtualWindow({ ...base, overscan: 3, total: 1000, scrollTop: 9900 })
    expect([bottom.start, bottom.end]).toEqual([987, 1000])
  })

  it('スクロール位置が範囲外でも末尾付近の行を返す', () => {
    const w = computeVirtualWindow({ ...base, total: 100, scrollTop: 999_999 })
    expect(w.end).toBe(100)
    expect(w.start).toBe(99)
  })

  it('負数や NaN のスクロール位置は 0 として扱う', () => {
    expect(computeVirtualWindow({ ...base, total: 100, scrollTop: -50 }).start).toBe(0)
    expect(computeVirtualWindow({ ...base, total: 100, scrollTop: Number.NaN }).start).toBe(0)
  })

  it('表示領域の高さが 0（jsdom など）でも、仮定の高さで描画行数を抑える', () => {
    const w = computeVirtualWindow({
      total: 5000,
      rowHeight: STREAM_ROW_HEIGHT,
      scrollTop: 0,
      viewportHeight: 0,
    })
    expect(w.end - w.start).toBeGreaterThan(0)
    expect(w.end - w.start).toBeLessThan(60)
    expect(w.totalHeight).toBe(5000 * STREAM_ROW_HEIGHT)
  })

  it('5000 行でも描画する行数は数十行に収まる', () => {
    for (const scrollTop of [0, 1234, 70_000, 139_000]) {
      const w = computeVirtualWindow({
        total: 5000,
        rowHeight: STREAM_ROW_HEIGHT,
        scrollTop,
        viewportHeight: 400,
      })
      expect(w.end - w.start).toBeLessThan(50)
    }
  })

  describe('展開した行（extras）がある場合', () => {
    // position 2 の下に 50px、position 5 の下に 30px 挟まる
    const extras: VirtualExtra[] = [
      { position: 5, height: 30 },
      { position: 2, height: 50 },
    ]

    it('全体の高さに追加分を足す', () => {
      const w = computeVirtualWindow({ ...base, total: 10, scrollTop: 0, extras })
      expect(w.totalHeight).toBe(10 * 10 + 80)
    })

    it('展開部の下の行は追加分だけ後ろにずれる', () => {
      // 行の上端: 0,10,20(extra 50),80,90,100(extra 30),160,...
      const w = computeVirtualWindow({
        ...base,
        total: 10,
        scrollTop: 80,
        viewportHeight: 30,
        extras,
      })
      expect(w.start).toBe(3)
      expect(w.offsetTop).toBe(80)
      expect(w.end).toBe(6)
    })

    it('展開部の中をスクロールしているときは、その行を先頭にする', () => {
      const w = computeVirtualWindow({
        ...base,
        total: 10,
        scrollTop: 50,
        viewportHeight: 20,
        extras,
      })
      expect(w.start).toBe(2)
      expect(w.offsetTop).toBe(20)
    })

    it('範囲外・不正な extras は無視する', () => {
      const w = computeVirtualWindow({
        ...base,
        total: 10,
        scrollTop: 0,
        extras: [
          { position: 99, height: 100 },
          { position: -1, height: 100 },
          { position: 1.5, height: 100 },
          { position: 3, height: 0 },
        ],
      })
      expect(w.totalHeight).toBe(100)
    })

    it('同じ position が重なったら後のものを採用する', () => {
      const w = computeVirtualWindow({
        ...base,
        total: 10,
        scrollTop: 0,
        extras: [
          { position: 1, height: 10 },
          { position: 1, height: 40 },
        ],
      })
      expect(w.totalHeight).toBe(140)
    })

    it('多数の行と展開があっても描画範囲が正しい（総当たりと一致）', () => {
      const total = 300
      const rowHeight = 10
      const many: VirtualExtra[] = [7, 40, 41, 150, 299].map((position) => ({
        position,
        height: 25,
      }))
      const tops: number[] = []
      let y = 0
      for (let i = 0; i < total; i++) {
        tops.push(y)
        y += rowHeight + (many.find((e) => e.position === i)?.height ?? 0)
      }
      for (const scrollTop of [0, 33, 120, 777, 1500, 3000]) {
        const viewportHeight = 90
        const w = computeVirtualWindow({
          total,
          rowHeight,
          scrollTop,
          viewportHeight,
          overscan: 0,
          extras: many,
        })
        const bottomOf = (i: number) => tops[i + 1] ?? y
        const expectedStart = tops.findIndex((_, i) => bottomOf(i) > scrollTop)
        const expectedEnd = tops.findIndex(
          (top, i) => i > expectedStart && top >= scrollTop + viewportHeight,
        )
        expect(w.start).toBe(expectedStart === -1 ? total - 1 : expectedStart)
        expect(w.end).toBe(expectedEnd === -1 ? total : expectedEnd)
        expect(w.offsetTop).toBe(tops[w.start])
        expect(w.totalHeight).toBe(y)
      }
    })
  })
})
