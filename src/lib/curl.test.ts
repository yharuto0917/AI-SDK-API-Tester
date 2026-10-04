import { describe, expect, it } from 'vitest'
import { isSensitiveHeaderName, maskHeaders, maskSecretValue, toCurl } from '@/lib/curl'

describe('maskHeaders', () => {
  it('Bearer / Basic はスキーム + •••• + 末尾 4 文字（十分長い資格情報のみ）', () => {
    expect(maskHeaders({ authorization: 'Bearer sk-abcdefghijklmnop1234' })).toEqual({
      authorization: 'Bearer ••••1234',
    })
    expect(maskHeaders({ Authorization: 'Basic dXNlcjpwYXNzd29yZA==' })).toEqual({
      Authorization: 'Basic ••••ZA==',
    })
  })

  it('スキームの大文字小文字は元のまま保つ', () => {
    expect(maskHeaders({ authorization: 'bearer sk-abcdefghijklmnop1234' }).authorization).toBe(
      'bearer ••••1234',
    )
  })

  it('20 文字未満の資格情報は •••• のみ（末尾を出すと推測材料になる）', () => {
    // 12 文字でも末尾 4 文字は全体の 3 分の 1、9 文字なら 44%
    expect(maskHeaders({ authorization: 'Bearer abcdefghijkl' }).authorization).toBe('Bearer ••••')
    expect(maskHeaders({ authorization: 'Bearer 123456789' }).authorization).toBe('Bearer ••••')
    expect(maskHeaders({ authorization: 'Bearer abc' }).authorization).toBe('Bearer ••••')
    expect(maskHeaders({ authorization: `Bearer ${'a'.repeat(19)}` }).authorization).toBe(
      'Bearer ••••',
    )
  })

  it('20 文字ちょうどから末尾 4 文字を出す', () => {
    expect(maskHeaders({ authorization: `Bearer ${'a'.repeat(16)}wxyz` }).authorization).toBe(
      'Bearer ••••wxyz',
    )
  })

  it('スキームが無い機密値は全体を同じ規則でマスクする', () => {
    expect(maskHeaders({ 'x-api-key': 'sk-1234567890abcdefghij' })).toEqual({
      'x-api-key': '••••ghij',
    })
    expect(maskHeaders({ 'x-api-key': 'sk-1234567890abcd' })).toEqual({ 'x-api-key': '••••' })
    expect(maskHeaders({ 'x-api-key': 'short' })).toEqual({ 'x-api-key': '••••' })
  })

  it('スキームだけで資格情報が無い値は全体をマスクする', () => {
    expect(maskHeaders({ authorization: 'Bearer' }).authorization).toBe('••••')
  })

  it.each([
    'authorization',
    'Proxy-Authorization',
    'cookie',
    'Cookie',
    'set-cookie',
    'x-api-key',
    'api-key',
    'API-KEY',
  ])('固定の機密ヘッダー %s をマスクする', (name) => {
    const masked = maskHeaders({ [name]: 'very-secret-value-1234' })
    expect(masked[name]).toBe('••••1234')
  })

  it.each([
    'x-auth-token',
    'X-Access-Token',
    'x-client-secret',
    'x-password',
    'x-apikey',
    'my-api-key',
    // 認証ヘッダーは名前が自由。実際のサービスで使われている名前を取りこぼさない
    'x-authorization',
    'x-auth',
    'Ocp-Apim-Subscription-Key',
    'x-access-key',
    'X-Functions-Key',
    'x-vercel-protection-bypass',
    'x-session-id',
    'x-credentials',
    'x-hub-signature-256',
    'x-amz-security-token',
    'x-passwd',
    'x-jwt-assertion',
  ])('名前から認証情報と分かる %s をマスクする', (name) => {
    expect(maskHeaders({ [name]: 'very-secret-value-1234' })[name]).toBe('••••1234')
  })

  it('短い値は、名前が一般的でないヘッダーでも全部隠す', () => {
    expect(maskHeaders({ 'x-token-9chars': 'abcdefghi' })).toEqual({ 'x-token-9chars': '••••' })
  })

  it('機密でないヘッダーはそのまま、キーの大文字小文字も保つ', () => {
    const headers = { 'Content-Type': 'application/json', 'X-Trace-Id': 'abc-123' }
    expect(maskHeaders(headers)).toEqual(headers)
  })

  it('空の値は空のまま', () => {
    expect(maskHeaders({ authorization: '' })).toEqual({ authorization: '' })
  })

  it('入力を破壊しない', () => {
    const headers = { authorization: 'Bearer abcdefghijkl' }
    const masked = maskHeaders(headers)
    expect(headers.authorization).toBe('Bearer abcdefghijkl')
    expect(masked).not.toBe(headers)
  })
})

