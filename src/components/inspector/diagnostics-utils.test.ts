import { describe, expect, it } from 'vitest'
import {
  countLevel,
  LEVEL_LABELS,
  sortDiagnostics,
  worstLevel,
} from '@/components/inspector/diagnostics-utils'
import type { Diagnostic, DiagnosticLevel } from '@/types'

function diag(id: string, level: DiagnosticLevel): Diagnostic {
  return { id, level, title: id }
}

describe('sortDiagnostics', () => {
  it('error → warn → info → ok の順に並べ、同じ level では元の順序を保つ', () => {
    const sorted = sortDiagnostics([
      diag('ok-1', 'ok'),
      diag('info-1', 'info'),
      diag('warn-1', 'warn'),
      diag('error-1', 'error'),
      diag('warn-2', 'warn'),
      diag('error-2', 'error'),
      diag('ok-2', 'ok'),
    ])
    expect(sorted.map((d) => d.id)).toEqual([
      'error-1',
      'error-2',
      'warn-1',
      'warn-2',
      'info-1',
      'ok-1',
      'ok-2',
    ])
  })

  it('元の配列を変更しない', () => {
    const input = [diag('a', 'ok'), diag('b', 'error')]
    sortDiagnostics(input)
    expect(input.map((d) => d.id)).toEqual(['a', 'b'])
  })

  it('空配列でも動く', () => {
    expect(sortDiagnostics([])).toEqual([])
  })
})

describe('worstLevel', () => {
  it('最も重大な level を返す', () => {
    expect(worstLevel([diag('a', 'ok'), diag('b', 'warn'), diag('c', 'info')])).toBe('warn')
    expect(worstLevel([diag('a', 'ok'), diag('b', 'error')])).toBe('error')
    expect(worstLevel([diag('a', 'ok')])).toBe('ok')
  })

  it('診断が無ければ undefined', () => {
    expect(worstLevel([])).toBeUndefined()
  })
})

describe('countLevel', () => {
  it('level ごとの件数を数える', () => {
    const list = [diag('a', 'error'), diag('b', 'error'), diag('c', 'ok')]
    expect(countLevel(list, 'error')).toBe(2)
    expect(countLevel(list, 'ok')).toBe(1)
    expect(countLevel(list, 'warn')).toBe(0)
  })
})

describe('LEVEL_LABELS', () => {
  it('すべての level に日本語の表示名がある', () => {
    expect(Object.keys(LEVEL_LABELS).sort()).toEqual(['error', 'info', 'ok', 'warn'])
  })
})
