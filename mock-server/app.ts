/**
 * AI SDK 互換のモックバックエンド（API キー不要）。
 * `createMockServer()` は http.Server を返すだけで listen はしない。起動は server.ts が担当する。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  CHAT_SCENARIOS,
  SIMPLE_SCENARIOS,
  describeScenarios,
  readMessages,
  readUserText,
  selectScenario,
  simpleOutcomeToPlan,
  type LooseMessage,
  type MockRequest,
  type ScenarioContext,
  type ScenarioPlan,
} from './scenarios.ts'

export type MockOutcome = 'completed' | 'client-closed' | 'destroyed'

export interface MockLogEntry {
  method: string
  path: string
  status: number
  /** 選ばれたシナリオ名（シナリオを持たないエンドポイントでは undefined） */
  scenario: string | undefined
  /** ストリームがどう終わったか。client-closed はクライアントが先に切断した場合 */
  outcome: MockOutcome
  durationMs: number
}

export interface MockServerOptions {
  /** CORS ヘッダーを付ける（既定 true）。false なら一切付けず、ブラウザの CORS エラーを再現できる */
  cors?: boolean
  /** 待ち時間の倍率（既定 1）。テストでは 0 にして待たない */
  delayScale?: number
  /** リクエストごとの結果通知。CLI のログ出力や、テストでのクライアント切断の検知に使う */
  onLog?: (entry: MockLogEntry) => void
}

interface Settings {
  cors: boolean
  delayScale: number
  onLog: ((entry: MockLogEntry) => void) | undefined
}

interface RequestMeta {
  scenario?: string
  outcome?: MockOutcome
}

const MAX_BODY_BYTES = 10 * 1024 * 1024
const MAX_DELAY_MS = 30_000

class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function createMockServer(options: MockServerOptions = {}): Server {
  const settings: Settings = {
    cors: options.cors ?? true,
    delayScale: options.delayScale ?? 1,
    onLog: options.onLog,
  }
  const server = createServer((req, res) => {
    const startedAt = Date.now()
    const meta: RequestMeta = {}
    const method = (req.method ?? 'GET').toUpperCase()
    const path = safePathname(req.url)

    res.once('close', () => {
      try {
        settings.onLog?.({
          method,
          path,
          status: res.statusCode,
          scenario: meta.scenario,
          outcome: meta.outcome ?? (res.writableFinished ? 'completed' : 'client-closed'),
          durationMs: Date.now() - startedAt,
        })
      } catch {
        // ログ出力の失敗でサーバーを落とさない
      }
    })

    handle(req, res, settings, meta).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message })
        return
      }
      sendJson(res, 500, {
        error: 'internal_server_error',
        message: err instanceof Error ? err.message : String(err),
      })
    })
  })
  // 既定の 5 秒だと、ブラウザが再利用しようとした接続をサーバーが閉じる競合で、まれに最初のリクエストが失敗する
  server.keepAliveTimeout = 60_000
  return server
}

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  settings: Settings,
  meta: RequestMeta,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  const url = new URL(req.url ?? '/', 'http://mock.local')
  const path = url.pathname

  if (settings.cors) {
    applyCors(req, res)
    if (method === 'OPTIONS') {
      applyPreflight(req, res)
      res.statusCode = 204
      res.end()
      return
    }
  }

  switch (path) {
    case '/health':
      requireMethod(method, ['GET', 'HEAD'])
      sendJson(res, 200, { ok: true })
      return
    case '/api/scenarios':
      requireMethod(method, ['GET', 'HEAD'])
      sendJson(res, 200, {
        selection:
          'シナリオは body.scenario → ?scenario= → 本文先頭の "#名前" → 既定(text) の優先順で選ばれます',
        chat: describeScenarios(CHAT_SCENARIOS),
        text: describeScenarios(SIMPLE_SCENARIOS),
        completion: describeScenarios(SIMPLE_SCENARIOS),
      })
      return
    case '/api/chat':
      requireMethod(method, ['POST'])
      await handleScenario(req, res, url, settings, meta, (input) =>
        resolveScenario(input, CHAT_SCENARIOS, (scenario, ctx) => scenario.build(ctx)),
      )
      return
    case '/api/text':
      requireMethod(method, ['POST'])
      await handleScenario(req, res, url, settings, meta, (input) =>
        resolveScenario(input, SIMPLE_SCENARIOS, (scenario, ctx) =>
          simpleOutcomeToPlan(scenario.build(ctx), 'text'),
        ),
      )
      return
    case '/api/completion': {
      requireMethod(method, ['POST'])
      const protocol = url.searchParams.get('protocol') ?? 'data'
      if (protocol !== 'data' && protocol !== 'text') {
        throw new HttpError(
          400,
          'unknown_protocol',
          `protocol は data か text を指定してください（受け取った値: ${protocol}）`,
        )
      }
      await handleScenario(req, res, url, settings, meta, (input) =>
        resolveScenario(input, SIMPLE_SCENARIOS, (scenario, ctx) =>
          simpleOutcomeToPlan(scenario.build(ctx), protocol === 'text' ? 'text' : 'sse'),
        ),
      )
      return
    }
    case '/api/json':
      await handleJsonEcho(req, res, url)
      return
  }

  // useChat の resume 用エンドポイント（再接続すべきストリームはない）
  if (method === 'GET' && /^\/api\/chat\/[^/]+\/stream$/.test(path)) {
    res.statusCode = 204
    res.end()
    return
  }

  throw new HttpError(
    404,
    'not_found',
    `${method} ${path} は存在しません。GET /api/scenarios を参照してください`,
  )
}

