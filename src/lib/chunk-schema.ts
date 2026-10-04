import { asSchema, uiMessageChunkSchema } from 'ai'

/**
 * UI Message Stream の chunk を、クライアント SDK が使うのと同じスキーマ（uiMessageChunkSchema）で検証する。
 * DefaultChatTransport と useCompletion（data プロトコル）は、この検証に落ちた chunk で AI_TypeValidationError を
 * 投げてストリームを打ち切る。type の名前だけでは見抜けない（v4 の textDelta・id 抜け・finishReason の値違いなど）。
 */

/** 理由に列挙する問題の数の上限。 */
const MAX_ISSUES = 3

interface Issue {
  code?: unknown
  path?: unknown
  expected?: unknown
  values?: unknown
  errors?: unknown
  message?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asIssues(value: unknown): Issue[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function pathOf(issue: Issue): Array<string | number> {
  return Array.isArray(issue.path)
    ? issue.path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number')
    : []
}

function pathLabel(path: Array<string | number>): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`)).join('')
}

function valueAt(data: unknown, path: Array<string | number>): unknown {
  let current = data
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string | number, unknown>)[key]
  }
  return current
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'ありません'
  if (value === null) return 'null です'
  if (typeof value === 'string') {
    return `文字列 "${value.length > 30 ? `${value.slice(0, 30)}…` : value}" です`
  }
  if (Array.isArray(value)) return '配列です'
  if (typeof value === 'object') return 'オブジェクトです'
  if (typeof value === 'number') return `数値 ${String(value)} です`
  if (typeof value === 'boolean') return `真偽値 ${String(value)} です`
  return `${typeof value} ${String(value)} です`
}

/** 日本語の「が」に ASCII（null など）が直接つながると読みづらいので、間に空白を入れる。 */
function spaced(text: string): string {
  return /^[\u0020-\u007e]/.test(text) ? ` ${text}` : text
}

/** 1 つの問題を、フィールド名つきの日本語 1 文にする。 */
function describeIssue(issue: Issue, data: unknown): string {
  const path = pathOf(issue)
  const field = path.length > 0 ? `「${pathLabel(path)}」` : '値'
  const actual = valueAt(data, path)
  if (issue.code === 'invalid_type' && typeof issue.expected === 'string') {
    const state = actual === undefined ? 'がありません' : `が${spaced(describeValue(actual))}`
    // zod 4 は unknown 型のフィールドも必須として扱い、無いと expected が 'nonoptional' になる（型名ではない）
    const need = issue.expected === 'nonoptional' ? '必須です' : `${issue.expected} が必要`
    return `${field}${state}（${need}）`
  }
  if (issue.code === 'invalid_value' && Array.isArray(issue.values)) {
    const allowed = issue.values.map((v) => JSON.stringify(v)).join(', ')
    const shown = typeof actual === 'string' ? `"${actual}"` : describeValue(actual)
    return `${field}が ${shown}（使える値: ${allowed}）`
  }
  return `${field}: ${typeof issue.message === 'string' ? issue.message : '形式が正しくありません'}`
}

/**
 * zod の invalid_union（UIMessageChunk は type ごとの union）から、type が一致したブランチの問題だけを取り出す。
 * どのブランチも type で落ちていれば、未知の type（または JSON オブジェクトではない値）。
 */
function matchingBranchIssues(issues: Issue[]): Issue[] | undefined {
  for (const issue of issues) {
    if (issue.code !== 'invalid_union' || !Array.isArray(issue.errors)) continue
    for (const branch of issue.errors) {
      const branchIssues = asIssues(branch)
      const failsOnType = branchIssues.some((i) => {
        const path = pathOf(i)
        return path.length === 1 && path[0] === 'type'
      })
      const failsOnShape = branchIssues.some((i) => pathOf(i).length === 0)
      if (!failsOnType && !failsOnShape) return branchIssues
    }
  }
  return undefined
}

function describeUnmatched(data: unknown): string {
  if (!isRecord(data)) return 'JSON オブジェクトではないため、UIMessageChunk として解釈できません'
  const type = data.type
  if (typeof type !== 'string') return '「type」が文字列ではありません'
  return `type「${type}」は UIMessageChunk にありません`
}

/** SDK のスキーマ検証にかけたときの、日本語の失敗理由（検証に通るなら undefined）。 */
function describeFailure(error: unknown, data: unknown): string {
  const issues = asIssues(isRecord(error) ? error.issues : undefined)
  const branch = matchingBranchIssues(issues)
  if (branch === undefined) return describeUnmatched(data)
  const lines = branch.slice(0, MAX_ISSUES).map((issue) => describeIssue(issue, data))
  if (branch.length > MAX_ISSUES) lines.push(`…ほか ${branch.length - MAX_ISSUES} 件`)
  return lines.join(' / ')
}

/**
 * chunk（SSE の data を JSON.parse した値）が SDK のスキーマに合わなければ理由を返す。合えば undefined。
 * 検証そのものが例外になった場合も、診断を止めないよう undefined（検証できなかった）として扱う。
 */
export async function validateUiChunk(data: unknown): Promise<string | undefined> {
  try {
    const schema = asSchema(uiMessageChunkSchema)
    const result = await schema.validate?.(data)
    if (result === undefined || result.success) return undefined
    return describeFailure(result.error, data)
  } catch {
    return undefined
  }
}
