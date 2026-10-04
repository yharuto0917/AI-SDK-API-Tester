import { useCompletion } from '@ai-sdk/react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useSettings } from '@/hooks/use-settings'
import { settingsStore } from '@/lib/settings-store'
import { createTesterFetch } from '@/lib/tester-fetch'

export interface CompletionRunner {
  completion: string
  isLoading: boolean
  /** クリアしたエラーは含まない */
  error: Error | undefined
  /** 正常に完了したのに出力が空だった（プロトコル設定の不一致を疑う目安） */
  emptyResult: boolean
  run: (prompt: string) => Promise<void>
  /** 通信を止める。それまでに届いた出力は残る */
  stop: () => void
  /** 出力とエラーを消す */
  clear: () => void
}

/**
 * useCompletion を、設定ストアに追従する形で包む。
 * - streamProtocol / fetch は呼び出しのたびに最新の値が使われるので、そのまま渡せば設定の変更に追従する
 * - api は SWR のキー（出力の保存先）に含まれ、変わると出力が消える。さらに実際の宛先は
 *   tester-fetch が毎回設定から解決するため、マウント時の値で固定した「飾り」として渡す
 */
export function useCompletionRunner(): CompletionRunner {
  const { settings } = useSettings()
  const [api] = useState(() => settingsStore.getSettings().endpoints.completion)
  const testerFetch = useMemo(() => createTesterFetch({ mode: 'completion' }), [])

  const { completion, complete, stop, setCompletion, isLoading, error } = useCompletion({
    api,
    fetch: testerFetch,
    streamProtocol: settings.completionProtocol,
  })

  // useCompletion は error を外から消せないので、消したエラーを覚えて表示から除く
  const [dismissedError, setDismissedError] = useState<Error | undefined>(undefined)
  const [emptyResult, setEmptyResult] = useState(false)
  const runningRef = useRef(false)

  const run = useCallback(
    async (prompt: string) => {
      // isLoading の反映を待たずに二重実行を防ぐ
      if (runningRef.current) return
      runningRef.current = true
      setEmptyResult(false)
      try {
        const result = await complete(prompt)
        // 中止は null、失敗は undefined。空文字は「最後まで受信できたが本文が無かった」
        if (result === '') setEmptyResult(true)
      } finally {
        runningRef.current = false
      }
    },
    [complete],
  )

  const clear = useCallback(() => {
    setCompletion('')
    setDismissedError(error)
    setEmptyResult(false)
  }, [setCompletion, error])

  return {
    completion,
    isLoading,
    error: error !== undefined && error !== dismissedError ? error : undefined,
    emptyResult,
    run,
    stop,
    clear,
  }
}
