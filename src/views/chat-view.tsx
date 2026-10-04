import { MessageSquareIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { ChatActionsContext } from '@/components/chat/chat-context'
import type { ChatActions } from '@/components/chat/chat-context'
import { ChatComposer } from '@/components/chat/chat-composer'
import { ChatErrorBanner } from '@/components/chat/chat-error-banner'
import { ChatMessage } from '@/components/chat/chat-message'
import { ChatResubmitBar } from '@/components/chat/chat-resubmit-bar'
import type { ChatResubmitVariant } from '@/components/chat/chat-resubmit-bar'
import { ChatSuggestions } from '@/components/chat/chat-suggestions'
import { ChatToolbar } from '@/components/chat/chat-toolbar'
import { isChatBusy } from '@/components/chat/chat-utils'
import type { ChatMode } from '@/components/chat/chat-utils'
import { MessageJsonDialog } from '@/components/chat/message-json-dialog'
import { useChatSession } from '@/hooks/use-chat-session'
import { useSettings } from '@/hooks/use-settings'
import { MODE_LABELS } from '@/types'

export type ChatViewMode = ChatMode

const EMPTY_DESCRIPTIONS: Record<ChatViewMode, string> = {
  'chat-ui':
    'UI Message Stream（SSE）で応答を受け取ります。下のチップでモックサーバーの各シナリオを試せます。',
  'chat-text': 'Text Stream（プレーンテキスト）で応答を受け取ります。',
}

/**
 * Chat 接続の確認ビュー。モードごとに 1 インスタンスで、会話状態はインスタンスごとに独立する。
 * 設定の変更は会話を保ったまま、次の送信から反映される（リクエストは送信時に設定から組み立てる）。
 */
export function ChatView({ mode }: { mode: ChatViewMode }) {
  const session = useChatSession(mode)
  const { settings } = useSettings()
  const [markdown, setMarkdown] = useState(true)
  const [jsonOpen, setJsonOpen] = useState(false)

  const {
    messages,
    status,
    error,
    canResubmit,
    resubmitStalled,
    resubmitBlocked,
    send,
    stop,
    newConversation,
    regenerate,
    retry,
    resubmit,
    clearError,
    addToolOutput,
    addToolError,
    respondToApproval,
  } = session

  const busy = isChatBusy(status)
  const lastIndex = messages.length - 1

  const actions = useMemo<ChatActions>(
    () => ({ markdown, addToolOutput, addToolError, respondToApproval }),
    [markdown, addToolOutput, addToolError, respondToApproval],
  )

  const sendText = useCallback((text: string) => send({ text }), [send])

  // 自動再送が有効でも、中断・失敗して届いていない継続は手動で送れるようにする（自動再送の直前の点滅は出さない）
  const autoSend = settings.autoSendAfterToolOutput
  const showResubmitBar =
    mode === 'chat-ui' && canResubmit && !busy && (resubmitStalled || !autoSend)
  const resubmitVariant: ChatResubmitVariant = resubmitBlocked
    ? 'blocked'
    : autoSend
      ? 'stalled'
      : 'manual'

  return (
    <ChatActionsContext.Provider value={actions}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <ChatToolbar
          status={status}
          messageCount={messages.length}
          canRegenerate={!busy && messages.some((message) => message.role === 'assistant')}
          canClear={messages.length > 0 || error !== undefined || busy}
          markdown={markdown}
          onMarkdownChange={setMarkdown}
          onNewConversation={newConversation}
          onRegenerate={regenerate}
          onShowJson={() => setJsonOpen(true)}
        />
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto min-h-full w-full max-w-3xl gap-6 p-4">
            {messages.length === 0 ? (
              <ConversationEmptyState className="flex-1">
                <MessageSquareIcon className="size-8 text-muted-foreground" aria-hidden />
                <div className="space-y-1">
                  <h3 className="font-medium text-sm">{MODE_LABELS[mode]} で会話を始める</h3>
                  <p className="text-muted-foreground text-sm">{EMPTY_DESCRIPTIONS[mode]}</p>
                </div>
                <ChatSuggestions mode={mode} onSend={sendText} />
              </ConversationEmptyState>
            ) : (
              <>
                {messages.map((message, index) => (
                  <ChatMessage
                    key={`${index}:${message.id}`}
                    message={message}
                    isLastMessage={index === lastIndex}
                    chatStatus={index === lastIndex ? status : undefined}
                  />
                ))}
                {status === 'submitted' ? (
                  <Message from="assistant">
                    <MessageContent>
                      <Shimmer>応答を待っています...</Shimmer>
                    </MessageContent>
                  </Message>
                ) : null}
              </>
            )}
          </ConversationContent>
          <ConversationScrollButton aria-label="最新のメッセージへスクロール" />
        </Conversation>
        {showResubmitBar ? (
          <ChatResubmitBar
            variant={resubmitVariant}
            onResubmit={resubmit}
            onRegenerate={regenerate}
          />
        ) : null}
        {error !== undefined ? (
          <ChatErrorBanner error={error} onRetry={retry} onDismiss={clearError} />
        ) : null}
        <ChatComposer mode={mode} status={status} onSend={send} onStop={stop} />
        <MessageJsonDialog
          open={jsonOpen}
          onOpenChange={setJsonOpen}
          messages={messages}
          streaming={busy}
        />
      </div>
    </ChatActionsContext.Provider>
  )
}
