import { Suggestion } from '@/components/ai-elements/suggestion'
import {
  GENERAL_PROMPTS,
  scenarioPrompt,
  scenariosFor,
  type ChatMode,
} from '@/components/chat/chat-utils'

export interface ChatSuggestionsProps {
  mode: ChatMode
  onSend: (text: string) => void
}

/**
 * 空状態のクイック送信チップ。クリックで即送信する。
 * 本文先頭の `#name` はモックサーバー専用のシナリオ指定で、他のサーバーには普通のメッセージとして届く。
 */
export function ChatSuggestions({ mode, onSend }: ChatSuggestionsProps) {
  const scenarios = scenariosFor(mode)
  return (
    <div className="flex w-full max-w-2xl flex-col gap-4 text-left">
      <section className="space-y-2" aria-label="モックサーバー用シナリオ">
        <h3 className="font-medium text-muted-foreground text-xs">モックサーバー用シナリオ</h3>
        <div className="flex flex-wrap gap-1.5">
          {scenarios.map((scenario) => (
            <Suggestion
              key={scenario.name}
              suggestion={scenarioPrompt(scenario)}
              onClick={onSend}
              size="xs"
              className="px-2.5 font-mono"
              title={`${scenarioPrompt(scenario)}\n${scenario.description}`}
            >
              #{scenario.name}
            </Suggestion>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          モックサーバー以外では普通のメッセージとして送信されます。
        </p>
      </section>
      <section className="space-y-2" aria-label="例文">
        <h3 className="font-medium text-muted-foreground text-xs">例文</h3>
        <div className="flex flex-wrap gap-1.5">
          {GENERAL_PROMPTS.map((prompt) => (
            <Suggestion
              key={prompt}
              suggestion={prompt}
              onClick={onSend}
              size="xs"
              className="px-2.5"
            />
          ))}
        </div>
      </section>
    </div>
  )
}
