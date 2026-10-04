import { describe, expect, it } from 'vitest'
import {
  clipText,
  countLines,
  formatBody,
  formatJsonValue,
} from '@/components/inspector/json-utils'

describe('formatBody', () => {
  it('JSON オブジェクトを 2 スペースで整形する', () => {
    expect(formatBody('{"a":1,"b":[1,2]}')).toEqual({
      kind: 'json',
      text: '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}',
    })
  })

  it('配列も JSON として扱う', () => {
    expect(formatBody('[1,2]')).toEqual({ kind: 'json', text: '[\n  1,\n  2\n]' })
  })

  it('先頭に空白や改行があっても JSON と判定する', () => {
    expect(formatBody('\n  {"a":1}\n').kind).toBe('json')
  })

  it('壊れた JSON は元のテキストのまま返す', () => {
    expect(formatBody('{"a":')).toEqual({ kind: 'text', text: '{"a":' })
  })

  it('SSE やプレーンテキストは text', () => {
    const sse = 'data: {"type":"start"}\n\ndata: [DONE]\n\n'
    expect(formatBody(sse)).toEqual({ kind: 'text', text: sse })
    expect(formatBody('hello')).toEqual({ kind: 'text', text: 'hello' })
  })

  it('数値・文字列だけの本文は整形しても変わらないので text', () => {
    expect(formatBody('123').kind).toBe('text')
    expect(formatBody('"x"').kind).toBe('text')
    expect(formatBody('null').kind).toBe('text')
  })

  it('空文字と空白だけは text', () => {
    expect(formatBody('')).toEqual({ kind: 'text', text: '' })
    expect(formatBody('   \n')).toEqual({ kind: 'text', text: '   \n' })
  })

  it('サーバーが返した値を書き換えない（大きな整数・重複キー・1.0）', () => {
    const text = '{"id":12345678901234567890,"a":1,"a":2,"n":1.0,"e":1E+2,"s":"\\u00e9\\n"}'
    const formatted = formatBody(text)
    expect(formatted.kind).toBe('json')
    expect(formatted.text).toContain('"id": 12345678901234567890')
    expect(formatted.text.match(/"a": /g)).toHaveLength(2)
    expect(formatted.text).toContain('"n": 1.0')
    expect(formatted.text).toContain('"e": 1E+2')
    expect(formatted.text).toContain('"s": "\\u00e9\\n"')
    // 文字列の中に空白が無いので、空白を除けば元の文字列と同じ
    expect(formatted.text.replace(/\s/g, '')).toBe(text)
  })

  it('上限を超える本文は JSON でも parse しない', () => {
    const big = JSON.stringify({ v: 'x'.repeat(100) })
    expect(formatBody(big, 50)).toEqual({ kind: 'text', text: big })
    expect(formatBody(big, 1000).kind).toBe('json')
  })
})

describe('formatJsonValue', () => {
  it('値を整形 JSON にする', () => {
    expect(formatJsonValue({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(formatJsonValue('x')).toBe('"x"')
    expect(formatJsonValue(null)).toBe('null')
  })

  it('JSON にできない値でも落ちない', () => {
    expect(formatJsonValue(undefined)).toBe('undefined')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(typeof formatJsonValue(circular)).toBe('string')
    expect(formatJsonValue(10n)).toBe('10')
  })
})

describe('clipText', () => {
  it('上限以内ならそのまま', () => {
    expect(clipText('abc', 3)).toEqual({ text: 'abc', clipped: false, total: 3 })
  })

  it('上限を超えたら先頭だけ残して clipped を立てる', () => {
    expect(clipText('abcdef', 4)).toEqual({ text: 'abcd', clipped: true, total: 6 })
  })

  it('サロゲートペアの途中では切らない', () => {
    // '😀' は UTF-16 で 2 文字。3 文字目で切ると前半だけが残ってしまう
    const clipped = clipText('ab😀cd', 3)
    expect(clipped.text).toBe('ab')
    expect(clipped.clipped).toBe(true)
  })

  it('max が 0 なら空文字', () => {
    expect(clipText('abc', 0)).toEqual({ text: '', clipped: true, total: 3 })
  })
})

describe('countLines', () => {
  it('改行で数える', () => {
    expect(countLines('')).toBe(1)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\nb\n')).toBe(3)
  })
})
