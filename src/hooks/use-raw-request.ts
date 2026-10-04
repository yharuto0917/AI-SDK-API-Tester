import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appendLimited } from '@/components/raw/raw-utils'
import { networkLog } from '@/lib/network-log'
import { PROXY_NAME } from '@/lib/proxy'
import { settingsStore } from '@/lib/settings-store'
import { createTesterFetch } from '@/lib/tester-fetch'

export type RawPhase = 'idle' | 'sending' | 'streaming' | 'done' | 'aborted' | 'error'

export interface RawResponseHeader {
  name: string
  value: string
}

export interface RawRequestError {
  name: string
  message: string
  hint?: string
}

export interface RawRequestState {
  phase: RawPhase
  /** 送信したメソッドと、ユーザーが入力したままのエンドポイント */
  method?: string
  url?: string
  status?: number
  statusText?: string
  contentType?: string
  headers: RawResponseHeader[]
  /** デコード済みのボディ（MAX_BODY_CHARS で打ち切り） */
  body: string
  bodyTruncated: boolean
  /** 受信したバイト数（表示を切り詰めても最後まで数える） */
  bytes: number
  /** リクエスト開始からヘッダー受信まで */
  ttfbMs?: number
  /** リクエスト開始からボディ読み終わり（または失敗・中止）まで */
  totalMs?: number
  error?: RawRequestError
}

export const IDLE_RAW_STATE: RawRequestState = {
  phase: 'idle',
  headers: [],
  body: '',
  bodyTruncated: false,
  bytes: 0,
}

export interface UseRawRequestResult {
  state: RawRequestState
  /** 送信中または受信中 */
  busy: boolean
  /** 設定ストアの現在値（メソッド・エンドポイント・ボディ）で送る */
  send: () => Promise<void>
  abort: () => void
  /** 進行中なら中止したうえで、表示をすべて消す */
  clear: () => void
}

/** ボディが速く流れてきても、再描画はこの間隔にまとめる。 */
const FLUSH_INTERVAL_MS = 50

const SHAPE_ERROR_HINT = `設定パネルのエンドポイント・ヘッダー・${PROXY_NAME}の設定を確認してください。`
const MID_STREAM_HINT =
  'レスポンスの受信中に接続が切断されました。サーバーまたはプロキシが途中で接続を閉じた可能性があります。'

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}

function collectHeaders(headers: Headers): RawResponseHeader[] {
  const list: RawResponseHeader[] = []
  // tsconfig の lib に DOM.Iterable が無いので forEach で集める
  headers.forEach((value, name) => list.push({ name, value }))
  return list
}

/**
 * 送信前・接続時の失敗の補足。fetch 自体の失敗は CORS / 接続不可 / 混在コンテンツの区別がつかないため、
 * 原因の候補は tester-fetch がログに残した hint をそのまま借りる。
 */
function findLogHint(sinceEpochMs: number): string | undefined {
  const entry = networkLog.getEntries().find((e) => e.mode === 'raw' && e.startedAt >= sinceEpochMs)
  return entry?.error?.hint
}

/**
 * Raw ビューの送信と、レスポンスボディのライブ読み取り。
 * ログへの記録は createTesterFetch が行う（tee した別枝）。ここではアプリ側の枝を自分で読んで表示する。
 */
