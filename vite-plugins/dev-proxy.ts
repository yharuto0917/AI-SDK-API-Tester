/**
 * 開発専用の動的転送プロキシ（CORS 回避用）。
 *
 * ブラウザから別オリジンのバックエンドを叩くと CORS で弾かれるため、
 * 同一オリジンの `/__proxy` に `x-proxy-target: <絶対 URL>` を付けて送ると、
 * Node 側がその URL へ代理でリクエストして結果をそのまま返す。
 *
 * - Vite の dev / preview サーバーのミドルウェアとして動くだけで、ビルド成果物には含まれない。
 * - 任意の URL へ転送できる「踏み台」なので、`vite --host` などで LAN に公開した状態で使わないこと。
 *   Origin / Sec-Fetch-Site の検査は他サイトからの悪用を防ぐだけで、同一ネットワークの第三者は防げない。
 * - 開発サーバー自身の Cookie や Origin を外部へ漏らさないよう、転送時に該当ヘッダーを取り除く。
 *
 * 契約（フロント側 src/lib/proxy.ts と一致させること）:
 * - `GET /__proxy`（x-proxy-target なし）→ 200 `{"proxy":"ai-sdk-tester","version":1}`（生存確認）
 * - それ以外 → `x-proxy-target` の http(s) URL へ元のメソッド / body をそのまま転送
 * - プロキシ自身の失敗には `x-proxy-error: 1` を付ける（400 / 403 / 405 / 502）。転送先の 4xx / 5xx とは区別できる
 *   - 502 の `error` は `proxy_error`（接続失敗など）と `redirect_error`（リダイレクトを追従できなかった）
 * - リダイレクトは fetch と同じ規則でプロキシが追従する（301/302 の POST と 303 は GET に切り替え、307/308 は body を再送）。
 *   body を再送できないとき（Content-Length のない / 上限超えのストリーム送信）は `redirect_error` で Location を伝える
 * - 応答には転送したリクエストヘッダーを `Vary` に足し、転送先違い・トークン違いの応答をブラウザが使い回さないようにする
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Plugin } from 'vite'

const PROXY_PATH = '/__proxy'
const TARGET_HEADER = 'x-proxy-target'
const ERROR_HEADER = 'x-proxy-error'
const PROXY_VERSION = 1

/** 転送先へ送らないリクエストヘッダー（sec-* は別途前方一致で除去する）。 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'content-length',
  'accept-encoding',
  TARGET_HEADER,
  // hop-by-hop（fetch が自前で付け直す）
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // undici の fetch は Expect を拒否する
  'expect',
])

/**
 * ブラウザへ返さないレスポンスヘッダー。
 * fetch がボディを展開済みなので content-encoding / content-length は不整合になる。
 * set-cookie は転送先のものを開発サーバーの Cookie（localhost は全ポートで共有）に混ぜないために落とす。
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'set-cookie',
])

/** fetch が受け付けないメソッド。 */
const UNSUPPORTED_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK'])

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** fetch の既定と同じ上限。 */
const MAX_REDIRECTS = 20
/** GET に切り替えるリダイレクトで、fetch 仕様に従って落とすリクエストヘッダー。 */
const REQUEST_BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
]
/**
 * これ以下の Content-Length の body は先に全部読み込み、リダイレクト（307/308）で再送できるようにする。
 * 超えるものは従来どおりストリームで流す（再送できない）。
 */
const REPLAYABLE_BODY_LIMIT = 8 * 1024 * 1024

/** 転送するリクエスト body。Uint8Array は何度でも送れるが、ストリームは 1 回しか送れない。 */
type ForwardBody = Uint8Array | ReadableStream<Uint8Array>

/** リダイレクトを追従できなかった理由。プロキシ自身の失敗として 502 + `redirect_error` で返す。 */
class RedirectError extends Error {}

type NextFunction = (err?: unknown) => void