describe('maskSecretValue', () => {
  it('maskHeaders と同じ規則: 20 文字未満は •••• のみ、20 文字以上は •••• + 末尾 4 文字', () => {
    expect(maskSecretValue('short')).toBe('••••')
    expect(maskSecretValue('a'.repeat(19))).toBe('••••')
    expect(maskSecretValue(`${'a'.repeat(16)}wxyz`)).toBe('••••wxyz')
  })

  it('Bearer / Basic は認証方式を残して資格情報だけを隠す', () => {
    expect(maskSecretValue('Bearer abc')).toBe('Bearer ••••')
    expect(maskSecretValue('basic dXNlcjpwYXNzd29yZDEyMzQ1Njc4OQ==')).toBe('basic ••••OQ==')
    // 方式の名前だけなら隠す資格情報が無いので、全体を隠す
    expect(maskSecretValue('Bearer')).toBe('••••')
  })

  it('空文字は空のまま', () => {
    expect(maskSecretValue('')).toBe('')
  })

  it('名前の判定を通らなくても、渡された値はかならず隠す', () => {
    expect(maskSecretValue('plain-value-not-a-header')).toBe('••••ader')
    // maskHeaders は名前が機密でなければ素通しする。値だけを隠したい場面（URL・本文）はこちらを使う
    expect(maskHeaders({ 'x-trace-id': 'plain-value-not-a-header' })['x-trace-id']).toBe(
      'plain-value-not-a-header',
    )
  })

  it('maskHeaders は、機密ヘッダーの値を maskSecretValue と同じ結果にする', () => {
    for (const value of [
      '',
      'Bearer abc',
      'Bearer sk-abcdefghijklmnop1234',
      'tiny',
      'x'.repeat(40),
    ]) {
      expect(maskHeaders({ authorization: value }).authorization).toBe(maskSecretValue(value))
    }
  })
})

describe('isSensitiveHeaderName', () => {
  it('maskHeaders と同じ判定を公開する（設定画面の「認証ヘッダー」表示と揃えるため）', () => {
    expect(isSensitiveHeaderName('Ocp-Apim-Subscription-Key')).toBe(true)
    expect(isSensitiveHeaderName('Authorization')).toBe(true)
    expect(isSensitiveHeaderName('content-type')).toBe(false)
    expect(isSensitiveHeaderName('x-trace-id')).toBe(false)
    expect(isSensitiveHeaderName('keep-alive')).toBe(false)
  })
})

