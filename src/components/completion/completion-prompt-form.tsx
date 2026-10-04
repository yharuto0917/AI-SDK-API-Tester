import { Eraser, Sparkles, Square } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'

const SAMPLE_PROMPTS = [
  '日本の四季について 3 行で説明してください。',
  'Markdown の見出しとリストを使って、自己紹介を書いてください。',
  '1 から 20 までの数を、1 行ずつ出力してください。',
]

export interface CompletionPromptFormProps {
  value: string
  onChange: (value: string) => void
  onGenerate: () => void
  onStop: () => void
  onClear: () => void
  isLoading: boolean
  /** クリアする出力（またはエラー）がある */
  canClear: boolean
}

/** 変換確定の Enter と取り違えない。Safari は確定の keydown が isComposing=false で keyCode=229 になる。 */
function isComposing(event: KeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

/**
 * プロンプト入力と「生成 / 停止 / クリア」。
 * PromptInput は送信のたびに入力を空にするため、同じプロンプトを少しずつ変えて試す用途には合わず、
 * 入力が残る InputGroup + textarea で組む。Enter は改行、Cmd/Ctrl+Enter で生成する。
 */
export function CompletionPromptForm({
  value,
  onChange,
  onGenerate,
  onStop,
  onClear,
  isLoading,
  canClear,
}: CompletionPromptFormProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isComposing(event)) {
      event.preventDefault()
      onGenerate()
    }
  }

  return (
    <section aria-label="プロンプト" className="flex shrink-0 flex-col gap-2">
      <Suggestions aria-label="プロンプトの例">
        {SAMPLE_PROMPTS.map((prompt) => (
          <Suggestion
            key={prompt}
            suggestion={prompt}
            onClick={onChange}
            disabled={isLoading}
            className="h-7 px-3 text-xs"
          />
        ))}
      </Suggestions>

      <InputGroup>
        <InputGroupTextarea
          aria-label="プロンプト"
          className="max-h-48 min-h-20 text-sm"
          placeholder="プロンプトを入力してください"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <InputGroupAddon align="block-end" className="justify-between gap-2">
          <span className="flex items-center gap-1 text-xs font-normal">
            <Kbd>⌘ / Ctrl</Kbd>
            <span aria-hidden>+</span>
            <Kbd>Enter</Kbd>
            で生成（Enter は改行）
          </span>
          <div className="flex items-center gap-1.5">
            <InputGroupButton size="sm" onClick={onClear} disabled={!canClear || isLoading}>
              <Eraser aria-hidden />
              クリア
            </InputGroupButton>
            <InputGroupButton size="sm" variant="outline" onClick={onStop} disabled={!isLoading}>
              <Square aria-hidden />
              停止
            </InputGroupButton>
            <InputGroupButton
              size="sm"
              variant="default"
              onClick={onGenerate}
              disabled={isLoading || value === ''}
            >
              <Sparkles aria-hidden />
              生成
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </section>
  )
}
