import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, TextStreamChatTransport, generateId } from 'ai'
import type { ChatStatus, ChatTransport, FileUIPart, UIMessage } from 'ai'
import { useCallback, useMemo, useRef, useState } from 'react'
import { hasPendingContinuation, hasStaleApprovalResponse } from '@/components/chat/chat-utils'
import type { ChatMode } from '@/components/chat/chat-utils'
import { settingsStore } from '@/lib/settings-store'
import { createTesterFetch } from '@/lib/tester-fetch'

export interface ChatSendInput {
  text: string
  files?: FileUIPart[]
}

export interface ChatSession {
  messages: UIMessage[]
  status: ChatStatus
  error: Error | undefined
  /** ユーザーが返したツール出力 / 承認応答が揃っていて、再送すれば会話が進む状態 */
  canResubmit: boolean
  /** 再送待ちのまま、自動再送が走らない状態（中断・失敗した、または自動再送が無効の間に揃った）。手動で送るしかない */
  resubmitStalled: boolean
  /** 再送待ちだが、SDK が古いメッセージへ継続してしまうので送れない状態（hasStaleApprovalResponse） */
  resubmitBlocked: boolean
  send: (input: ChatSendInput) => void
  stop: () => void
  /** 進行中なら止めて、メッセージとエラーを消し、新しい chat id に切り替える */
  newConversation: () => void
  regenerate: () => void
  /** 再送できる再送待ちなら継続リクエストを、そうでなければ再生成を行う */
  retry: () => void
  /** 本文なしで現在のメッセージを再送する（ツール出力 / 承認応答を送る）。resubmitBlocked の間は何もしない */
  resubmit: () => void
  clearError: () => void
  addToolOutput: (args: { tool: string; toolCallId: string; output: unknown }) => void
  addToolError: (args: { tool: string; toolCallId: string; errorText: string }) => void
  respondToApproval: (args: { id: string; approved: boolean; reason?: string }) => void
}

function createTransport(mode: ChatMode): ChatTransport<UIMessage> {
  // 実際の送信先・ヘッダー等は fetch 側が呼び出しのたびに設定から解決する。api はあくまで飾り
  const options = {
    api: settingsStore.getSettings().endpoints[mode],
    fetch: createTesterFetch({ mode }),
  }
  return mode === 'chat-ui'
    ? new DefaultChatTransport<UIMessage>(options)
    : new TextStreamChatTransport<UIMessage>(options)
}

/** 非同期の操作を投げっぱなしにする。SDK は通信エラーを status / error に載せるので、ここに来るのは想定外の例外だけ。 */
function fireAndForget(task: PromiseLike<unknown> | void): void {
  if (task === undefined) return
  void Promise.resolve(task).catch((error: unknown) => {
    console.error('[chat] 操作に失敗しました', error)
  })
}

/**
 * Chat ビュー 1 つ分の会話状態。
 * useChat は options.id が変わるまで Chat を作り直さず、transport / コールバックは毎レンダー最新を参照する。
 * 設定（ヘッダー等）の変更は createTesterFetch が呼び出し時に読むので、会話を保ったまま次の送信から反映される。
 */
