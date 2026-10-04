import { createContext, useContext } from 'react'

/**
 * メッセージ描画から会話を操作するための窓口。
 * ツリーが深い（メッセージ → パート → ツール → フォーム）ので props の受け渡しを避けて Context にする。
 * 値は ChatView が useMemo で安定させ、過去メッセージの再描画を抑える。
 */
export interface ChatActions {
  /** false ならアシスタントのテキストを Markdown 変換せず生テキストで見せる */
  markdown: boolean
  addToolOutput: (args: { tool: string; toolCallId: string; output: unknown }) => void
  addToolError: (args: { tool: string; toolCallId: string; errorText: string }) => void
  respondToApproval: (args: { id: string; approved: boolean; reason?: string }) => void
}

export const ChatActionsContext = createContext<ChatActions | null>(null)

export function useChatActions(): ChatActions {
  const actions = useContext(ChatActionsContext)
  if (actions === null) {
    throw new Error('useChatActions は ChatActionsContext.Provider の内側で使ってください')
  }
  return actions
}
