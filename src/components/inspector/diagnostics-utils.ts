import type { Diagnostic, DiagnosticLevel } from '@/types'

/** 重大な順。stream-analyzer 内の同名の表は export されていないので、表示側で持つ。 */
export const LEVEL_ORDER: Readonly<Record<DiagnosticLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  ok: 3,
}

export const LEVEL_LABELS: Readonly<Record<DiagnosticLevel, string>> = {
  error: 'エラー',
  warn: '警告',
  info: '情報',
  ok: '正常',
}

/** error → warn → info → ok の順に並べた新しい配列（同じ level 内は元の順序を保つ）。 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort(
      (a, b) =>
        LEVEL_ORDER[a.diagnostic.level] - LEVEL_ORDER[b.diagnostic.level] || a.index - b.index,
    )
    .map(({ diagnostic }) => diagnostic)
}

/** 最も重大な level。診断が無ければ undefined。 */
export function worstLevel(diagnostics: readonly Diagnostic[]): DiagnosticLevel | undefined {
  let worst: DiagnosticLevel | undefined
  for (const { level } of diagnostics) {
    if (worst === undefined || LEVEL_ORDER[level] < LEVEL_ORDER[worst]) worst = level
  }
  return worst
}

/** 指定した level の件数。 */
export function countLevel(diagnostics: readonly Diagnostic[], level: DiagnosticLevel): number {
  let count = 0
  for (const diagnostic of diagnostics) {
    if (diagnostic.level === level) count++
  }
  return count
}
