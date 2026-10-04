import { useState } from 'react'
import { CompletionErrorAlert } from '@/components/completion/completion-error-alert'
import { CompletionPromptForm } from '@/components/completion/completion-prompt-form'
import { CompletionResult } from '@/components/completion/completion-result'
import { Badge } from '@/components/ui/badge'
import { useCompletionRunner } from '@/hooks/use-completion-runner'
import { useSettings } from '@/hooks/use-settings'
import { PROXY_NAME } from '@/lib/proxy'
import type { CompletionProtocol } from '@/types'

const PROTOCOL_LABELS: Record<CompletionProtocol, string> = {
  data: 'data（UI Message Stream）',
  text: 'text（プレーンテキスト）',
}

/**
 * useCompletion の動作確認ビュー。プロトコルは設定パネルの値に追従する。
 * 出力はビューを切り替えても保持される（シェルが訪問済みのビューをマウントしたままにするため）。
 */
export function CompletionView() {
  const { settings } = useSettings()
  const runner = useCompletionRunner()
  const [prompt, setPrompt] = useState('')
  const [markdown, setMarkdown] = useState(false)

  const generate = () => {
    if (runner.isLoading || prompt === '') return
    void runner.run(prompt)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">Completion</h2>
        <Badge variant="outline" className="font-mono">
          プロトコル: {PROTOCOL_LABELS[settings.completionProtocol]}
        </Badge>
        <span className="text-xs text-muted-foreground">
          設定パネルで変更できます。ヘッダー・Bearer・追加ボディ・{PROXY_NAME}
          も設定パネルの値が自動で適用されます。
        </span>
      </header>

      <CompletionPromptForm
        value={prompt}
        onChange={setPrompt}
        onGenerate={generate}
        onStop={runner.stop}
        onClear={runner.clear}
        isLoading={runner.isLoading}
        canClear={runner.completion !== '' || runner.error !== undefined || runner.emptyResult}
      />

      {runner.error !== undefined && (
        <CompletionErrorAlert error={runner.error} protocol={settings.completionProtocol} />
      )}

      <CompletionResult
        completion={runner.completion}
        isLoading={runner.isLoading}
        markdown={markdown}
        onMarkdownChange={setMarkdown}
        emptyResult={runner.emptyResult}
      />

      <p className="shrink-0 text-xs text-muted-foreground">
        詳細はインスペクタ（ログ・SSE イベント・cURL）で確認できます。
      </p>
    </div>
  )
}
