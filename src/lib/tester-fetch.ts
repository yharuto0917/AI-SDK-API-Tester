import { networkLog } from '@/lib/network-log'
import type { NetworkLogStore } from '@/lib/network-log'
import { PROXY_PATH, PROXY_TOGGLE_LABEL } from '@/lib/proxy'
import { shapeRequest } from '@/lib/request-shaper'
import type { ShapedRequest } from '@/lib/request-shaper'
import { settingsStore } from '@/lib/settings-store'
import { STREAM_CANCELLED_ERROR } from '@/lib/stream-analyzer'
import type { ConnectionSettings, Mode } from '@/types'

export interface TesterFetchOptions {
  mode: Mode
  /** 呼び出しの時点で読む。既定は settingsStore.getSettings */
  getSettings?: () => ConnectionSettings
  log?: NetworkLogStore
  fetchImpl?: typeof fetch
}

/** Response をボディ付きで作れないステータス。 */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

interface ErrorInfo {
  name: string
  message: string
  hint?: string
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}

function isAbort(error: unknown, signal: AbortSignal | null | undefined): boolean {
  const { name } = describeError(error)
  if (name === 'AbortError') return true
  // abort(reason) の reason がそのまま reject されることがある。タイムアウトは中断ではなく失敗として扱う
  return signal?.aborted === true && name !== 'TimeoutError'
}

/** fetch 自体の失敗は、ブラウザごとに文言が違うだけで中身が分からない（CORS も接続不可も同じ）。 */
const FETCH_FAILURE_RE = /failed to fetch|networkerror|load failed|fetch failed/i

function fetchFailureHint(error: unknown, viaProxy: boolean): string | undefined {
  const { name, message } = describeError(error)
  if (name !== 'TypeError' || !FETCH_FAILURE_RE.test(message)) return undefined
  return viaProxy
    ? `Vite 開発サーバー（${PROXY_PATH}）に接続できないか、プロキシから転送先への接続に失敗した可能性があります。開発サーバーの起動と転送先 URL を確認してください。`
    : `CORS で拒否された、サーバーに接続できない、https のページから http へ送信している、のいずれかの可能性があります。CORS が原因なら設定の「${PROXY_TOGGLE_LABEL}」を ON にすると回避できます。`
}

const MID_STREAM_HINT =
  'レスポンスの受信中に接続が切断されました。サーバーまたはプロキシが途中で接続を閉じた可能性があります。'

const CANCELLED_HINT =
  'サーバーが切ったのではなく、クライアント（AI SDK）が読み取りをやめました。不正な chunk（JSON の誤り・スキーマ違反・error chunk など）でストリームを中断するとこうなります。チャット側のエラー表示と、診断タブの chunk に関する指摘を確認してください。'

function headersToRecord(headers: Headers): Record<string, string> {
  const pairs: Array<[string, string]> = []
  // DOM.Iterable を使わずに済む forEach で集める
  headers.forEach((value, name) => pairs.push([name.toLowerCase(), value]))
  return Object.fromEntries(pairs)
}

/**
 * アプリ（SDK）へ返す body。読み取りの打ち切り（cancel）を検知して onCancel に知らせる。
 * tee() は両方の枝が cancel されるまで上流を止めないので、アプリ側だけが cancel しても
 * ログ側が最後まで読み続け、サーバーとの接続が閉じない。cancel を受けたらログ側も打ち切って上流を止める。
 */
function relayWithCancelHook(
  source: ReadableStream<Uint8Array>,
  onCancel: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      onCancel(reason)
      return reader.cancel(reason)
    },
  })
}

/** ログへの記録に失敗しても、アプリ側の通信は止めない。 */
function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * AI SDK の fetch オプションに差し込む fetch。
 * 送信直前に設定からリクエストを組み立て直し（エンドポイント・ヘッダー・追加ボディ・プロキシ）、
 * 通信の内容をネットワークログへ記録する。レスポンスのボディは tee() で二分し、片方をログ用に読む。
 */
