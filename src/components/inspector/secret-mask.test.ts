import { describe, expect, it } from 'vitest'
import {
  collectHeaderSecrets,
  createSecretSet,
  isSensitiveKey,
  maskJsonSecrets,
  maskRequest,
  maskResponseText,
  maskSecretValue,
  maskStreamEvent,
  maskUrlForDisplay,
  maskUrlSecrets,
  maskValueTree,
  replaceSecretsInHeaders,
} from '@/components/inspector/secret-mask'
import type { StreamEvent } from '@/types'

const KEY = 'sk-live-SECRETSECRET'
const GOOGLE_KEY = 'AIzaSyDUMMYDUMMYDUMMY'

/**
 * 伏せた結果を組み立てる略記。他の期待値を読みやすくするためだけのもので、これ自体は規則を固定しない
 * （しきい値・Bearer の扱いは「maskSecretValue の形式（リテラルで固定）」のテストが担う）。
 */
const mask = maskSecretValue

describe('isSensitiveKey', () => {
  it.each([
    'key',
    'api_key',
    'apiKey',
    'api-key',
    'x-goog-api-key',
    'token',
    'access_token',
    'accessToken',
    'refresh_token',
    'client_secret',
    'password',
    'Authorization',
    'cookie',
    'X-Amz-Signature',
    'sig',
    'auth',
    'passphrase',
    'sessionId',
    'sid',
  ])('%s は秘匿キー', (name) => {
    expect(isSensitiveKey(name)).toBe(true)
  })

  it.each([
    'max_tokens',
    'maxOutputTokens',
    'totalTokens',
    'inputTokens',
    'tokenizer',
    'model',
    'messages',
    'author',
    'keyword',
    'monkey',
    '',
  ])('%s は秘匿キーではない', (name) => {
    expect(isSensitiveKey(name)).toBe(false)
  })
})

describe('maskSecretValue', () => {
  it('伏せ字から始まり、元の値を丸ごとは残さない', () => {
    for (const value of [KEY, 'short', 'a'.repeat(64)]) {
      const masked = maskSecretValue(value)
      expect(masked.startsWith('••••')).toBe(true)
      expect(masked).not.toContain(value)
    }
  })

  it('Bearer / Basic は認証方式を残す', () => {
    expect(maskSecretValue(`Bearer ${KEY}`)).toBe(`Bearer ${maskSecretValue(KEY)}`)
    expect(maskSecretValue(`Bearer ${KEY}`)).not.toContain(KEY)
  })

  it('空文字は空のまま', () => {
    expect(maskSecretValue('')).toBe('')
  })
})

describe('maskSecretValue の形式（リテラルで固定）', () => {
  // 期待値を maskSecretValue 自身から作ると、しきい値（20 文字）や形式を変えてもテストが落ちない。
  // ここは書き下した文字列だけで比べる。
  it('空文字は空のまま', () => {
    expect(maskSecretValue('')).toBe('')
  })

  it('19 文字までは全部隠し、20 文字から末尾 4 文字を残す', () => {
    expect(maskSecretValue('a')).toBe('••••')
    expect(maskSecretValue('abcdefghijklmnopqrs')).toBe('••••') // 19 文字
    expect(maskSecretValue('abcdefghijklmnopqrst')).toBe('••••qrst') // 20 文字
    expect(maskSecretValue('abcdefghijklmnopqrstu')).toBe('••••rstu') // 21 文字
  })

  it('Bearer / Basic は認証方式を残し、資格情報だけに同じしきい値を当てる', () => {
    expect(maskSecretValue('Bearer abcdefghijklmnopqrs')).toBe('Bearer ••••') // 資格情報 19 文字
    expect(maskSecretValue('Bearer abcdefghijklmnopqrst')).toBe('Bearer ••••qrst') // 20 文字
    expect(maskSecretValue('Basic abcdefghijklmnopqrs')).toBe('Basic ••••')
    expect(maskSecretValue('Basic dXNlcjpwYXNzd29yZA==')).toBe('Basic ••••ZA==')
    expect(maskSecretValue('Bearer abc')).toBe('Bearer ••••')
  })

  it('認証方式の大文字小文字は元のまま残す', () => {
    expect(maskSecretValue('bearer abc')).toBe('bearer ••••')
    expect(maskSecretValue('BASIC abcdefghijklmnopqrstuvwx')).toBe('BASIC ••••uvwx')
  })

  it('方式名だけ・方式名 + 空白だけの値は、方式を残さず値全体として隠す', () => {
    expect(maskSecretValue('Bearer')).toBe('••••')
    expect(maskSecretValue('Bearer ')).toBe('••••')
  })

  it('資格情報に空白が含まれていても、方式の後ろ全体を 1 つの資格情報として隠す', () => {
    expect(maskSecretValue('Bearer abc def')).toBe('Bearer ••••')
  })

  it('各所（URL・JSON・値の木・既知の値）が同じ形式で伏せる', () => {
    const key = 'sk-live-SECRETSECRET' // 20 文字
    const short = 'sk-live-SECRETSEC' // 17 文字
    expect(maskUrlSecrets(`/v1?api_key=${key}&token=${short}`)).toBe(
      '/v1?api_key=••••CRET&token=••••',
    )
    expect(maskJsonSecrets(`{"apiKey":"${key}","password":"${short}"}`)).toBe(
      '{"apiKey":"••••CRET","password":"••••"}',
    )
    expect(maskValueTree({ token: key, secret: short }, createSecretSet([]))).toEqual({
      token: '••••CRET',
      secret: '••••',
    })
    expect(createSecretSet([key]).replace(`echo ${key}`)).toBe('echo ••••CRET')
  })
})

