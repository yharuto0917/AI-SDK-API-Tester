import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_HEADER_WARNING,
  isAuthorizationHeader,
  validateHeaderName,
  validateHeaderValue,
  warnHeaderName,
} from '@/components/settings/header-validation'

describe('validateHeaderName', () => {
  it.each(['X-Api-Key', 'authorization', 'x_custom.header', "!#$%&'*+-.^_`|~", 'A1'])(
    '%s は有効',
    (name) => {
      expect(validateHeaderName(name)).toBeNull()
    },
  )

  it('空欄・空白だけの名前は「未入力」としてエラーにしない', () => {
    expect(validateHeaderName('')).toBeNull()
    expect(validateHeaderName('   ')).toBeNull()
  })

  it('前後の空白は無視する（送信時に取り除かれる）', () => {
    expect(validateHeaderName('  X-Test  ')).toBeNull()
  })

  it.each(['bad name', 'a:b', 'a,b', 'a;b', 'a/b', 'a(b)', '名前', 'x\ny'])('%j は無効', (name) => {
    expect(validateHeaderName(name)).not.toBeNull()
  })
})

describe('validateHeaderValue', () => {
  it('ISO-8859-1 の範囲内なら有効（記号・空欄・アクセント付き文字を含む）', () => {
    expect(validateHeaderValue('')).toBeNull()
    expect(validateHeaderValue('Bearer abc.def-123')).toBeNull()
    expect(validateHeaderValue('café')).toBeNull()
  })

  it('日本語・絵文字・改行・NUL は無効', () => {
    expect(validateHeaderValue('こんにちは')).not.toBeNull()
    expect(validateHeaderValue('😀')).not.toBeNull()
    expect(validateHeaderValue('a\nb')).not.toBeNull()
    expect(validateHeaderValue('a\rb')).not.toBeNull()
    expect(validateHeaderValue('a\u0000b')).not.toBeNull()
  })

  it('前後の改行は送信時に取り除かれるのでエラーにしない', () => {
    expect(validateHeaderValue('abc\n')).toBeNull()
  })
})

describe('isAuthorizationHeader', () => {
  it('大文字小文字・前後の空白を無視して Authorization を判定する', () => {
    expect(isAuthorizationHeader('Authorization')).toBe(true)
    expect(isAuthorizationHeader(' authorization ')).toBe(true)
    expect(isAuthorizationHeader('X-Authorization')).toBe(false)
    expect(isAuthorizationHeader('')).toBe(false)
  })
})

describe('warnHeaderName（警告。エラーとは別でブロックしない）', () => {
  it.each([
    'Cookie',
    'origin',
    'Referer',
    'Host',
    'Content-Length',
    'Sec-Fetch-Mode',
    'Proxy-Authorization',
  ])('ブラウザが捨てる %s は警告する', (name) => {
    expect(warnHeaderName(name, 'x')).toBe(FORBIDDEN_HEADER_WARNING)
  })

  it('大文字小文字・前後の空白を無視して判定する', () => {
    expect(warnHeaderName('  COOKIE ', 'a=b')).toBe(FORBIDDEN_HEADER_WARNING)
  })

  it('メソッド上書きヘッダーは値が CONNECT / TRACE / TRACK のときだけ警告する', () => {
    expect(warnHeaderName('X-HTTP-Method-Override', 'CONNECT')).toBe(FORBIDDEN_HEADER_WARNING)
    expect(warnHeaderName('X-Method-Override', 'get, trace')).toBe(FORBIDDEN_HEADER_WARNING)
    expect(warnHeaderName('X-HTTP-Method-Override', 'PUT')).toBeNull()
    expect(warnHeaderName('X-HTTP-Method-Override', '')).toBeNull()
  })

  it('送れるヘッダーと、未入力（空欄）の行は警告しない', () => {
    expect(warnHeaderName('X-Api-Key', 'secret')).toBeNull()
    expect(warnHeaderName('Authorization', 'Bearer x')).toBeNull()
    // 接頭辞に見えるだけで、名前の先頭が sec- / proxy- ではない
    expect(warnHeaderName('x-sec-token', 'x')).toBeNull()
    expect(warnHeaderName('', '')).toBeNull()
    expect(warnHeaderName('   ', 'x')).toBeNull()
  })

  it('名前が不正なときはエラーが先に出るので、警告は重ねない', () => {
    expect(validateHeaderName('sec-a b')).not.toBeNull()
    expect(warnHeaderName('sec-a b', 'x')).toBeNull()
  })

  it('警告になるヘッダー名でも、エラー（validateHeaderName）にはならない', () => {
    expect(validateHeaderName('Cookie')).toBeNull()
    expect(validateHeaderValue('a=b')).toBeNull()
  })
})
