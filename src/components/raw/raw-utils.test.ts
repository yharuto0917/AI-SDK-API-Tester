import { describe, expect, it } from 'vitest'
import {
  appendLimited,
  inspectJson,
  isLikelyBinaryContentType,
  isRawMethod,
  prettyPrintJson,
  statusTone,
} from '@/components/raw/raw-utils'

describe('inspectJson', () => {
  it('空文字・空白だけは empty', () => {
    expect(inspectJson('')).toEqual({ kind: 'empty' })
    expect(inspectJson(' \n\t ')).toEqual({ kind: 'empty' })
  })

  it('有効な JSON は valid（プリミティブも含む）', () => {
    expect(inspectJson('{"a":1}').kind).toBe('valid')
    expect(inspectJson('[1, 2]').kind).toBe('valid')
    expect(inspectJson('123').kind).toBe('valid')
    expect(inspectJson('"text"').kind).toBe('valid')
    expect(inspectJson('null').kind).toBe('valid')
  })

  it('壊れた JSON は invalid でパースエラーのメッセージを持つ', () => {
    const state = inspectJson('{"a":')
    expect(state.kind).toBe('invalid')
    if (state.kind === 'invalid') expect(state.message).not.toBe('')
    expect(inspectJson('hello').kind).toBe('invalid')
    expect(inspectJson('{a:1}').kind).toBe('invalid')
  })
})

describe('prettyPrintJson', () => {
  it('オブジェクトと配列を 2 スペースで整形する', () => {
    expect(prettyPrintJson('{"a":1,"b":[1,2],"c":{"d":null}}')).toBe(
      [
        '{',
        '  "a": 1,',
        '  "b": [',
        '    1,',
        '    2',
        '  ],',
        '  "c": {',
        '    "d": null',
        '  }',
        '}',
      ].join('\n'),
    )
  })

  it('空のオブジェクト・配列は 1 行のまま', () => {
    expect(prettyPrintJson('{"a":{},"b":[ ],"c":{ \n }}')).toBe(
      ['{', '  "a": {},', '  "b": [],', '  "c": {}', '}'].join('\n'),
    )
  })

  it('整形済みの JSON を何度整形しても同じ結果になる', () => {
    const once = prettyPrintJson('{"a":[1,{"b":2}],"c":"x"}')
    expect(once).not.toBeNull()
    expect(prettyPrintJson(once ?? '')).toBe(once)
  })

  it('大きな整数・小数表記・指数表記をそのまま残す（JSON.parse を経由しない）', () => {
    const text = '{"id":12345678901234567890,"n":1.0,"e":1E+3,"neg":-0}'
    const pretty = prettyPrintJson(text)
    expect(pretty).toContain('12345678901234567890')
    expect(pretty).toContain('"n": 1.0')
    expect(pretty).toContain('"e": 1E+3')
    expect(pretty).toContain('"neg": -0')
  })

  it('重複キーを落とさない', () => {
    const pretty = prettyPrintJson('{"a":1,"a":2}')
    expect(pretty).toBe('{\n  "a": 1,\n  "a": 2\n}')
  })

  it('文字列内の記号・エスケープ・日本語を壊さない', () => {
    const text = '{"s":"a, b: {c} [d] \\"q\\" \\\\ \\u3042 あ"}'
    const pretty = prettyPrintJson(text)
    expect(pretty).toBe(`{\n  "s": "a, b: {c} [d] \\"q\\" \\\\ \\u3042 あ"\n}`)
    expect(JSON.parse(pretty ?? '')).toEqual(JSON.parse(text))
  })

  it('末尾がバックスラッシュで終わる文字列の直後も正しく読む', () => {
    const text = '["a\\\\","b"]'
    expect(JSON.parse(prettyPrintJson(text) ?? '')).toEqual(['a\\', 'b'])
  })

  it('トップレベルのプリミティブはそのまま', () => {
    expect(prettyPrintJson('123')).toBe('123')
    expect(prettyPrintJson(' "x" ')).toBe('"x"')
    expect(prettyPrintJson('true')).toBe('true')
  })

  it('無効な JSON と空文字は null', () => {
    expect(prettyPrintJson('')).toBeNull()
    expect(prettyPrintJson('{"a":')).toBeNull()
    expect(prettyPrintJson('data: {"a":1}')).toBeNull()
  })
})