export function createDevProxyMiddleware(): (
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFunction,
) => void {
  return (req, res, next) => {
    // パス接頭辞でマウントすると req.url が書き換わるため、全リクエストを受けて自前で判定する
    const pathname = parsePathname(req.url)
    if (pathname !== PROXY_PATH) {
      next()
      return
    }
    handleProxyRequest(req, res).catch((err: unknown) => {
      // handleProxyRequest 自身が全部拾う想定。ここに来るのは想定外のバグだけ
      respondError(res, 502, 'proxy_error', describeError(err))
    })
  }
}

/** Vite の dev / preview 両方のミドルウェアに差し込む。 */
export function devProxy(): Plugin {
  const middleware = createDevProxyMiddleware()
  return {
    name: 'ai-sdk-tester-dev-proxy',
    // preview では configurePreviewServer の戻り値（後処理）にすると compression の後ろに回り、
    // SSE がバッファされる。ここで直接 use して他のミドルウェアより前に置く
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

async function handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 書き込み先が壊れた後の 'error' で落ちないようにする（クライアント切断は 'close' で拾う）
  res.on('error', () => {})

  const forbidden = checkSameOrigin(req)
  if (forbidden !== undefined) {
    respondError(res, 403, 'forbidden', forbidden)
    return
  }

  const method = (req.method ?? 'GET').toUpperCase()
  const targetHeader = singleHeader(req.headers[TARGET_HEADER])

  if (targetHeader === undefined && method === 'GET') {
    respondJson(res, 200, { proxy: 'ai-sdk-tester', version: PROXY_VERSION })
    return
  }
  if (targetHeader === undefined || targetHeader.trim() === '') {
    respondError(
      res,
      400,
      'missing_target',
      `${TARGET_HEADER} ヘッダーに転送先の絶対 URL を指定してください`,
    )
    return
  }

  const target = parseTarget(targetHeader)
  if (typeof target === 'string') {
    respondError(res, 400, 'invalid_target', target)
    return
  }
  if (UNSUPPORTED_METHODS.has(method)) {
    respondError(res, 405, 'method_not_allowed', `${method} メソッドは転送できません`)
    return
  }

  // クライアントが切断したら上流も止める（切断済みのレスポンスには何も書かない）
  const abortController = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abortController.abort()
  })

  let body: ForwardBody | undefined
  try {
    body = await readForwardBody(req, method)
  } catch {
    // body の受信途中でクライアントが切断した。応答先はもういない
    return
  }

  const forwardHeaders = buildForwardHeaders(req)
  let upstream: Response
  try {
    upstream = await fetchFollowingRedirects(target, {
      method,
      headers: forwardHeaders,
      body,
      signal: abortController.signal,
    })
  } catch (err) {
    if (abortController.signal.aborted || res.destroyed) return
    respondError(
      res,
      502,
      err instanceof RedirectError ? 'redirect_error' : 'proxy_error',
      describeError(err),
    )
    return
  }

  res.statusCode = upstream.status
  if (upstream.statusText !== '') res.statusMessage = upstream.statusText
  upstream.headers.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name)) res.setHeader(name, value)
  })
  // ブラウザの HTTP キャッシュは URL（常に /__proxy）しか見ないため、別の転送先・別のトークンの応答を使い回してしまう
  res.setHeader('vary', mergeVary(upstream.headers.get('vary'), forwardHeaders))
  // ヘッダーを即送出する。これがないと最初のチャンクが出るまでクライアントに何も届かない
  res.flushHeaders()

  if (upstream.body === null) {
    res.end()
    return
  }

  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // バッファせずチャンクごとに書く（SSE を即時に流すため）
      if (!res.write(value)) await waitForDrain(res)
    }
    res.end()
  } catch (err) {
    // 転送中の失敗（上流の切断など）。正常終了に見せないよう接続ごと落とす
    if (!abortController.signal.aborted) res.destroy(err instanceof Error ? err : undefined)
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// リクエスト検査・組み立て
// ---------------------------------------------------------------------------

function parsePathname(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname
  } catch {
    return ''
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** 他サイト由来のリクエストを拒否する。問題なければ undefined、拒否理由があれば文字列。 */
function checkSameOrigin(req: IncomingMessage): string | undefined {
  const fetchSite = singleHeader(req.headers['sec-fetch-site'])
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return `Sec-Fetch-Site: ${fetchSite} のリクエストは受け付けません`
  }

  const origin = singleHeader(req.headers.origin)
  if (origin !== undefined) {
    const host = singleHeader(req.headers.host)
    let originHost: string | undefined
    try {
      originHost = new URL(origin).host
    } catch {
      // "null" など。オリジン不明のリクエストは拒否する
    }
    if (
      originHost === undefined ||
      host === undefined ||
      originHost.toLowerCase() !== host.toLowerCase()
    ) {
      return `Origin: ${origin} は開発サーバーと一致しません`
    }
  }
  return undefined
}

/** 正常なら URL、不正なら理由（文字列）を返す。 */
function parseTarget(value: string): URL | string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return `${TARGET_HEADER} が URL として解釈できません: ${value}`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `${TARGET_HEADER} は http(s) の URL のみ指定できます: ${url.protocol}`
  }
  // fetch は認証情報つき URL を拒否するため、先に分かりやすいエラーにする
  if (url.username !== '' || url.password !== '') {
    return `${TARGET_HEADER} に認証情報（user:pass@）は含められません。Authorization ヘッダーを使ってください`
  }
  return url
}

function buildForwardHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (STRIPPED_REQUEST_HEADERS.has(name) || name.startsWith('sec-')) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v)
    } else {
      headers.set(name, value)
    }
  }
  return headers
}

/** ボディの有無。GET / HEAD に body を渡すと fetch が例外を投げるため、ここで判定する。 */
function hasRequestBody(req: IncomingMessage, method: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false
  if (req.headers['transfer-encoding'] !== undefined) return true
  const length = singleHeader(req.headers['content-length'])
  return length !== undefined && length !== '0'
}

function bodyStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  // node:stream/web と lib の ReadableStream は型が別名扱いになるためキャストする
  return Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
}

/**
 * 転送する body を用意する。Content-Length が分かる小さい body は先に読み込んで再送可能にし、
 * それ以外（chunked / 上限超え）はストリームのまま流す。body がなければ undefined。
 * 受信途中でクライアントが切断すると例外になる。
 */
async function readForwardBody(
  req: IncomingMessage,
  method: string,
): Promise<ForwardBody | undefined> {
  if (!hasRequestBody(req, method)) return undefined
  const length = Number(singleHeader(req.headers['content-length']))
  if (
    req.headers['transfer-encoding'] === undefined &&
    Number.isSafeInteger(length) &&
    length <= REPLAYABLE_BODY_LIMIT
  ) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  }
  return bodyStream(req)
}

