import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDevProxyMiddleware, describeError, devProxy } from './dev-proxy.ts'

interface SeenRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function listen(server: Server): Promise<number> {
  // localhost は ::1 に解決され得るので 127.0.0.1 に固定し、ポートは OS に割り当てさせる
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function close(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

let upstream: Server
/** upstream とはポート（= オリジン）だけが違う 2 台目。別オリジンへのリダイレクト用。 */
let otherUpstream: Server
let proxy: Server
let upstreamPort = 0
let otherPort = 0
let proxyPort = 0
let seen: SeenRequest[] = []
let sseGate = deferred()
let hangClosed = deferred()

function upstreamHandler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://upstream')
  void (async () => {
    const body = await readBody(req)
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })

    switch (url.pathname) {
      case '/echo': {
        const status = Number(url.searchParams.get('status') ?? 200)
        res.writeHead(status, {
          'content-type': 'application/json',
          'x-upstream': 'yes',
          'set-cookie': ['session=abc; Path=/', 'other=1'],
        })
        res.end(JSON.stringify({ received: body }))
        return
      }
      case '/gzip':
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
        res.end(gzipSync('{"hello":"gzip"}'))
        return
      case '/redirect': {
        // ?status=307 でステータス、?to=<URL> でリダイレクト先、?nolocation=1 で Location なしにできる
        const status = Number(url.searchParams.get('status') ?? 302)
        const headers: Record<string, string> = {}
        if (url.searchParams.get('nolocation') === null) {
          headers.location = url.searchParams.get('to') ?? '/echo?redirected=1'
        }
        res.writeHead(status, headers)
        res.end()
        return
      }
      case '/loop':
        res.writeHead(302, { location: '/loop' })
        res.end()
        return
      case '/cacheable': {
        const headers: Record<string, string> = {
          'content-type': 'text/plain',
          'cache-control': 'public, max-age=60',
          etag: '"v1"',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
        }
        const vary = url.searchParams.get('vary')
        if (vary !== null) headers.vary = vary
        res.writeHead(200, headers)
        res.end('cached-body')
        return
      }
      case '/sse':
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: first\n\n')
        await sseGate.promise
        res.write('data: second\n\n')
        res.end()
        return
      case '/hang':
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: first\n\n')
        res.on('close', () => hangClosed.resolve())
        return
      case '/cut':
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: first\n\n')
        setTimeout(() => res.socket?.destroy(), 30)
        return
      default:
        res.writeHead(404)
        res.end('not found')
    }
  })()
}

beforeAll(async () => {
  upstream = createServer(upstreamHandler)
  otherUpstream = createServer(upstreamHandler)
  upstreamPort = await listen(upstream)
  otherPort = await listen(otherUpstream)

  const middleware = createDevProxyMiddleware()
  proxy = createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404
      res.end('next')
    })
  })
  proxyPort = await listen(proxy)
})

afterAll(async () => {
  await Promise.all([close(upstream), close(otherUpstream), close(proxy)])
})

beforeEach(() => {
  seen = []
  sseGate = deferred()
  hangClosed = deferred()
})

const target = (path: string) => `http://127.0.0.1:${upstreamPort}${path}`
const otherTarget = (path: string) => `http://127.0.0.1:${otherPort}${path}`

function startRequest(opts: {
  method?: string
  path?: string
  headers?: Record<string, string | string[]>
}): { req: ClientRequest; response: Promise<IncomingMessage> } {
  const req = httpRequest({
    host: '127.0.0.1',
    port: proxyPort,
    method: opts.method ?? 'GET',
    path: opts.path ?? '/__proxy',
    headers: opts.headers,
  })
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve)
    req.on('error', reject)
  })
  return { req, response }
}