describe('maskUrlSecrets', () => {
  it('クエリの秘匿キーの値だけを伏せる', () => {
    expect(
      maskUrlSecrets(`https://api.example.com/v1/chat?api_key=${KEY}&model=gpt&key=${GOOGLE_KEY}`),
    ).toBe(`https://api.example.com/v1/chat?api_key=${mask(KEY)}&model=gpt&key=${mask(GOOGLE_KEY)}`)
  })

  it('max_tokens などの使用量のクエリは伏せない', () => {
    const url = 'https://api.example.com/v1?max_tokens=100&stream=true'
    expect(maskUrlSecrets(url)).toBe(url)
  })

  it('URL エンコードされたキー名・値も判定し、値は元の文字列で sink に残す', () => {
    const sink: string[] = []
    expect(maskUrlSecrets('/api?access%5Ftoken=a%2Fb%2Fc%2Fd%2Fe%2Ff', sink)).toBe(
      `/api?access%5Ftoken=${mask('a/b/c/d/e/f')}`,
    )
    expect(sink).toEqual(['a/b/c/d/e/f'])
  })

  it('user:pass@ のパスワードを伏せる（ユーザー名は残す）', () => {
    expect(maskUrlSecrets('https://alice:hunter2hunter2@example.com:8443/x?y=1')).toBe(
      'https://alice:••••@example.com:8443/x?y=1',
    )
  })

  it('パスワードの無い userinfo（token@host）は丸ごと伏せる', () => {
    expect(maskUrlSecrets('https://ghp_abcdef123456@github.com/x')).toBe(
      'https://••••@github.com/x',
    )
  })

  it('フラグメントの秘匿キーも伏せる（OAuth のインプリシットフロー）', () => {
    expect(maskUrlSecrets('https://app.example.com/cb#access_token=abcdef1234567890&state=x')).toBe(
      `https://app.example.com/cb#access_token=${mask('abcdef1234567890')}&state=x`,
    )
  })

  it('相対パス・壊れた URL・クエリなしは、伏せる部分が無ければそのまま返す', () => {
    for (const url of [
      '/api/chat',
      'not a url',
      'https://example.com',
      'https://e.com/?',
      '?a=1',
    ]) {
      expect(maskUrlSecrets(url)).toBe(url)
    }
  })

  it('値が空のキーは何もしない', () => {
    expect(maskUrlSecrets('/api?token=&key')).toBe('/api?token=&key')
  })
})