/** 転送先ごとにキャッシュを分けるため、応答が左右され得る（= 転送した）リクエストヘッダーを Vary に足す。 */
function mergeVary(upstreamVary: string | null, forwarded: Headers): string {
  const tokens = (upstreamVary ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
  // `*` はそれだけで「どのリクエストにも使い回さない」を意味する
  if (tokens.includes('*')) return '*'
  const known = new Set(tokens.map((token) => token.toLowerCase()))
  // 転送先の Cache-Control / ETag / Vary はインスペクタで見せたいので上書きせず、足りない分だけ後ろに足す
  for (const name of [TARGET_HEADER, ...forwarded.keys()]) {
    if (!known.has(name)) {
      known.add(name)
      tokens.push(name)
    }
  }
  return tokens.join(', ')
}

// ---------------------------------------------------------------------------
// 転送（リダイレクト追従）
// ---------------------------------------------------------------------------

interface ForwardInit {
  method: string
  headers: Headers
  body: ForwardBody | undefined
  signal: AbortSignal
}

/**
 * fetch と同じ規則でリダイレクトを追従する。
 * undici はストリームの body を持つリクエストのリダイレクト追従を拒否し（原因の書かれない "fetch failed" になる）、
 * Uint8Array の body でも 307/308 の再送に失敗することがあるため、`redirect: 'manual'` で 1 ホップずつ自前で辿る。
 */
async function fetchFollowingRedirects(target: URL, init: ForwardInit): Promise<Response> {
  let url = target
  let method = init.method
  let body = init.body
  // 呼び出し元の Headers（Vary の算出にも使う）を書き換えないよう、ホップ中に変えるものは複製して持つ
  const headers = new Headers(init.headers)

  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, {
      method,
      headers,
      body,
      // ストリームのボディを送るには half-duplex の明示が必要
      duplex: 'half',
      signal: init.signal,
      redirect: 'manual',
    })
    const location = response.headers.get('location')
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response
    // 追従するのでこの応答の本文は使わない。読み捨てて接続を解放する
    await response.body?.cancel().catch(() => {})

    if (redirects >= MAX_REDIRECTS) {
      throw new RedirectError(
        `リダイレクトが ${MAX_REDIRECTS} 回を超えました（最後の Location: ${location}）`,
      )
    }
    const next = resolveRedirect(location, url)
    if (typeof next === 'string') {
      throw new RedirectError(`${response.status} のリダイレクト先を追従できません: ${next}`)
    }

    // 301/302 の POST と 303 は GET に切り替えて body を捨てる（ブラウザの fetch と同じ）
    const switchToGet =
      response.status === 303
        ? method !== 'GET' && method !== 'HEAD'
        : (response.status === 301 || response.status === 302) && method === 'POST'
    if (switchToGet) {
      method = 'GET'
      body = undefined
      for (const name of REQUEST_BODY_HEADERS) headers.delete(name)
    } else if (body !== undefined && !(body instanceof Uint8Array)) {
      throw new RedirectError(
        `転送先が ${response.status} で ${next.href} へのリダイレクトを返しましたが、` +
          `リクエスト body を再送できないためプロキシでは追従できません` +
          `（Content-Length のない、または ${REPLAYABLE_BODY_LIMIT / 1024 / 1024} MiB を超える body はストリームで送るため）。` +
          'リダイレクト先の URL を直接エンドポイントに指定してください',
      )
    }
    // 別オリジンへの Authorization は fetch 仕様と同じく送らない（Bearer トークンを意図しないホストへ渡さない）
    if (next.origin !== url.origin) headers.delete('authorization')
    url = next
  }
}

/** Location を現在の URL からの相対として解決する。正常なら URL、追従できないなら理由（文字列）を返す。 */
function resolveRedirect(location: string, base: URL): URL | string {
  let next: URL
  try {
    next = new URL(location, base)
  } catch {
    return `Location が URL として解釈できません: ${location}`
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    return `Location は http(s) の URL のみ追従できます: ${next.protocol}`
  }
  if (next.username !== '' || next.password !== '') {
    return 'Location に認証情報（user:pass@）が含まれています'
  }
  return next
}

// ---------------------------------------------------------------------------
// レスポンス
// ---------------------------------------------------------------------------

function respondJson(res: ServerResponse, status: number, body: unknown, proxyError = false): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  if (proxyError) res.setHeader(ERROR_HEADER, '1')
  res.end(JSON.stringify(body))
}

function respondError(res: ServerResponse, status: number, error: string, message: string): void {
  respondJson(res, status, { error, message }, true)
}

function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed) {
      resolve()
      return
    }
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    // 複数アドレス（::1 と 127.0.0.1 など）への接続失敗がまとまって来る
    const details = cause.errors.map((e: unknown) => errorDetail(e) ?? 'unknown error')
    return `${err.message}: ${details.join('; ')}`
  }
  const detail = errorDetail(cause)
  if (detail !== undefined) return `${err.message}: ${detail}`
  // undici は原因を持たない "fetch failed" を投げることがある。理由が書かれていないことを明示する
  if (err.message === 'fetch failed') return `${err.message}（詳細な原因は取得できませんでした）`
  return err.message
}

/** message が空のエラー（undici の ECONNRESET など）でも手がかりを出す。何も取れなければ undefined。 */
function errorDetail(e: unknown): string | undefined {
  if (!(e instanceof Error)) return typeof e === 'string' && e !== '' ? e : undefined
  if (e.message !== '') return e.message
  const code = (e as { code?: unknown }).code
  if (typeof code === 'string' && code !== '') return code
  // 素の Error の name は "Error" で手がかりにならない
  return e.name !== 'Error' ? e.name : undefined
}