async function send(opts: {
  method?: string
  path?: string
  headers?: Record<string, string | string[]>
  body?: string
  /** true なら content-length を付けず chunked で送る */
  chunked?: boolean
}): Promise<RawResponse> {
  const headers = { ...opts.headers }
  if (opts.body !== undefined && opts.chunked !== true) {
    headers['content-length'] = String(Buffer.byteLength(opts.body))
  }
  const { req, response } = startRequest({ ...opts, headers })
  if (opts.chunked === true && opts.body !== undefined) {
    // end(body) だけだと Node が content-length を自動で付けてしまう。先に write して本当の chunked にする
    const half = Math.ceil(opts.body.length / 2)
    req.write(opts.body.slice(0, half))
    req.end(opts.body.slice(half))
  } else {
    req.end(opts.body)
  }
  const res = await response
  const body = await readBody(res)
  return { status: res.statusCode ?? 0, headers: res.headers, body }
}

/** x-proxy-target を付けた転送リクエスト。 */
function forward(
  targetUrl: string,
  opts: {
    method?: string
    headers?: Record<string, string | string[]>
    body?: string
    chunked?: boolean
  } = {},
) {
  return send({
    ...opts,
    headers: { 'x-proxy-target': targetUrl, ...opts.headers },
  })
}

describe('生存確認 / ルーティング', () => {
  it('GET /__proxy（ターゲットなし）は 200 とプロキシ識別 JSON を返す', async () => {
    const res = await send({})
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(JSON.parse(res.body)).toEqual({ proxy: 'ai-sdk-tester', version: 1 })
    expect(res.headers['x-proxy-error']).toBeUndefined()
  })

  it('/__proxy 以外のパスは next() に渡す', async () => {
    const res = await send({ path: '/api/chat' })
    expect(res.status).toBe(404)
    expect(res.body).toBe('next')
  })

  it('クエリ文字列つきでも /__proxy として扱う', async () => {
    const res = await send({ path: '/__proxy?x=1' })
    expect(res.status).toBe(200)
  })

  it('GET でも x-proxy-target があれば生存確認ではなく転送する', async () => {
    const res = await forward(target('/echo'))
    expect(res.status).toBe(200)
    expect(res.headers['x-upstream']).toBe('yes')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe('GET')
  })
})

describe('転送', () => {
  it('メソッド・パス・クエリ・body・ヘッダーをそのまま転送する', async () => {
    const res = await forward(target('/echo?a=1&b=two'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret-token',
        'x-custom': 'hello',
      },
      body: JSON.stringify({ messages: [{ role: 'user', text: 'こんにちは' }] }),
    })

    expect(res.status).toBe(200)
    const request = seen[0]
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/echo?a=1&b=two')
    expect(request?.body).toBe(JSON.stringify({ messages: [{ role: 'user', text: 'こんにちは' }] }))
    expect(request?.headers.authorization).toBe('Bearer secret-token')
    expect(request?.headers['x-custom']).toBe('hello')
    expect(request?.headers['content-type']).toBe('application/json')
    // 上流には転送先のホストが送られる（プロキシ自身のホストではない）
    expect(request?.headers.host).toBe(`127.0.0.1:${upstreamPort}`)
  })

  it('content-length なし（chunked）のリクエスト body も転送する', async () => {
    const res = await forward(target('/echo'), {
      method: 'PATCH',
      headers: { 'content-type': 'text/plain' },
      body: 'no-length',
      chunked: true,
    })
    expect(res.status).toBe(200)
    expect(seen[0]?.method).toBe('PATCH')
    expect(seen[0]?.body).toBe('no-length')
  })

  it('body のない POST / DELETE はそのまま空で転送する', async () => {
    await forward(target('/echo'), { method: 'POST' })
    await forward(target('/echo'), { method: 'DELETE' })
    expect(seen.map((r) => [r.method, r.body])).toEqual([
      ['POST', ''],
      ['DELETE', ''],
    ])
  })

  it('転送先のステータス・ヘッダー・body をそのまま返す', async () => {
    const res = await forward(target('/echo?status=418'), { method: 'POST', body: 'teapot' })
    expect(res.status).toBe(418)
    expect(res.headers['x-upstream']).toBe('yes')
    expect(res.headers['content-type']).toBe('application/json')
    expect(JSON.parse(res.body)).toEqual({ received: 'teapot' })
    // プロキシ自身のエラーではないのでマーカーは付かない
    expect(res.headers['x-proxy-error']).toBeUndefined()
  })

  it('転送先の 404 もプロキシのエラー扱いにしない', async () => {
    const res = await forward(target('/missing'))
    expect(res.status).toBe(404)
    expect(res.body).toBe('not found')
    expect(res.headers['x-proxy-error']).toBeUndefined()
  })

  it('転送先の content-encoding を展開済みの body として返し、不整合なヘッダーを除く', async () => {
    const res = await forward(target('/gzip'))
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ hello: 'gzip' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['content-length']).toBeUndefined()
  })

  it('転送先の set-cookie は開発サーバーのクッキーに混ぜない', async () => {
    const res = await forward(target('/echo'))
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('リダイレクトは追従する', async () => {
    const res = await forward(target('/redirect'))
    expect(res.status).toBe(200)
    expect(seen.map((r) => r.url)).toEqual(['/redirect', '/echo?redirected=1'])
  })
})