describe('maskJsonSecrets', () => {
  it('秘匿キーの値だけを伏せ、書式は 1 文字も変えない', () => {
    const text = `{ "model" : "gpt",\n  "apiKey":"${KEY}", "max_tokens": 1234,"n":12345678901234567890 }`
    expect(maskJsonSecrets(text)).toBe(
      `{ "model" : "gpt",\n  "apiKey":"${mask(KEY)}", "max_tokens": 1234,"n":12345678901234567890 }`,
    )
  })

  it('入れ子・配列の中の秘匿キーも伏せる', () => {
    const text = `{"a":{"b":[{"password":"hunter2hunter2"}]},"headers":{"Authorization":"Bearer ${KEY}"}}`
    expect(maskJsonSecrets(text)).toBe(
      `{"a":{"b":[{"password":"${mask('hunter2hunter2')}"}]},"headers":{"Authorization":"${mask(`Bearer ${KEY}`)}"}}`,
    )
  })

  it('秘匿キーの値がオブジェクト・配列なら、中の値はキーによらずすべて伏せる', () => {
    expect(maskJsonSecrets('{"credentials":{"user":"alice-long-name","n":123456},"x":1}')).toBe(
      `{"credentials":{"user":"${mask('alice-long-name')}","n":"••••"},"x":1}`,
    )
    expect(maskJsonSecrets('{"secrets":["aaaaaaaaaa","bbbbbbbbbb"],"ok":["fine"]}')).toBe(
      `{"secrets":["${mask('aaaaaaaaaa')}","${mask('bbbbbbbbbb')}"],"ok":["fine"]}`,
    )
  })

  it('キーの文字列に " や \\ が含まれていても、値の境界を取り違えない', () => {
    const text = '{"we\\"ird":"keep","token":"abc\\\\\\"defghijkl","after":"keep"}'
    const masked = maskJsonSecrets(text)
    expect(masked).toContain('"we\\"ird":"keep"')
    expect(masked).toContain('"after":"keep"')
    expect(masked).not.toContain('defghijkl')
  })

  it('エスケープされた値は元の文字列に戻して sink に足す', () => {
    const sink: string[] = []
    maskJsonSecrets('{"token":"a\\u0041\\n\\"bcdefgh"}', sink)
    expect(sink).toEqual(['aA\n"bcdefgh'])
  })

  it('true / false / null と空文字は伏せない', () => {
    const text = '{"token":null,"password":"","secret":false,"key":true}'
    expect(maskJsonSecrets(text)).toBe(text)
  })

  it('数値の秘匿値は文字列に置き換える', () => {
    expect(maskJsonSecrets('{"pin":1,"password":987654321}')).toBe('{"pin":1,"password":"••••"}')
  })

  it('秘匿キーが無い JSON は同じ文字列を返す', () => {
    const text = '{"a":[1,2,{"b":"c"}],"d":"e"}'
    expect(maskJsonSecrets(text)).toBe(text)
  })

  it('壊れた JSON・途中で切れた JSON でも落ちず、読めた範囲は伏せる', () => {
    expect(() => maskJsonSecrets('{"token":"abcdefgh')).not.toThrow()
    expect(maskJsonSecrets('{"apiKey":"abcdefghijkl","x":')).toBe(
      `{"apiKey":"${mask('abcdefghijkl')}","x":`,
    )
    expect(maskJsonSecrets('}}]]{{"a"::,,')).toBe('}}]]{{"a"::,,')
    expect(maskJsonSecrets('')).toBe('')
  })

  it('数 MB の文字列を含む本文も素早く処理する', () => {
    const big = 'A'.repeat(5_000_000)
    const text = `{"files":[{"url":"data:image/png;base64,${big}"}],"apiKey":"${KEY}"}`
    const started = performance.now()
    const masked = maskJsonSecrets(text)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(masked.endsWith(`"apiKey":"${mask(KEY)}"}`)).toBe(true)
    expect(masked.length).toBe(text.length - KEY.length + mask(KEY).length)
  })
})

describe('collectHeaderSecrets', () => {
  it('秘匿ヘッダーの値と、Bearer を除いたトークンを集める', () => {
    expect(
      collectHeaderSecrets({
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      }),
    ).toEqual([`Bearer ${KEY}`, KEY])
  })

  it('Cookie は個々の値も集める', () => {
    expect(collectHeaderSecrets({ Cookie: 'sid=abcdef123456; theme=dark-mode-x' })).toEqual([
      'sid=abcdef123456; theme=dark-mode-x',
      'abcdef123456',
      'dark-mode-x',
    ])
  })

  it('lib の名前判定（広い規則）に従い、名前が自由な認証ヘッダーも集める', () => {
    expect(
      collectHeaderSecrets({
        'x-vercel-protection-bypass': 'bypass-value-123',
        'Ocp-Apim-Subscription-Key': 'subscription-key-456',
        'x-functions-key': 'functions-key-789',
      }),
    ).toEqual(['bypass-value-123', 'subscription-key-456', 'functions-key-789'])
  })

  it('秘匿でない名前のヘッダーは、値が長くても集めない', () => {
    expect(
      collectHeaderSecrets({
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (long-user-agent-string)',
        Accept: 'text/event-stream',
      }),
    ).toEqual([])
  })

  it('空の値と、認証方式の名前だけの値は集めない', () => {
    expect(collectHeaderSecrets({ Authorization: '', 'x-api-key': '' })).toEqual([])
    expect(collectHeaderSecrets({ Authorization: 'Bearer' })).toEqual([])
    expect(collectHeaderSecrets({ Authorization: 'bearer ' })).toEqual([])
  })
})

