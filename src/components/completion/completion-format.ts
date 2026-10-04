import { PROXY_NAME, PROXY_TOGGLE_LABEL } from '@/lib/proxy'
import type { CompletionProtocol } from '@/types'

/** UTF-16 のコードユニットではなく、見た目に近いコードポイント単位で数える（絵文字を 2 文字と数えない）。 */
export function countCharacters(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
    }
    count++
  }
  return count
}

export type CompletionErrorKind = 'shape' | 'http' | 'protocol' | 'stream' | 'network' | 'other'

export interface CompletionErrorInfo {
  kind: CompletionErrorKind
  title: string
  message: string
  statusCode?: number
  /** 原因の候補・対処。分からなければ undefined */
  hint?: string
}

const FETCH_FAILURE_RE = /failed to fetch|networkerror|load failed|fetch failed/i

function statusCodeOf(error: Error): number | undefined {
  // APICallError（非 2xx のレスポンス）。ai の型に依存せず、形で判定する
  const code = (error as { statusCode?: unknown }).statusCode
  return typeof code === 'number' ? code : undefined
}

/**
 * data プロトコルでの解釈エラーのヒント。
 * AI_TypeValidationError は SSE 自体が正常でも chunk の形が SDK の仕様と違えば起きるため、
 * 「text に切り替える」だけを案内すると本当の原因（chunk の不一致）を見誤らせる。両方の可能性を示す。
 */
function dataProtocolHint(errorName: string): string {
  if (errorName === 'AI_TypeValidationError') {
    return 'SSE の chunk が AI SDK の仕様に合っていません。インスペクタの「診断」タブに、合わない chunk とその理由が出ます。バックエンドが text プロトコル（プレーンテキスト）なら、設定パネルで Completion のプロトコルを text にしてください。'
  }
  return 'data プロトコルは UI Message Stream（SSE）を期待します。サーバーがプレーンテキストを返す場合は、設定パネルでプロトコルを「text」に切り替えてください。'
}

/** useCompletion が返した Error を、画面に出す見出し・本文・ヒントに分類する。 */
export function describeCompletionError(
  error: Error,
  protocol: CompletionProtocol,
): CompletionErrorInfo {
  const statusCode = statusCodeOf(error)
  const message = error.message !== '' ? error.message : error.name

  if (error.name === 'RequestShapeError') {
    return {
      kind: 'shape',
      title: 'リクエストを組み立てられませんでした',
      message,
      hint: `設定パネルのエンドポイント・ヘッダー・追加ボディ・${PROXY_NAME}の設定を確認してください。`,
    }
  }
  if (statusCode !== undefined) {
    return {
      kind: 'http',
      title: `サーバーがエラーを返しました（HTTP ${statusCode}）`,
      message: error.message !== '' ? error.message : `HTTP ${statusCode}`,
      statusCode,
      hint: 'レスポンスの内容はインスペクタのログで確認できます。',
    }
  }
  if (error.name === 'AI_UIMessageStreamError') {
    return {
      kind: 'stream',
      title: 'ストリーム内でエラーが返されました',
      message,
      hint: 'サーバーが UI Message Stream の error チャンクを返しました。',
    }
  }
  if (error.name === 'AI_JSONParseError' || error.name === 'AI_TypeValidationError') {
    return {
      kind: 'protocol',
      title: 'レスポンスを解釈できませんでした',
      message,
      hint: protocol === 'data' ? dataProtocolHint(error.name) : undefined,
    }
  }
  if (error.name === 'TypeError' && FETCH_FAILURE_RE.test(error.message)) {
    return {
      kind: 'network',
      title: '通信に失敗しました',
      message,
      hint: `CORS で拒否された、サーバーに接続できない、のいずれかの可能性があります。CORS が原因なら設定パネルの「${PROXY_TOGGLE_LABEL}」を ON にすると回避できます。`,
    }
  }
  return { kind: 'other', title: '生成に失敗しました', message }
}