describe('リダイレクト', () => {
  const payload = JSON.stringify({ messages: [{ role: 'user', text: 'こんにちは' }] })
  const jsonHeaders = { 'content-type': 'application/json' }
  const redirectTo = (to: string, status = 307) =>
    target(`/redirect?status=${status}&to=${encodeURIComponent(to)}`)

  it.each([301, 302, 303])(
    'POST + %s は GET に切り替え、body と body 用ヘッダーを捨てて追従する',
    async (status) => {
      const res = await forward(target(`/redirect?status=${status}`), {
        method: 'POST',
        headers: jsonHeaders,
        body: payload,
      })

      expect(res.status).toBe(200)
      expect(res.headers['x-proxy-error']).toBeUndefined()
      expect(seen.map((r) => [r.method, r.url, r.body])).toEqual([
        ['POST', `/redirect?status=${status}`, payload],
        ['GET', '/echo?redirected=1', ''],
      ])
      expect(seen[1]?.headers['content-type']).toBeUndefined()
    },
  )

  it.each([307, 308])(
    'POST + %s は同じメソッド・body・ヘッダーで再送して追従する',
    async (status) => {
      const res = await forward(target(`/redirect?status=${status}`), {
        method: 'POST',
        headers: { ...jsonHeaders, authorization: 'Bearer same-origin' },
        body: payload,
      })

      expect(res.status).toBe(200)
      expect(res.headers['x-proxy-error']).toBeUndefined()
      expect(JSON.parse(res.body)).toEqual({ received: payload })
      expect(seen.map((r) => [r.method, r.url, r.body])).toEqual([
        ['POST', `/redirect?status=${status}`, payload],
        ['POST', '/echo?redirected=1', payload],
      ])
      expect(seen[1]?.headers['content-type']).toBe('application/json')
      // 同じオリジンへのリダイレクトなら Authorization も引き継ぐ
      expect(seen[1]?.headers.authorization).toBe('Bearer same-origin')
    },
  )

  it('POST 以外の 302 は GET に切り替えず、body を再送する', async () => {
    const res = await forward(target('/redirect?status=302'), { method: 'PUT', body: payload })
    expect(res.status).toBe(200)
    expect(seen.map((r) => [r.method, r.body])).toEqual([
      ['PUT', payload],
      ['PUT', payload],
    ])
  })

  it('body のない POST の 307 もそのまま再送して追従する', async () => {
    const res = await forward(target('/redirect?status=307'), { method: 'POST' })
    expect(res.status).toBe(200)
    expect(seen.map((r) => [r.method, r.url, r.body])).toEqual([
      ['POST', '/redirect?status=307', ''],
      ['POST', '/echo?redirected=1', ''],
    ])
  })

  it('chunked の body でも、GET に切り替わる 302 なら追従できる', async () => {
    const res = await forward(target('/redirect?status=302'), {
      method: 'POST',
      body: payload,
      chunked: true,
    })
    expect(res.status).toBe(200)
    expect(seen.map((r) => [r.method, r.url])).toEqual([
      ['POST', '/redirect?status=302'],
      ['GET', '/echo?redirected=1'],
    ])
  })

  it('body を再送できない（chunked）307 は、Location と理由を添えた redirect_error にする', async () => {
    const res = await forward(target('/redirect?status=307'), {
      method: 'POST',
      headers: jsonHeaders,
      body: payload,
      chunked: true,
    })

    expect(res.status).toBe(502)
    expect(res.headers['x-proxy-error']).toBe('1')
    const json = JSON.parse(res.body) as { error: string; message: string }
    // ミスリードな「接続失敗」の案内が付く proxy_error とは別のコードにする
    expect(json.error).toBe('redirect_error')
    expect(json.message).toContain('307')
    expect(json.message).toContain(target('/echo?redirected=1'))
    expect(json.message).toContain('再送できない')
    // 再送できないので 2 回目のリクエストは出していない
    expect(seen.map((r) => r.url)).toEqual(['/redirect?status=307'])
  })

  it('上限を超える Content-Length の body もストリームで転送し、307 は redirect_error にする', async () => {
    const big = 'x'.repeat(8 * 1024 * 1024 + 1)

    const ok = await forward(target('/echo'), { method: 'POST', body: big })
    expect(ok.status).toBe(200)
    expect(seen[0]?.body.length).toBe(big.length)

    seen = []
    const res = await forward(target('/redirect?status=308'), { method: 'POST', body: big })
    expect(res.status).toBe(502)
    expect(res.headers['x-proxy-error']).toBe('1')
    const json = JSON.parse(res.body) as { error: string; message: string }
    expect(json.error).toBe('redirect_error')
    expect(json.message).toContain('308')
    expect(json.message).toContain(target('/echo?redirected=1'))
    expect(seen.map((r) => r.url)).toEqual(['/redirect?status=308'])
  })

  it('別オリジンへのリダイレクトでは Authorization を送らず、他のヘッダーと body は引き継ぐ', async () => {
    const res = await forward(redirectTo(otherTarget('/echo')), {
      method: 'POST',
      headers: { ...jsonHeaders, authorization: 'Bearer secret', 'x-keep': 'yes' },
      body: payload,
    })

    expect(res.status).toBe(200)
    expect(seen).toHaveLength(2)
    expect(seen[0]?.headers.authorization).toBe('Bearer secret')
    expect(seen[1]?.headers.host).toBe(`127.0.0.1:${otherPort}`)
    expect(seen[1]?.headers.authorization).toBeUndefined()
    expect(seen[1]?.headers['x-keep']).toBe('yes')
    expect(seen[1]?.body).toBe(payload)
  })

  it('GET でも別オリジンへのリダイレクトでは Authorization を送らない', async () => {
    await forward(redirectTo(otherTarget('/echo'), 302), {
      headers: { authorization: 'Bearer secret' },
    })
    expect(seen[0]?.headers.authorization).toBe('Bearer secret')
    expect(seen[1]?.headers.authorization).toBeUndefined()
  })

  it('リダイレクトが 20 回を超えたら redirect_error にする', async () => {
    const res = await forward(target('/loop'))
    expect(res.status).toBe(502)
    expect(res.headers['x-proxy-error']).toBe('1')
    const json = JSON.parse(res.body) as { error: string; message: string }
    expect(json.error).toBe('redirect_error')
    expect(json.message).toContain('20')
    // 最初のリクエスト + 追従 20 回
    expect(seen).toHaveLength(21)
  })

  it.each([
    ['http(s) 以外のスキーム', 'ftp://example.com/file', 'http(s)'],
    ['認証情報つき', 'http://user:pass@127.0.0.1:1/', '認証情報'],
    ['URL として解釈できない値', 'http://[', 'URL として解釈できません'],
  ])(
    'Location が追従できない（%s）ときは redirect_error にする',
    async (_label, location, reason) => {
      const res = await forward(redirectTo(location, 302))
      expect(res.status).toBe(502)
      expect(res.headers['x-proxy-error']).toBe('1')
      const json = JSON.parse(res.body) as { error: string; message: string }
      expect(json.error).toBe('redirect_error')
      expect(json.message).toContain(reason)
      expect(seen).toHaveLength(1)
    },
  )

  it('Location のない 3xx は追従せず、そのまま返す', async () => {
    const res = await forward(target('/redirect?status=302&nolocation=1'))
    expect(res.status).toBe(302)
    expect(res.headers['x-proxy-error']).toBeUndefined()
    expect(seen).toHaveLength(1)
  })
})