export function createTesterFetch(opts: TesterFetchOptions): typeof fetch {
  const { mode } = opts
  const getSettings = opts.getSettings ?? settingsStore.getSettings
  const log = opts.log ?? networkLog
  // fetch を単体の変数として呼ぶと環境によって Illegal invocation になるため、都度 globalThis 経由で呼ぶ
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))

  return async (_input, init) => {
    const settings = getSettings()

    let shaped: ShapedRequest
    try {
      // SDK が渡した URL は使わない。エンドポイントは常に最新の設定から解決する
      shaped = shapeRequest({ mode, settings, init })
    } catch (error) {
      // 送信前の失敗も画面で追えるよう、記録を残してから同じエラーを投げる
      const id = attempt(() =>
        log.begin({
          mode,
          method: (init?.method || (mode === 'raw' ? settings.rawMethod : 'POST')).toUpperCase(),
          targetUrl: settings.endpoints[mode],
          viaProxy: settings.useDevProxy,
          requestHeaders: {},
        }),
      )
      if (id !== undefined) {
        attempt(() => log.finish(id, { state: 'error', error: describeError(error) }))
      }
      throw error
    }

    const id = attempt(() =>
      log.begin({
        mode,
        method: shaped.method,
        targetUrl: shaped.targetUrl,
        viaProxy: shaped.viaProxy,
        requestHeaders: shaped.headers,
        droppedHeaders: shaped.droppedHeaders,
        requestBody: shaped.requestBody,
      }),
    )
    /** ログ操作を、記録先が無い・失敗した場合に何もせず流す */
    const record = (fn: (logId: string) => void) => {
      if (id !== undefined) attempt(() => fn(id))
    }
    const finishWithError = (error: unknown, hint: string | undefined) => {
      const signal = shaped.fetchInit.signal
      if (isAbort(error, signal)) {
        record((logId) => log.finish(logId, { state: 'aborted' }))
        return
      }
      const info: ErrorInfo = { ...describeError(error), ...(hint !== undefined ? { hint } : {}) }
      record((logId) => log.finish(logId, { state: 'error', error: info }))
    }

    let res: Response
    try {
      res = await doFetch(shaped.fetchUrl, shaped.fetchInit)
    } catch (error) {
      finishWithError(error, fetchFailureHint(error, shaped.viaProxy))
      throw error
    }

    record((logId) =>
      log.recordHead(logId, {
        status: res.status,
        statusText: res.statusText,
        responseHeaders: headersToRecord(res.headers),
      }),
    )

    if (res.body === null) {
      record((logId) => log.finish(logId, { state: 'done' }))
      return res
    }

    /** アプリ側が body の読み取りを打ち切った（SDK が不正な chunk などでストリームを止めた）。 */
    let cancelledByApp: { reason: unknown } | undefined

    async function readForLog(
      reader: ReadableStreamDefaultReader<Uint8Array>,
      isSse: boolean,
    ): Promise<void> {
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          if (text !== '') record((logId) => log.recordText(logId, text, { sse: isSse }))
        }
        if (cancelledByApp !== undefined) {
          // cancel() で読み取りが done になっただけ。完了ではない
          finishCancelled(cancelledByApp.reason)
          return
        }
        // 途中で切れたマルチバイト文字の残りを吐き出す
        const rest = decoder.decode()
        if (rest !== '') record((logId) => log.recordText(logId, rest, { sse: isSse }))
        record((logId) => log.finish(logId, { state: 'done' }))
      } catch (error) {
        finishWithError(error, MID_STREAM_HINT)
      }
    }

    function finishCancelled(reason: unknown): void {
      // 停止ボタンなどで abort したあとの cancel は、エラーではなく中断として残す
      if (shaped.fetchInit.signal?.aborted === true) {
        record((logId) => log.finish(logId, { state: 'aborted' }))
        return
      }
      const cause = reason === undefined ? undefined : describeError(reason)
      const info: ErrorInfo = {
        name: STREAM_CANCELLED_ERROR,
        message:
          cause === undefined
            ? 'クライアントがレスポンスの読み取りをキャンセルしました（理由は渡されていません）'
            : `クライアントがレスポンスの読み取りをキャンセルしました（${cause.name}: ${cause.message}）`,
        hint: CANCELLED_HINT,
      }
      record((logId) => log.finish(logId, { state: 'error', error: info }))
    }

    // 片方はアプリへ返し、もう片方をログ用にバックグラウンドで読む
    const [forApp, forLog] = res.body.tee()
    const logReader = forLog.getReader()
    const sse = (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
    void readForLog(logReader, sse)

    let appBody: ReadableStream<Uint8Array> | null
    if (NULL_BODY_STATUSES.has(res.status)) {
      // ボディ付きの Response は作れない。片側を閉じるだけでログ側の読み取りには影響しない
      void forApp.cancel().catch(() => {})
      appBody = null
    } else {
      appBody = relayWithCancelHook(forApp, (reason) => {
        cancelledByApp = { reason }
        // アプリ側が読まないなら上流も読み続けない（tee は両方の枝が cancel されて初めて上流を止める）
        void logReader.cancel(reason).catch(() => {})
      })
    }
    return new Response(appBody, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}