export function useRawRequest(): UseRawRequestResult {
  const [state, setState] = useState<RawRequestState>(IDLE_RAW_STATE)
  const testerFetch = useMemo(() => createTesterFetch({ mode: 'raw' }), [])
  const sessionRef = useRef<{ id: number; controller: AbortController } | null>(null)
  const counterRef = useRef(0)

  const send = useCallback(async () => {
    // 連打で二重に送らない（state の更新を待たずに判定できるよう ref で持つ）
    if (sessionRef.current !== null) return

    const settings = settingsStore.getSettings()
    const method = settings.rawMethod
    const endpoint = settings.endpoints.raw
    const body = settings.rawBody

    const id = ++counterRef.current
    const controller = new AbortController()
    sessionRef.current = { id, controller }
    // clear() や再送で別のセッションに替わったら、古い処理は何も反映しない
    const isCurrent = () => sessionRef.current?.id === id
    const patch = (next: Partial<RawRequestState>) => {
      if (isCurrent()) setState((prev) => ({ ...prev, ...next }))
    }

    const startedAtEpoch = Date.now()
    const t0 = performance.now()
    const elapsed = () => performance.now() - t0

    setState({ ...IDLE_RAW_STATE, phase: 'sending', method, url: endpoint.trim() })

    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const cancelFlush = () => {
      if (flushTimer !== null) clearTimeout(flushTimer)
      flushTimer = null
    }

    try {
      let response: Response
      try {
        const init: RequestInit = { method, signal: controller.signal }
        // 空の body を渡すと '' がそのまま送られてしまうので、空なら省く。GET は body を持てない
        if (method !== 'GET' && body.trim() !== '') init.body = body
        response = await testerFetch(endpoint, init)
      } catch (error) {
        if (controller.signal.aborted) {
          patch({ phase: 'aborted', totalMs: elapsed() })
          return
        }
        const info = describeError(error)
        const hint =
          info.name === 'RequestShapeError' ? SHAPE_ERROR_HINT : findLogHint(startedAtEpoch)
        patch({
          phase: 'error',
          totalMs: elapsed(),
          error: { ...info, ...(hint !== undefined ? { hint } : {}) },
        })
        return
      }

      patch({
        phase: 'streaming',
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type') ?? undefined,
        headers: collectHeaders(response.headers),
        ttfbMs: elapsed(),
      })

      if (response.body === null) {
        patch({ phase: 'done', totalMs: elapsed() })
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
      let truncated = false
      let bytes = 0

      const push = (chunk: string) => {
        if (chunk === '' || truncated) return
        const next = appendLimited(text, chunk)
        text = next.text
        truncated = next.truncated
      }
      const flush = () => patch({ body: text, bodyTruncated: truncated, bytes })
      const scheduleFlush = () => {
        if (flushTimer !== null) return
        flushTimer = setTimeout(() => {
          flushTimer = null
          flush()
        }, FLUSH_INTERVAL_MS)
      }

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // 表示を打ち切った後も読み続ける（合計時間とバイト数を正しく出すため）
          bytes += value.byteLength
          push(decoder.decode(value, { stream: true }))
          scheduleFlush()
        }
        // 途中で切れたマルチバイト文字の残りを吐き出す
        push(decoder.decode())
        cancelFlush()
        patch({ body: text, bodyTruncated: truncated, bytes, phase: 'done', totalMs: elapsed() })
      } catch (error) {
        cancelFlush()
        // 中止や失敗でも、それまでに届いた分は残す
        if (controller.signal.aborted) {
          patch({
            body: text,
            bodyTruncated: truncated,
            bytes,
            phase: 'aborted',
            totalMs: elapsed(),
          })
        } else {
          patch({
            body: text,
            bodyTruncated: truncated,
            bytes,
            phase: 'error',
            totalMs: elapsed(),
            error: { ...describeError(error), hint: MID_STREAM_HINT },
          })
        }
      }
    } finally {
      cancelFlush()
      if (isCurrent()) sessionRef.current = null
    }
  }, [testerFetch])

  const abort = useCallback(() => {
    sessionRef.current?.controller.abort()
  }, [])

  const clear = useCallback(() => {
    const session = sessionRef.current
    sessionRef.current = null
    session?.controller.abort()
    setState(IDLE_RAW_STATE)
  }, [])

  // ビューが外れたら通信を止め、以降の状態更新を打ち切る
  useEffect(
    () => () => {
      const session = sessionRef.current
      sessionRef.current = null
      session?.controller.abort()
    },
    [],
  )

  return {
    state,
    busy: state.phase === 'sending' || state.phase === 'streaming',
    send,
    abort,
    clear,
  }
}
