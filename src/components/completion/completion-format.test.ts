import { describe, expect, it } from 'vitest'
import { countCharacters, describeCompletionError } from '@/components/completion/completion-format'
import { PROXY_NAME, PROXY_TOGGLE_LABEL } from '@/lib/proxy'

function errorNamed(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error(message)
  error.name = name
  return Object.assign(error, extra)
}

describe('countCharacters', () => {
  it('空文字は 0', () => {
    expect(countCharacters('')).toBe(0)
  })

  it('ASCII と日本語を 1 文字ずつ数える', () => {
    expect(countCharacters('abc')).toBe(3)
    expect(countCharacters('こんにちは')).toBe(5)
    expect(countCharacters('a\nb')).toBe(3)
  })

  it('サロゲートペア（絵文字・𠮷）は 1 文字', () => {
    expect(countCharacters('😀')).toBe(1)
    expect(countCharacters('😀a😀')).toBe(3)
    expect(countCharacters('𠮷野家')).toBe(3)
  })

  it('対になっていないサロゲートは 1 文字として数える', () => {
    expect(countCharacters('\ud83d')).toBe(1)
    expect(countCharacters('\ud83dx')).toBe(2)
    expect(countCharacters('\ude00')).toBe(1)
  })
})

describe('describeCompletionError', () => {
  it('RequestShapeError は設定の確認を促す', () => {
    const info = describeCompletionError(
      errorNamed('RequestShapeError', 'エンドポイントを入力してください'),
      'data',
    )
    expect(info.kind).toBe('shape')
    expect(info.message).toBe('エンドポイントを入力してください')
    expect(info.hint).toContain('設定パネル')
  })

  it('statusCode を持つエラーは HTTP エラーとして分類する', () => {
    const info = describeCompletionError(
      errorNamed('AI_APICallError', '{"error":"boom"}', { statusCode: 503 }),
      'data',
    )
    expect(info.kind).toBe('http')
    expect(info.statusCode).toBe(503)
    expect(info.title).toContain('HTTP 503')
    expect(info.message).toBe('{"error":"boom"}')
  })

  it('本文が空の HTTP エラーはステータスコードを本文にする', () => {
    const info = describeCompletionError(
      errorNamed('AI_APICallError', '', { statusCode: 404 }),
      'text',
    )
    expect(info.message).toBe('HTTP 404')
  })

  it('error チャンクは stream として分類する', () => {
    const info = describeCompletionError(
      errorNamed('AI_UIMessageStreamError', 'model overloaded'),
      'data',
    )
    expect(info.kind).toBe('stream')
    expect(info.message).toBe('model overloaded')
  })

  it('JSON のパースエラーは data プロトコルのときだけ text への切り替えを案内する', () => {
    const parse = errorNamed('AI_JSONParseError', 'bad json')
    expect(describeCompletionError(parse, 'data').kind).toBe('protocol')
    expect(describeCompletionError(parse, 'data').hint).toContain('text')
    expect(describeCompletionError(parse, 'text').hint).toBeUndefined()
  })

  it('スキーマのエラーは chunk の不一致と text への切り替えの両方の可能性を示す', () => {
    const validation = errorNamed('AI_TypeValidationError', 'Type validation failed')
    const info = describeCompletionError(validation, 'data')
    expect(info.kind).toBe('protocol')
    expect(info.message).toBe('Type validation failed')
    // SSE 自体は正常で chunk の形だけが合わないケース。本当の原因はインスペクタの診断が出す
    expect(info.hint).toContain('chunk')
    expect(info.hint).toContain('AI SDK の仕様')
    expect(info.hint).toContain('診断')
    // バックエンドがプレーンテキストの場合の対処
    expect(info.hint).toContain('text プロトコル')
    expect(info.hint).toContain('Completion のプロトコル')
    // text プロトコルは chunk を検証しないので、プロトコルの切り替えは案内しない
    expect(describeCompletionError(validation, 'text').hint).toBeUndefined()
  })

  it.each(['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed'])(
    'fetch の失敗（%s）は network として分類し、CORS に触れる',
    (message) => {
      const info = describeCompletionError(new TypeError(message), 'data')
      expect(info.kind).toBe('network')
      expect(info.hint).toContain('CORS')
      // 設定パネルのトグルのラベルと一致させる（表記ゆれで「どのトグルか」が分からなくならないように）
      expect(info.hint).toContain(`「${PROXY_TOGGLE_LABEL}」`)
      expect(info.hint).not.toMatch(/開発プロキシ|dev プロキシ/)
    },
  )

  it('リクエストを組み立てられないときのヒントも、プロキシの呼び名を揃える', () => {
    const info = describeCompletionError(errorNamed('RequestShapeError', 'x'), 'data')
    expect(info.hint).toContain(PROXY_NAME)
    expect(info.hint).not.toMatch(/開発プロキシ|dev プロキシ/)
  })

  it('それ以外は other。メッセージが空なら名前を使う', () => {
    expect(describeCompletionError(new Error('unexpected'), 'data')).toMatchObject({
      kind: 'other',
      message: 'unexpected',
    })
    expect(describeCompletionError(errorNamed('WeirdError', ''), 'data').message).toBe('WeirdError')
    // TypeError でも fetch 失敗の文言でなければ network 扱いにしない
    expect(describeCompletionError(new TypeError('x is not a function'), 'data').kind).toBe('other')
  })
})
