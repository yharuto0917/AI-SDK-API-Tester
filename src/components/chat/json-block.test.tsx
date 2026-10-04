// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { JsonBlock } from '@/components/chat/json-block'
import { HIGHLIGHT_MAX_CHARS } from '@/components/inspector/json-utils'

// ハイライト結果を返さない → CodeBlock は即時表示の生トークンのまま動く（shiki 本体は jsdom では重い）
vi.mock('shiki', () => ({ createHighlighter: () => new Promise(() => {}) }))

function mode(container: HTMLElement): string | null | undefined {
  return container.querySelector('[data-json-block]')?.getAttribute('data-json-block')
}

describe('JsonBlock', () => {
  it('閾値ちょうどまでは CodeBlock でハイライトし、超えたら素の pre にする', () => {
    const atLimit = render(<JsonBlock code={'x'.repeat(HIGHLIGHT_MAX_CHARS)} />)
    expect(mode(atLimit.container)).toBe('highlighted')
    atLimit.unmount()

    const over = render(<JsonBlock code={'x'.repeat(HIGHLIGHT_MAX_CHARS + 1)} />)
    expect(mode(over.container)).toBe('plain')
    // 巨大な JSON でもトークンごとの span は作らず、全文を 1 つのテキストとして持つ
    expect(over.container.querySelectorAll('pre span')).toHaveLength(0)
    expect(over.container.querySelector('pre')?.textContent).toHaveLength(HIGHLIGHT_MAX_CHARS + 1)
  })

  it('plain 指定の間は短くても素の pre にし、外すとハイライトに戻る', () => {
    const { container, rerender } = render(<JsonBlock code={'{"a":1}'} plain />)
    expect(mode(container)).toBe('plain')
    expect(container.querySelector('pre')?.textContent).toBe('{"a":1}')

    rerender(<JsonBlock code={'{"a":1}'} plain={false} />)
    expect(mode(container)).toBe('highlighted')
  })

  it('ヘッダーはどちらの表示でも本文の上に出る', () => {
    const header = <div data-testid="header">見出し</div>
    const { container, rerender } = render(<JsonBlock code="{}" header={header} />)
    expect(screen.getByTestId('header')).toBeTruthy()
    expect(mode(container)).toBe('highlighted')

    rerender(<JsonBlock code="{}" header={header} plain />)
    expect(screen.getByTestId('header')).toBeTruthy()
    expect(mode(container)).toBe('plain')
  })

  it('素の pre は既定で高さ上限を持ち、preClassName で外せる', () => {
    const { container, rerender } = render(<JsonBlock code="{}" plain />)
    expect(container.querySelector('pre')?.className).toContain('max-h-96')

    rerender(<JsonBlock code="{}" plain preClassName="max-h-none" />)
    const className = container.querySelector('pre')?.className ?? ''
    expect(className).toContain('max-h-none')
    expect(className).not.toContain('max-h-96')
  })
})