describe('キャッシュ', () => {
  const varyOf = (res: RawResponse) =>
    String(res.headers.vary)
      .split(',')
      .map((token) => token.trim())

  it('転送先の Cache-Control / ETag / Last-Modified は見せたまま、Vary に転送先と転送ヘッダーを足す', async () => {
    const res = await forward(target('/cacheable'), {
      headers: { authorization: 'Bearer a', 'x-api-key': 'k1', cookie: 'dev=1' },
    })

    expect(res.status).toBe(200)
    expect(res.body).toBe('cached-body')
    expect(res.headers['cache-control']).toBe('public, max-age=60')
    expect(res.headers.etag).toBe('"v1"')
    expect(res.headers['last-modified']).toBe('Wed, 21 Oct 2015 07:28:00 GMT')
    // ブラウザのキャッシュキーは URL（/__proxy）だけなので、転送先・トークン・独自ヘッダーが違えば別物として扱わせる
    const vary = varyOf(res)
    expect(vary).toEqual(expect.arrayContaining(['x-proxy-target', 'authorization', 'x-api-key']))
    // 転送しないヘッダーは応答に影響しないので含めない
    expect(vary).not.toContain('cookie')
    expect(new Set(vary).size).toBe(vary.length)
  })

  it('転送先自身の Vary は残し、重複させずに後ろへ足す', async () => {
    const res = await forward(target('/cacheable?vary=Accept-Language'), {
      headers: { 'accept-language': 'ja', authorization: 'Bearer a' },
    })
    const vary = varyOf(res)
    expect(vary[0]).toBe('Accept-Language')
    expect(vary.filter((t) => t.toLowerCase() === 'accept-language')).toHaveLength(1)
    expect(vary).toEqual(expect.arrayContaining(['x-proxy-target', 'authorization']))
  })

  it('転送先が Vary: * ならそのまま * にする', async () => {
    const res = await forward(target('/cacheable?vary=*'))
    expect(res.headers.vary).toBe('*')
  })

  it('転送リクエストに足したヘッダーはリダイレクト先を辿っても Vary に残る', async () => {
    // 別オリジンへ辿ると Authorization は上流へ送らないが、応答は元のリクエストに対するものなので Vary には残す
    const res = await forward(
      target(`/redirect?status=302&to=${encodeURIComponent(otherTarget('/echo'))}`),
      {
        headers: { authorization: 'Bearer a' },
      },
    )
    expect(varyOf(res)).toEqual(expect.arrayContaining(['x-proxy-target', 'authorization']))
  })
})