describe('createSecretSet', () => {
  it('同じ値を、JSON エスケープ・URL エンコードされた形も含めて伏せる', () => {
    const secrets = createSecretSet(['p"ss\\word/123456'])
    const masked = maskSecretValue('p"ss\\word/123456')
    expect(secrets.replace('raw p"ss\\word/123456 end')).toBe(`raw ${masked} end`)
    expect(secrets.replace('{"a":"p\\"ss\\\\word/123456"}')).toBe(`{"a":"${masked}"}`)
    expect(secrets.replace('?k=p%22ss%5Cword%2F123456')).toBe(`?k=${masked}`)
  })

  it('短すぎる値は置換しない', () => {
    expect(createSecretSet(['abc', 'true']).replace('abc true')).toBe('abc true')
  })

  it('長い値を先に置換して、短い値に食われないようにする', () => {
    const secrets = createSecretSet(['abcdef', 'abcdefghijkl'])
    expect(secrets.replace('abcdefghijkl')).toBe(mask('abcdefghijkl'))
  })
})

describe('maskRequest', () => {
  const entry = {
    targetUrl: `https://api.example.com/v1/chat?api_key=${KEY}&key=${GOOGLE_KEY}`,
    requestHeaders: { authorization: 'Bearer sk-header-token-9999' },
    requestBody: `{"apiKey":"${KEY}","messages":[]}`,
  }

  it('URL と本文を伏せ、そこで見つけた値を既知の値にまとめる', () => {
    const { url, body, secrets } = maskRequest(entry)
    expect(url).toBe(`https://api.example.com/v1/chat?api_key=${mask(KEY)}&key=${mask(GOOGLE_KEY)}`)
    expect(body).toBe(`{"apiKey":"${mask(KEY)}","messages":[]}`)
    // ヘッダーの値も、URL・本文で見つけた値も、他の場所に現れたら伏せる
    expect(secrets.replace(`echo ${KEY} ${GOOGLE_KEY} sk-header-token-9999`)).toBe(
      `echo ${mask(KEY)} ${mask(GOOGLE_KEY)} ${mask('sk-header-token-9999')}`,
    )
  })

  it('本文が無ければ body は undefined', () => {
    expect(maskRequest({ ...entry, requestBody: undefined }).body).toBeUndefined()
  })

  it('フォーム形式の本文は秘匿キーの値だけを伏せる', () => {
    const { body } = maskRequest({ ...entry, requestBody: `grant=x&client_secret=${KEY}&q=hello` })
    expect(body).toBe(`grant=x&client_secret=${mask(KEY)}&q=hello`)
  })

  it('JSON でもフォームでもない本文は、既知の値の置換だけを行う', () => {
    const { body } = maskRequest({
      ...entry,
      requestBody: `prompt: my key is ${KEY} and token=hello\nline2`,
    })
    expect(body).toBe(`prompt: my key is ${mask(KEY)} and token=hello\nline2`)
  })
})

describe('maskUrlForDisplay', () => {
  it('URL のクエリと、ヘッダーの認証情報と同じ値（パスに入れた場合）を伏せる', () => {
    expect(
      maskUrlForDisplay('/bot-sk-header-token-9999/send?token=abcdef1234567890', {
        authorization: 'Bearer sk-header-token-9999',
      }),
    ).toBe(`/bot-${mask('sk-header-token-9999')}/send?token=${mask('abcdef1234567890')}`)
  })
})