export function useChatSession(mode: ChatMode): ChatSession {
  const transport = useMemo(() => createTransport(mode), [mode])

  // 会話ごとの id。サーバー側に履歴を持つバックエンドは body.id でスレッドを引くので、「新しい会話」では必ず差し替える。
  // useChat は id が変わると Chat を作り直すため、SDK 内部の状態（承認待ち・再開用のストリーム）も一緒に初期化される
  const [chatId, setChatId] = useState(() => generateId())

  // ユーザーがツール出力 / 承認応答を返し、まだサーバーへ届いていない状態。
  // 自動再送はこの間だけ許す。サーバー実行ツールで終わる応答まで再送すると、継続リクエストを
  // 解釈しないサーバーでは同じ状態が返り続けて無限に再送してしまうため（SDK の既知の落とし穴）。
  // 同期的に読む必要があるので ref と、再描画用の state の両方で持つ
  const continuationRef = useRef(false)
  const [continuationPending, setContinuationPending] = useState(false)
  // 自動再送が走らないまま残っている再送待ち。画面に手動で送る手段を出すために使う
  const [continuationStalled, setContinuationStalled] = useState(false)
  const markContinuation = useCallback((pending: boolean) => {
    continuationRef.current = pending
    setContinuationPending(pending)
    if (!pending) setContinuationStalled(false)
  }, [])
  // いま飛んでいるリクエストが継続リクエストか。失敗・中断なら「未送信」に戻して再試行できるようにする
  const carryingRef = useRef(false)
  /** ユーザーが別の操作（新規送信・再生成・会話のリセット）を始めたので、未送信の継続は破棄する */
  const resetContinuation = useCallback(() => {
    carryingRef.current = false
    markContinuation(false)
  }, [markContinuation])

  const sendAutomaticallyWhen =
    mode === 'chat-ui'
      ? ({ messages }: { messages: UIMessage[] }): boolean => {
          if (!continuationRef.current || !hasPendingContinuation(messages)) return false
          if (!settingsStore.getSettings().autoSendAfterToolOutput) {
            // 無効の間に揃った分は、あとで設定を ON にしても SDK は送らない。手動で送れる状態として覚えておく
            setContinuationStalled(true)
            return false
          }
          // true を返すと SDK は必ず再送する
          carryingRef.current = true
          markContinuation(false)
          return true
        }
      : undefined

  const handleFinish = ({
    isAbort,
    isDisconnect,
    isError,
  }: {
    isAbort: boolean
    isDisconnect: boolean
    isError: boolean
  }) => {
    const failed = isAbort || isDisconnect || isError
    const wasCarrying = carryingRef.current
    carryingRef.current = false
    if (wasCarrying) {
      // 継続リクエストが届かなかったので「未送信」に戻す。自動再送は走らないので手動の手段も出す
      if (failed) {
        markContinuation(true)
        setContinuationStalled(true)
      }
      return
    }
    // 継続ではない通信が中断・失敗した。SDK は中断・失敗のあとに自動再送しないので、保留中の継続は手動で送るしかない
    if (failed && continuationRef.current) setContinuationStalled(true)
  }

  const chat = useChat({ id: chatId, transport, sendAutomaticallyWhen, onFinish: handleFinish })
  const {
    messages,
    status,
    error,
    sendMessage,
    regenerate,
    stop,
    clearError,
    addToolOutput,
    addToolApprovalResponse,
  } = chat

  const canResubmit = useMemo(
    () => continuationPending && hasPendingContinuation(messages),
    [continuationPending, messages],
  )
  const resubmitBlocked = useMemo(
    () => canResubmit && hasStaleApprovalResponse(messages),
    [canResubmit, messages],
  )

  const send = useCallback(
    (input: ChatSendInput) => {
      const text = input.text.trim()
      const files = input.files ?? []
      if (text === '' && files.length === 0) return
      resetContinuation()
      if (files.length === 0) fireAndForget(sendMessage({ text }))
      else if (text === '') fireAndForget(sendMessage({ files }))
      else fireAndForget(sendMessage({ text, files }))
    },
    [sendMessage, resetContinuation],
  )

  const stopGeneration = useCallback(() => {
    fireAndForget(stop())
  }, [stop])

  const newConversation = useCallback(() => {
    resetContinuation()
    // abort は同期的に行われ、旧 Chat への以降のストリーム書き込みは signal を見て捨てられる。
    // メッセージもエラーも、id を替えて作り直す新しい Chat が空の状態から始まる
    fireAndForget(stop())
    setChatId(generateId())
  }, [stop, resetContinuation])

  const regenerateLast = useCallback(() => {
    resetContinuation()
    fireAndForget(regenerate())
  }, [regenerate, resetContinuation])

  const resubmit = useCallback(() => {
    // 引数なしの sendMessage は古い承認応答のあるメッセージへ継続してしまう。誤った宛先に送らず、画面側で案内する
    if (resubmitBlocked) return
    carryingRef.current = true
    markContinuation(false)
    fireAndForget(sendMessage())
  }, [resubmitBlocked, sendMessage, markContinuation])

  const retry = useCallback(() => {
    // 送れない再送待ちは、再生成でやり直すしかない
    if (canResubmit && !resubmitBlocked) resubmit()
    else regenerateLast()
  }, [canResubmit, resubmitBlocked, resubmit, regenerateLast])

  const addOutput = useCallback<ChatSession['addToolOutput']>(
    ({ tool, toolCallId, output }) => {
      markContinuation(true)
      fireAndForget(addToolOutput({ tool, toolCallId, output }))
    },
    [addToolOutput, markContinuation],
  )

  const addError = useCallback<ChatSession['addToolError']>(
    ({ tool, toolCallId, errorText }) => {
      markContinuation(true)
      fireAndForget(addToolOutput({ tool, toolCallId, state: 'output-error', errorText }))
    },
    [addToolOutput, markContinuation],
  )

  const respondToApproval = useCallback<ChatSession['respondToApproval']>(
    ({ id, approved, reason }) => {
      markContinuation(true)
      fireAndForget(
        addToolApprovalResponse(reason === undefined ? { id, approved } : { id, approved, reason }),
      )
    },
    [addToolApprovalResponse, markContinuation],
  )

  return {
    messages,
    status,
    error,
    canResubmit,
    resubmitStalled: continuationStalled,
    resubmitBlocked,
    send,
    stop: stopGeneration,
    newConversation,
    regenerate: regenerateLast,
    retry,
    resubmit,
    clearError,
    addToolOutput: addOutput,
    addToolError: addError,
    respondToApproval,
  }
}