function requireMethod(method: string, allowed: string[]): void {
  if (!allowed.includes(method)) {
    throw new HttpError(
      405,
      'method_not_allowed',
      `${method} は使えません（${allowed.join(', ')} のみ）`,
    )
  }
}

interface ScenarioInput {
  request: MockRequest
  messages: LooseMessage[]
  /** 最後のユーザーメッセージ（または prompt）の本文。`#名前` トークン除去前 */
  userText: string
}

type ResolvedPlan =
  { scenario: string; plan: ScenarioPlan } | { error: { error: string; message: string } }

/** シナリオを選び、そのプランを組み立てる。未知のシナリオ名はエラー応答にする。 */
function resolveScenario<T extends { name: string }>(
  input: ScenarioInput,
  scenarios: readonly T[],
  build: (scenario: T, ctx: ScenarioContext) => ScenarioPlan,
): ResolvedPlan {
  const selection = selectScenario({
    scenarios,
    defaultName: 'text',
    body: input.request.body,
    query: input.request.query,
    userText: input.userText,
  })
  if (!selection.ok) {
    return {
      error: {
        error: 'unknown_scenario',
        message: `未知のシナリオです: ${selection.requested}（GET /api/scenarios で一覧を確認できます）`,
      },
    }
  }
  const ctx: ScenarioContext = {
    ...input.request,
    messages: input.messages,
    userText: selection.userText,
  }
  return { scenario: selection.scenario.name, plan: build(selection.scenario, ctx) }
}

async function handleScenario(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  settings: Settings,
  meta: RequestMeta,
  resolve: (input: ScenarioInput) => ResolvedPlan,
): Promise<void> {
  const request = await readMockRequest(req, url)
  const messages = readMessages(request.body)
  const resolved = resolve({ request, messages, userText: readUserText(request.body, messages) })
  if ('error' in resolved) {
    sendJson(res, 400, resolved.error)
    return
  }
  meta.scenario = resolved.scenario
  // 選ばれたシナリオを DevTools / フロントのネットワークログで確認できるようにする
  res.setHeader('x-mock-scenario', resolved.scenario)
  await sendPlan(res, resolved.plan, settings.delayScale, meta)
}

// ---------------------------------------------------------------------------
// /api/json（Raw モード用 JSON エコー）
// ---------------------------------------------------------------------------

async function handleJsonEcho(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const request = await readMockRequest(req, url)

  let status = 200
  const statusParam = url.searchParams.get('status')
  if (statusParam !== null) {
    status = Number(statusParam)
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new HttpError(
        400,
        'invalid_status',
        `status は 200〜599 の整数で指定してください: ${statusParam}`,
      )
    }
  }

  const delayParam = url.searchParams.get('delay')
  let delayMs = 0
  if (delayParam !== null) {
    delayMs = Number(delayParam)
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
      throw new HttpError(
        400,
        'invalid_delay',
        `delay は 0〜${MAX_DELAY_MS} (ms) で指定してください: ${delayParam}`,
      )
    }
  }
  if (delayMs > 0) {
    const closed = new AbortController()
    res.once('close', () => closed.abort())
    // 明示指定の待ち時間なので delayScale は掛けない
    if (!(await sleep(delayMs, closed.signal))) return
  }

  sendJson(res, status, {
    method: request.method,
    path: request.path,
    query: queryToObject(url.searchParams),
    headers: request.headers,
    body: parseEchoBody(request),
    receivedAt: new Date().toISOString(),
  })
}

function queryToObject(params: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)
    result[key] = values.length === 1 ? (values[0] ?? '') : values
  }
  return result
}

