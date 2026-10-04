import { describe, expect, it } from 'vitest'
import { forbiddenHeaderHint, isForbiddenRequestHeader } from '@/lib/forbidden-headers'
import { PROXY_NAME } from '@/lib/proxy'

describe('isForbiddenRequestHeader', () => {
  it.each([
    'Accept-Charset',
    'Accept-Encoding',
    'Access-Control-Request-Headers',
    'Access-Control-Request-Method',
    'Connection',
    'Content-Length',
    'Cookie',
    'Cookie2',
    'Date',
    'DNT',
    'Expect',
    'Host',
    'Keep-Alive',
    'Origin',
    'Referer',
    'Set-Cookie',
    'TE',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
    'Via',
  ])('Fetch 仕様の forbidden request-header 名 %s は禁止', (name) => {
    expect(isForbiddenRequestHeader(name)).toBe(true)
  })

  it('大文字小文字・前後の空白を区別しない', () => {
    expect(isForbiddenRequestHeader('COOKIE')).toBe(true)
    expect(isForbiddenRequestHeader('cOoKiE')).toBe(true)
    expect(isForbiddenRequestHeader('  origin ')).toBe(true)
  })

  it.each(['Proxy-Authorization', 'proxy-connection', 'Sec-Fetch-Mode', 'sec-ch-ua', 'SEC-X'])(
    '接頭辞 proxy- / sec- の %s は禁止',
    (name) => {
      expect(isForbiddenRequestHeader(name)).toBe(true)
    },
  )

  it.each([
    'Authorization',
    'Content-Type',
    'Accept',
    'Accept-Language',
    'X-Api-Key',
    'x-trace-id',
    'User-Agent',
    'Cache-Control',
    'x-proxy-target',
    // 接頭辞に見えるだけで、名前の先頭が proxy- / sec- ではない
    'x-sec-token',
    'my-proxy-header',
    'security',
    'secret',
  ])('%s は送れるので禁止ではない', (name) => {
    expect(isForbiddenRequestHeader(name)).toBe(false)
  })

  describe('メソッド上書きヘッダー（値が CONNECT / TRACE / TRACK のときだけ禁止）', () => {
    it.each(['X-HTTP-Method', 'X-HTTP-Method-Override', 'X-Method-Override'])(
      '%s は禁止メソッドを値に持つときだけ禁止',
      (name) => {
        expect(isForbiddenRequestHeader(name, 'TRACE')).toBe(true)
        expect(isForbiddenRequestHeader(name, 'connect')).toBe(true)
        expect(isForbiddenRequestHeader(name, ' Track ')).toBe(true)
        expect(isForbiddenRequestHeader(name, 'PUT')).toBe(false)
        expect(isForbiddenRequestHeader(name, 'DELETE')).toBe(false)
        expect(isForbiddenRequestHeader(name, '')).toBe(false)
      },
    )

    it('値がカンマ区切りで複数あっても、禁止メソッドが 1 つでもあれば禁止', () => {
      expect(isForbiddenRequestHeader('x-http-method-override', 'PUT, TRACE')).toBe(true)
      expect(isForbiddenRequestHeader('x-http-method-override', 'PUT, PATCH')).toBe(false)
    })

    it('値を渡さなければ（名前だけの判定では）禁止にしない', () => {
      expect(isForbiddenRequestHeader('x-http-method-override')).toBe(false)
    })

    it('名前だけで禁止のヘッダーは、値に関わらず禁止', () => {
      expect(isForbiddenRequestHeader('cookie', 'a=1')).toBe(true)
      expect(isForbiddenRequestHeader('cookie', '')).toBe(true)
    })
  })
})

describe('forbiddenHeaderHint', () => {
  it('送れるヘッダーなら null', () => {
    expect(forbiddenHeaderHint('Authorization')).toBeNull()
    expect(forbiddenHeaderHint('x-http-method-override', 'PUT')).toBeNull()
  })

  it('Cookie は credentials を include にする代替手段を案内し、任意の値は送れないと明示する', () => {
    for (const name of ['Cookie', 'cookie2']) {
      const hint = forbiddenHeaderHint(name)
      expect(hint).toContain('credentials')
      expect(hint).toContain('include')
      expect(hint).toContain('任意の値の Cookie は送れません')
    }
  })

  it('それ以外は、指定した名前を引用して「指定しても送信されない」と示す', () => {
    const hint = forbiddenHeaderHint('  Origin ')
    expect(hint).toContain('「Origin」')
    expect(hint).toContain('送信されません')
    // プロキシ経由でも同じ（dev-proxy も落とす）ことを伝える
    expect(hint).toContain(`${PROXY_NAME}経由でも`)
  })

  it('メソッド上書きは、禁止メソッドを値にしたときだけ案内する', () => {
    expect(forbiddenHeaderHint('X-HTTP-Method-Override', 'TRACE')).toContain(
      'X-HTTP-Method-Override',
    )
    expect(forbiddenHeaderHint('X-HTTP-Method-Override', 'PUT')).toBeNull()
  })
})