describe('appendLimited', () => {
  it('上限以内ならそのまま連結する', () => {
    expect(appendLimited('abc', 'def', 10)).toEqual({ text: 'abcdef', truncated: false })
    expect(appendLimited('abc', 'defg', 7)).toEqual({ text: 'abcdefg', truncated: false })
  })

  it('上限を超えた分を切り捨てて truncated を立てる', () => {
    expect(appendLimited('abc', 'defgh', 6)).toEqual({ text: 'abcdef', truncated: true })
  })

  it('すでに上限に達していれば何も足さない', () => {
    expect(appendLimited('abcdef', 'x', 6)).toEqual({ text: 'abcdef', truncated: true })
  })

  it('サロゲートペアの途中では切らない', () => {
    // '😀' は 2 つの UTF-16 コードユニット。上限 3 だと「a😀」の途中になるので手前で止める
    expect(appendLimited('a', '😀😀', 2)).toEqual({ text: 'a', truncated: true })
    expect(appendLimited('a', '😀😀', 3)).toEqual({ text: 'a😀', truncated: true })
  })
})

describe('statusTone', () => {
  it('ステータスコードの区分に対応する', () => {
    expect(statusTone(101)).toBe('info')
    expect(statusTone(200)).toBe('success')
    expect(statusTone(204)).toBe('success')
    expect(statusTone(301)).toBe('redirect')
    expect(statusTone(404)).toBe('client-error')
    expect(statusTone(429)).toBe('client-error')
    expect(statusTone(500)).toBe('server-error')
    expect(statusTone(503)).toBe('server-error')
  })

  it('不正値・範囲外・未定義は unknown', () => {
    expect(statusTone(undefined)).toBe('unknown')
    expect(statusTone(0)).toBe('unknown')
    expect(statusTone(99)).toBe('unknown')
    expect(statusTone(600)).toBe('unknown')
    expect(statusTone(200.5)).toBe('unknown')
    expect(statusTone(Number.NaN)).toBe('unknown')
  })
})

describe('isLikelyBinaryContentType', () => {
  it('画像・音声・動画・octet-stream などはバイナリ', () => {
    expect(isLikelyBinaryContentType('image/png')).toBe(true)
    expect(isLikelyBinaryContentType('audio/mpeg')).toBe(true)
    expect(isLikelyBinaryContentType('video/mp4; codecs=avc1')).toBe(true)
    expect(isLikelyBinaryContentType('application/octet-stream')).toBe(true)
    expect(isLikelyBinaryContentType('Application/PDF')).toBe(true)
  })

  it('テキスト系・JSON・SSE・SVG はバイナリではない', () => {
    expect(isLikelyBinaryContentType('application/json; charset=utf-8')).toBe(false)
    expect(isLikelyBinaryContentType('text/event-stream')).toBe(false)
    expect(isLikelyBinaryContentType('text/plain')).toBe(false)
    expect(isLikelyBinaryContentType('image/svg+xml')).toBe(false)
    expect(isLikelyBinaryContentType('application/x-ndjson')).toBe(false)
  })

  it('未指定は false', () => {
    expect(isLikelyBinaryContentType(undefined)).toBe(false)
    expect(isLikelyBinaryContentType(null)).toBe(false)
    expect(isLikelyBinaryContentType('')).toBe(false)
  })
})

describe('isRawMethod', () => {
  it('対応メソッドだけ true', () => {
    expect(isRawMethod('GET')).toBe(true)
    expect(isRawMethod('DELETE')).toBe(true)
    expect(isRawMethod('get')).toBe(false)
    expect(isRawMethod('HEAD')).toBe(false)
  })
})