describe('describeError', () => {
  it('cause の message があれば添える', () => {
    const err = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:1'),
    })
    expect(describeError(err)).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:1')
  })

  it('cause の message が空なら code、なければ name を添える', () => {
    const withCode = new TypeError('fetch failed', {
      cause: Object.assign(new Error(''), { code: 'UND_ERR_SOCKET' }),
    })
    expect(describeError(withCode)).toBe('fetch failed: UND_ERR_SOCKET')

    const named = Object.assign(new Error(''), { name: 'SocketError' })
    expect(describeError(new TypeError('fetch failed', { cause: named }))).toBe(
      'fetch failed: SocketError',
    )
  })

  it('手がかりが何もない "fetch failed" は、理由が取得できないことを明示する', () => {
    // undici が原因を書かずに投げるときの形（リダイレクト追従の拒否など）
    for (const cause of [new Error(''), undefined]) {
      const message = describeError(new TypeError('fetch failed', { cause }))
      expect(message).toContain('fetch failed')
      expect(message).toContain('詳細な原因は取得できませんでした')
    }
  })

  it('他のエラーは message をそのまま返し、Error でない値は文字列にする', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError('plain')).toBe('plain')
  })

  it('複数アドレスへの接続失敗（AggregateError）は message を並べる', () => {
    const cause = new AggregateError([new Error('connect ECONNREFUSED ::1:1'), new Error('')], '')
    expect(describeError(new TypeError('fetch failed', { cause }))).toBe(
      'fetch failed: connect ECONNREFUSED ::1:1; unknown error',
    )
  })
})