describe('maskResponseText', () => {
  const secrets = createSecretSet([KEY])

  it('JSON 本文は、秘匿キーの値と、既知の値を伏せる（書式は保つ）', () => {
    const text = `{"headers":{"authorization":"Bearer ${KEY}"},\n "echo":"${KEY}","id":12345678901234567890}`
    expect(maskResponseText(text, secrets)).toBe(
      `{"headers":{"authorization":"${mask(`Bearer ${KEY}`)}"},\n "echo":"${mask(KEY)}","id":12345678901234567890}`,
    )
  })

  it('SSE は data: 行の JSON のキーと、既知の値を伏せる', () => {
    const text = [
      'event: x',
      'data: {"type":"tool-input-available","input":{"apiKey":"abcdefghijkl"}}',
      '',
      `data: {"type":"text-delta","delta":"your key is ${KEY}"}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    expect(maskResponseText(text, secrets)).toBe(
      [
        'event: x',
        `data: {"type":"tool-input-available","input":{"apiKey":"${mask('abcdefghijkl')}"}}`,
        '',
        `data: {"type":"text-delta","delta":"your key is ${mask(KEY)}"}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
    )
  })

  it('プレーンテキストは既知の値だけを伏せる', () => {
    expect(maskResponseText(`token=hello ${KEY}`, secrets)).toBe(`token=hello ${mask(KEY)}`)
  })

  it('何も伏せるものが無ければ同じ文字列を返す', () => {
    const text = 'data: {"type":"text-delta","delta":"hello"}\n\n'
    expect(maskResponseText(text, secrets)).toBe(text)
  })
})

describe('maskValueTree / maskStreamEvent', () => {
  const secrets = createSecretSet([KEY])

  it('元の値を書き換えずに、秘匿キーの値と既知の値を伏せた複製を返す', () => {
    const input = {
      type: 'tool-input-available',
      input: { apiKey: 'abcdefghijkl', password: 123456, note: `has ${KEY}`, list: [KEY, 1] },
      usage: { totalTokens: 12, max_tokens: 5 },
    }
    const copy = structuredClone(input)
    expect(maskValueTree(input, secrets)).toEqual({
      type: 'tool-input-available',
      input: {
        apiKey: mask('abcdefghijkl'),
        password: '••••',
        note: `has ${mask(KEY)}`,
        list: [mask(KEY), 1],
      },
      usage: { totalTokens: 12, max_tokens: 5 },
    })
    expect(input).toEqual(copy)
  })

  it('深すぎる入れ子は中身を見ずに伏せる', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 100; i++) deep = { a: deep }
    expect(JSON.stringify(maskValueTree(deep, secrets))).toContain('"••••"')
  })

  it('イベントの raw・data・parseError を伏せる', () => {
    const data = { type: 'x', apiKey: KEY }
    const event: StreamEvent = {
      index: 3,
      atMs: 30,
      kind: 'sse-json',
      type: 'x',
      data,
      raw: JSON.stringify(data),
      parseError: `bad ${KEY}`,
    }
    const masked = maskStreamEvent(event, secrets)
    expect(masked).toEqual({
      ...event,
      raw: `{"type":"x","apiKey":"${mask(KEY)}"}`,
      data: { type: 'x', apiKey: mask(KEY) },
      parseError: `bad ${mask(KEY)}`,
    })
    expect(event.raw).toContain(KEY)
  })

  it('スキーマ不一致の理由に紛れた既知の値も伏せる（無ければ足さない）', () => {
    const event: StreamEvent = {
      index: 0,
      atMs: 0,
      kind: 'sse-json',
      type: 'x',
      data: { type: 'x' },
      raw: '{"type":"x"}',
      schemaError: `「id」が "${KEY}"（使える値: "a"）`,
    }
    expect(maskStreamEvent(event, secrets).schemaError).toBe('「id」が "••••CRET"（使える値: "a"）')
    const plain: StreamEvent = { index: 1, atMs: 0, kind: 'sse-text', raw: 'x' }
    expect('schemaError' in maskStreamEvent(plain, secrets)).toBe(false)
  })

  it('data の無いイベントに data を足さない', () => {
    const event: StreamEvent = { index: 0, atMs: 0, kind: 'text-chunk', raw: `hi ${KEY}` }
    const masked = maskStreamEvent(event, secrets)
    expect('data' in masked).toBe(false)
    expect(masked.raw).toBe(`hi ${mask(KEY)}`)
  })
})

describe('replaceSecretsInHeaders', () => {
  it('名前によらず、値に現れた既知の秘匿値だけを伏せた複製を返す', () => {
    const headers = { 'x-echo': `Bearer ${KEY}`, 'content-type': 'text/event-stream' }
    const copy = { ...headers }
    expect(replaceSecretsInHeaders(headers, createSecretSet([KEY]))).toEqual({
      'x-echo': 'Bearer ••••CRET',
      'content-type': 'text/event-stream',
    })
    expect(headers).toEqual(copy)
  })
})