describe('toCurl', () => {
  const base = {
    method: 'POST',
    targetUrl: 'http://localhost:28787/api/chat',
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: '{"a":1}',
  }

  it('複数行の curl コマンドを組み立てる', () => {
    expect(toCurl(base)).toBe(
      [
        "curl -N -X POST 'http://localhost:28787/api/chat' \\",
        "  -H 'content-type: application/json' \\",
        `  --data-raw '{"a":1}'`,
      ].join('\n'),
    )
  })

  it('GET は -X を省略し、ヘッダーも body も無ければ 1 行', () => {
    expect(
      toCurl({
        method: 'GET',
        targetUrl: 'https://example.com/x',
        requestHeaders: {},
        requestBody: undefined,
      }),
    ).toBe("curl -N 'https://example.com/x'")
  })

  it('メソッドは大文字化する', () => {
    expect(toCurl({ ...base, method: 'put' })).toContain('-X PUT ')
  })

  it('GET に body がある場合は -X GET を明示する（curl が POST に変えるため）', () => {
    expect(toCurl({ ...base, method: 'GET' })).toContain("curl -N -X GET 'http")
  })

  it('HEAD は -I を使う', () => {
    const curl = toCurl({ ...base, method: 'HEAD', requestBody: undefined })
    expect(curl.startsWith("curl -N -I 'http://localhost:28787/api/chat'")).toBe(true)
    expect(curl).not.toContain('-X')
  })

  it('body が空文字・未定義なら --data-raw を付けない', () => {
    expect(toCurl({ ...base, requestBody: '' })).not.toContain('--data-raw')
    expect(toCurl({ ...base, requestBody: undefined })).not.toContain('--data-raw')
  })

  it('既定で認証情報をマスクし、maskSecrets: false で生の値を出す', () => {
    const entry = {
      ...base,
      requestHeaders: { authorization: 'Bearer sk-abcdefghijklmnop1234', 'x-keep': 'plain' },
    }
    const masked = toCurl(entry)
    expect(masked).toContain("-H 'authorization: Bearer ••••1234'")
    expect(masked).not.toContain('abcdefghijklmnop')
    expect(masked).toContain("-H 'x-keep: plain'")

    expect(toCurl(entry, { maskSecrets: true })).toBe(masked)
    expect(toCurl(entry, { maskSecrets: false })).toContain(
      "-H 'authorization: Bearer sk-abcdefghijklmnop1234'",
    )
  })

  it("シングルクォートを '\\'' でエスケープする（URL・ヘッダー・body）", () => {
    const curl = toCurl({
      method: 'POST',
      targetUrl: "http://example.com/it's",
      requestHeaders: { 'x-note': "it's" },
      requestBody: `{"q":"it's"}`,
    })
    expect(curl).toContain("'http://example.com/it'\\''s'")
    expect(curl).toContain("-H 'x-note: it'\\''s'")
    expect(curl).toContain(`--data-raw '{"q":"it'\\''s"}'`)
  })

  it('改行を含む body もそのままクォートに収める', () => {
    const curl = toCurl({ ...base, requestBody: '{\n  "a": 1\n}' })
    expect(curl).toContain('--data-raw \'{\n  "a": 1\n}\'')
  })

  it('特殊なメソッド名はクォートする', () => {
    expect(toCurl({ ...base, method: "x'y" })).toContain("-X 'X'\\''Y'")
  })

  it('ヘッダーの順序を保つ', () => {
    const curl = toCurl({
      ...base,
      requestHeaders: { 'x-b': '2', 'x-a': '1' },
      requestBody: undefined,
    })
    expect(curl.indexOf('x-b')).toBeLessThan(curl.indexOf('x-a'))
  })

  it('元の requestHeaders を破壊しない', () => {
    const requestHeaders = { authorization: 'Bearer abcdefghijkl' }
    toCurl({ ...base, requestHeaders })
    expect(requestHeaders.authorization).toBe('Bearer abcdefghijkl')
  })

  describe('body をログの保持上限で切り詰めていたとき', () => {
    const truncated = {
      ...base,
      requestBody: '{"messages":[{"role":"user","parts":[',
      requestBodyTruncated: true,
    }

    it('実際の送信内容を再現しない旨のコメント行を、コマンドの前に置く', () => {
      const curl = toCurl(truncated)
      const [note, ...rest] = curl.split('\n')
      expect(note?.startsWith('# 注意:')).toBe(true)
      expect(note).toContain('再現しません')
      // コメントはコマンドの外。コマンド本体（継続行を含む）は切り詰めなしのときと同じ
      expect(rest.join('\n')).toBe(toCurl({ ...truncated, requestBodyTruncated: undefined }))
      expect(rest[0]?.startsWith('curl -N')).toBe(true)
    })

    it('コメントを継続行（行末の \\）の途中に差し込まない', () => {
      const lines = toCurl(truncated).split('\n')
      const commentLines = lines.filter((line) => line.trimStart().startsWith('#'))
      expect(commentLines).toHaveLength(1)
      expect(lines.indexOf(commentLines[0] ?? '')).toBe(0)
    })

    it('マスクの有無に関わらず付く', () => {
      expect(toCurl(truncated, { maskSecrets: false }).startsWith('# 注意:')).toBe(true)
    })

    it('切り詰めていなければ（false・未指定でも）付けない', () => {
      expect(toCurl({ ...base, requestBodyTruncated: false })).toBe(toCurl(base))
      expect(toCurl(base)).not.toContain('#')
    })
  })
})
