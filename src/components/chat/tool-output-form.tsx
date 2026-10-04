import { useId, useMemo, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  DEFAULT_TOOL_ERROR_TEXT,
  describeParsedOutput,
  parseToolOutputText,
} from '@/components/chat/chat-utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export interface ToolOutputFormProps {
  toolName: string
  onOutput: (output: unknown) => void
  onError: (errorText: string) => void
}

/**
 * クライアント実行ツールの出力を手で返すフォーム。
 * 入力が JSON として解釈できれば JSON 値、できなければ文字列として addToolOutput に渡す。
 */
export function ToolOutputForm({ toolName, onOutput, onError }: ToolOutputFormProps) {
  const [text, setText] = useState('')
  const fieldId = useId()
  const hintId = useId()
  const parsed = useMemo(() => parseToolOutputText(text), [text])

  const submitOutput = () => {
    if (parsed.kind === 'empty') return
    onOutput(parsed.value)
  }
  const submitError = () => {
    const errorText = text.trim()
    onError(errorText === '' ? DEFAULT_TOOL_ERROR_TEXT : errorText)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submitOutput()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME の変換確定 Enter では送らない。Ctrl / Cmd + Enter で出力を返す
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      submitOutput()
    }
  }

  return (
    <form
      className="space-y-2 rounded-md border border-dashed bg-muted/30 p-3"
      onSubmit={handleSubmit}
      aria-label={`${toolName} の出力`}
    >
      <label htmlFor={fieldId} className="block font-medium text-xs">
        クライアントツールの出力（JSON または文字列）
      </label>
      <Textarea
        id={fieldId}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        placeholder={'{"ok": true}'}
        className="min-h-16 font-mono text-xs md:text-xs"
        aria-describedby={hintId}
        spellCheck={false}
      />
      <p id={hintId} className="text-muted-foreground text-xs">
        {`${describeParsedOutput(parsed)}。「エラーを返す」は入力内容を errorText として送ります（空なら既定の文言）。Ctrl / Cmd + Enter で出力を返します。`}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={submitError}>
          エラーを返す
        </Button>
        <Button type="submit" size="sm" disabled={parsed.kind === 'empty'}>
          出力を返す
        </Button>
      </div>
    </form>
  )
}