describe('ヘッダーの除去', () => {
  it('開発サーバーの Cookie / Origin / Referer / sec-* / x-proxy-target を上流へ漏らさない', async () => {
    const res = await forward(target('/echo'), {
      method: 'POST',
      body: '{}',
      headers: {
        origin: `http://127.0.0.1:${proxyPort}`,
        referer: `http://127.0.0.1:${proxyPort}/some/page`,
        cookie: 'dev_session=top-secret',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-ch-ua': '"Chromium";v="1"',
        'accept-encoding': 'br',
        authorization: 'Bearer keep-me',
        'x-keep': 'yes',
      },
    })

    expect(res.status).toBe(200)
    const headers = seen[0]?.headers ?? {}
    expect(headers.cookie).toBeUndefined()
    expect(headers.origin).toBeUndefined()
    expect(headers.referer).toBeUndefined()
    expect(headers['x-proxy-target']).toBeUndefined()
    expect(headers['sec-fetch-site']).toBeUndefined()
    expect(headers['sec-ch-ua']).toBeUndefined()
    // クライアントが送った br は引き継がない（fetch が展開できる方式を自分で選ぶ）
    expect(headers['accept-encoding']).not.toBe('br')
    // ユーザーが明示したヘッダーは通す
    expect(headers.authorization).toBe('Bearer keep-me')
    expect(headers['x-keep']).toBe('yes')
  })
})