/** JSON として読めるものはパース済みで、それ以外は文字列のまま返す。 */
function parseEchoBody(request: MockRequest): unknown {
  const raw = request.rawBody
  if (raw === '') return ''
  const contentType = String(request.headers['content-type'] ?? '')
  const looksJson = contentType.includes('json') || /^\s*[[{]/.test(raw)
  if (!looksJson) return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// ---------------------------------------------------------------------------
// リクエスト / レスポンスの共通処理
// ---------------------------------------------------------------------------

function safePathname(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://mock.local').pathname
  } catch {
    return '/'
  }
}

async function readMockRequest(req: IncomingMessage, url: URL): Promise<MockRequest> {
  const rawBody = await readBody(req)
  let body: Record<string, unknown> | undefined
  if (rawBody !== '') {
    try {
      const parsed: unknown = JSON.parse(rawBody)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // JSON でない body もそのまま echo できるよう、パース失敗は無視する
    }
  }
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    url: `${url.pathname}${url.search}`,
    query: url.searchParams,
    headers: req.headers,
    rawBody,
    body,
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(
        413,
        'payload_too_large',
        `リクエスト body は ${MAX_BODY_BYTES} バイトまでです`,
      )
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.statusCode = status
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  if (status === 204 || status === 304) {
    res.end()
    return
  }
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/** すべてのレスポンス（401 / 500 / 404 を含む）に付ける。付けないとブラウザは本来のステータスではなく CORS エラーを報告する。 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  // credentials: 'include' では * が使えないため、Origin があればそれをそのまま許可する
  res.setHeader('access-control-allow-origin', origin ?? '*')
  if (origin !== undefined) {
    res.setHeader('vary', 'Origin')
    res.setHeader('access-control-allow-credentials', 'true')
  }
  res.setHeader(
    'access-control-expose-headers',
    'x-vercel-ai-ui-message-stream, content-type, x-mock-scenario',
  )
}

function applyPreflight(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  // 要求されたヘッダーをそのまま許可する（任意の追加ヘッダーを試せるように）
  const requested = req.headers['access-control-request-headers']
  res.setHeader('access-control-allow-headers', requested ?? 'content-type, authorization')
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('access-control-allow-private-network', 'true')
  }
}

// ---------------------------------------------------------------------------
// プランの書き出し
// ---------------------------------------------------------------------------

async function sendPlan(
  res: ServerResponse,
  plan: ScenarioPlan,
  delayScale: number,
  meta: RequestMeta,
): Promise<void> {
  if (plan.format === 'json') {
    sendJson(res, plan.status, plan.body, plan.headers)
    return
  }

  res.statusCode = 200
  if (plan.format === 'sse') {
    // ai パッケージの UI_MESSAGE_STREAM_HEADERS と同じ（テストで一致を確認している）
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('connection', 'keep-alive')
    res.setHeader('x-accel-buffering', 'no')
    if (plan.omitStreamHeader !== true) res.setHeader('x-vercel-ai-ui-message-stream', 'v1')
  } else {
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('x-accel-buffering', 'no')
  }
  // 小さなチャンクをまとめて遅延させないよう、ヘッダーを即送出し Nagle も切る
  res.socket?.setNoDelay(true)
  res.flushHeaders()

  // クライアントが切断したら、残りのステップを流さずに止める
  const closed = new AbortController()
  res.once('close', () => closed.abort())

  const steps: readonly (typeof plan.steps)[number][] = plan.steps
  for (const step of steps) {
    if (step.delayMs !== undefined && !(await sleep(step.delayMs * delayScale, closed.signal)))
      return
    if (res.destroyed) return

    if ('destroy' in step) {
      meta.outcome = 'destroyed'
      res.destroy()
      return
    }
    const data =
      'chunk' in step
        ? `data: ${JSON.stringify(step.chunk)}\n\n`
        : 'raw' in step
          ? `data: ${step.raw}\n\n`
          : 'comment' in step
            ? `: ${step.comment}\n\n`
            : step.text
    if (!(await write(res, data))) return
  }

  if (plan.format === 'sse' && plan.omitDone !== true) {
    if (!(await write(res, 'data: [DONE]\n\n'))) return
  }
  res.end()
}

/** 待機。待ち切ったら true、途中で signal が中断されたら false。 */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** バックプレッシャーを待って書く。クライアントが切れていたら false。 */
async function write(res: ServerResponse, data: string): Promise<boolean> {
  if (res.destroyed) return false
  if (!res.write(data)) {
    await new Promise<void>((resolve) => {
      const done = () => {
        res.off('drain', done)
        res.off('close', done)
        resolve()
      }
      res.once('drain', done)
      res.once('close', done)
    })
  }
  return !res.destroyed
}