describe('不正なリクエスト（400）', () => {
  it('GET 以外で x-proxy-target がなければ 400', async () => {
    const res = await send({ method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
    expect(res.headers['x-proxy-error']).toBe('1')
    const json = JSON.parse(res.body) as { error: string; message: string }
    expect(json.error).toBe('missing_target')
    expect(json.message).toContain('x-proxy-target')
    expect(seen).toHaveLength(0)
  })

  it.each([
    ['URL でない文字列', 'not a url'],
    ['相対パス', '/relative/path'],
    ['ftp スキーム', 'ftp://example.com/file'],
    ['file スキーム', 'file:///etc/passwd'],
    ['javascript スキーム', 'javascript:alert(1)'],
    ['認証情報つき URL', 'http://user:pass@127.0.0.1:1/'],
  ])('%s は 400', async (_label, value) => {
    const res = await forward(value, { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
    expect(res.headers['x-proxy-error']).toBe('1')
    const json = JSON.parse(res.body) as { error: string; message: string }
    expect(json.error).toBe('invalid_target')
    expect(json.message).not.toBe('')
    expect(seen).toHaveLength(0)
  })

  it('fetch できないメソッドは 405', async () => {
    const res = await forward(target('/echo'), { method: 'TRACE' })
    expect(res.status).toBe(405)
    expect(res.headers['x-proxy-error']).toBe('1')
    expect(seen).toHaveLength(0)
  })
})

describe('他サイトからの悪用防止（403）', () => {
  it('Origin が Host と一致しなければ 403', async () => {
    const res = await forward(target('/echo'), {
      method: 'POST',
      body: '{}',
      headers: { origin: 'http://evil.example' },
    })
    expect(res.status).toBe(403)
    expect(res.headers['x-proxy-error']).toBe('1')
    expect((JSON.parse(res.body) as { error: string }).error).toBe('forbidden')
    expect(seen).toHaveLength(0)
  })

  it('Origin が "null" や不正値でも 403', async () => {
    const res = await forward(target('/echo'), { headers: { origin: 'null' } })
    expect(res.status).toBe(403)
  })

  it('生存確認（GET）にも同じ検査をかける', async () => {
    const res = await send({ headers: { origin: 'http://evil.example' } })
    expect(res.status).toBe(403)
  })

  it('Origin が Host と一致すれば通る（大文字小文字は区別しない）', async () => {
    const res = await forward(target('/echo'), {
      method: 'POST',
      body: '{}',
      headers: { host: `LOCALHOST:${proxyPort}`, origin: `http://localhost:${proxyPort}` },
    })
    expect(res.status).toBe(200)
  })

  it.each(['cross-site', 'same-site'])('Sec-Fetch-Site: %s は 403', async (site) => {
    const res = await forward(target('/echo'), { headers: { 'sec-fetch-site': site } })
    expect(res.status).toBe(403)
    expect(res.headers['x-proxy-error']).toBe('1')
    expect(seen).toHaveLength(0)
  })

  it.each(['same-origin', 'none'])('Sec-Fetch-Site: %s は通る', async (site) => {
    const res = await forward(target('/echo'), { headers: { 'sec-fetch-site': site } })
    expect(res.status).toBe(200)
  })
})

describe('接続失敗（502）', () => {
  it('転送先に接続できなければ 502 + x-proxy-error', async () => {
    // 一度 listen して閉じ、確実に誰も待ち受けていないポートを得る
    const dead = createServer()
    const deadPort = await listen(dead)
    await close(dead)

    const res = await forward(`http://127.0.0.1:${deadPort}/`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(502)
    expect(res.headers['x-proxy-error']).toBe('1')
    expect(res.headers['content-type']).toContain('application/json')
    const json = JSON.parse(res.body) as { error: string; message: string }
    expect(json.error).toBe('proxy_error')
    expect(json.message).toMatch(/ECONNREFUSED|fetch failed/)
  })

  it('名前解決できないホストでも 502', async () => {
    const res = await forward('http://nonexistent.invalid/')
    expect(res.status).toBe(502)
    expect(res.headers['x-proxy-error']).toBe('1')
  })
})

describe('ストリーミング', () => {
  it('SSE を上流の完了を待たずに逐次返す', async () => {
    const { req, response } = startRequest({
      path: '/__proxy',
      headers: { 'x-proxy-target': target('/sse') },
    })
    req.end()
    const res = await response
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')

    const iterator = res[Symbol.asyncIterator]()
    // sseGate はまだ開いていない = 上流は 1 つ目しか書いていない状態で届く
    const first = await iterator.next()
    expect(String(first.value)).toBe('data: first\n\n')

    sseGate.resolve()
    let rest = ''
    for (let r = await iterator.next(); r.done !== true; r = await iterator.next()) {
      rest += String(r.value)
    }
    expect(rest).toBe('data: second\n\n')
  })

  it('クライアントが切断したら上流のリクエストを中断する', async () => {
    const { req, response } = startRequest({
      path: '/__proxy',
      headers: { 'x-proxy-target': target('/hang') },
    })
    req.end()
    const res = await response
    const iterator = res[Symbol.asyncIterator]()
    await iterator.next()

    // 上流はまだ生きている
    let closedEarly = false
    void hangClosed.promise.then(() => {
      closedEarly = true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(closedEarly).toBe(false)

    req.destroy()
    res.destroy()
    await vi.waitFor(() => expect(closedEarly).toBe(true), { timeout: 2000 })
  })

  it('上流が途中で切れたらクライアントにも途中切断として伝える', async () => {
    const { req, response } = startRequest({
      path: '/__proxy',
      headers: { 'x-proxy-target': target('/cut') },
    })
    req.end()
    const res = await response
    expect(res.statusCode).toBe(200)

    const drain = async () => {
      let text = ''
      for await (const chunk of res) text += String(chunk)
      return text
    }
    // 正常終了（空の終端チャンク）に見せかけず、ストリームエラーになる
    await expect(drain()).rejects.toThrow()
  })
})

describe('devProxy プラグイン', () => {
  it('dev / preview の両サーバーにミドルウェアを登録する', () => {
    const plugin = devProxy()
    expect(plugin.name).toBe('ai-sdk-tester-dev-proxy')

    for (const hookName of ['configureServer', 'configurePreviewServer'] as const) {
      const hook = plugin[hookName]
      const handler = typeof hook === 'function' ? hook : hook?.handler
      expect(handler, hookName).toBeTypeOf('function')

      const use = vi.fn()
      const result = (handler as (server: unknown) => unknown).call({}, { middlewares: { use } })
      expect(use, hookName).toHaveBeenCalledTimes(1)
      expect(use.mock.calls[0]?.[0], hookName).toBeTypeOf('function')
      // 戻り値（後処理フック）を返すと preview で compression の後ろに回るため返さない
      expect(result, hookName).toBeUndefined()
    }
  })
})
