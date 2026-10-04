// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { CodeView } from '@/components/inspector/code-view'
import { HIGHLIGHT_MAX_CHARS } from '@/components/inspector/json-utils'

// このファイルでは CodeBlock（shiki）を差し替えず、本物との結合を確認する

describe('CodeView（本物の CodeBlock）', () => {
  it('短い JSON は CodeBlock で描画し、ヘッダーに見出しとコピーボタンを出す', async () => {
    const { container } = render(
      <CodeView code={'{\n  "a": 1\n}'} language="json" title="JSON" copyLabel="テスト" />,
    )
    const view = container.querySelector('[data-code-view=highlighted]')
    expect(view).not.toBeNull()
    expect(view?.getAttribute('data-language')).toBe('json')
    expect(view?.textContent).toContain('JSON')
    expect(view?.textContent).toContain('"a"')
    expect(screen.getByRole('button', { name: 'テストをコピー' })).not.toBeNull()

    // shiki の非同期ハイライトが終わっても、本文はそのまま読める
    await waitFor(
      () => expect(view?.querySelectorAll('code span span').length).toBeGreaterThan(1),
      { timeout: 15_000 },
    )
    // 行は display:block の span で表現されるので、textContent には改行が入らない
    expect(view?.querySelector('code')?.textContent?.replace(/\s/g, '')).toBe('{"a":1}')
  })

  it('コピーボタンは code（または copyText）をコピーする', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<CodeView code="short" language="bash" copyLabel="cURL" />)
    await user.click(screen.getByRole('button', { name: 'cURLをコピー' }))
    expect(await navigator.clipboard.readText()).toBe('short')

    rerender(<CodeView code="shown" copyText="the full text" language="bash" copyLabel="cURL" />)
    await user.click(screen.getByRole('button', { name: 'cURLをコピー' }))
    expect(await navigator.clipboard.readText()).toBe('the full text')
  })

  it('text 指定は shiki を使わず、素の pre に出す', () => {
    const { container } = render(<CodeView code={'a\nb'} language="text" copyLabel="テキスト" />)
    const plain = container.querySelector('[data-code-view=plain]')
    expect(plain).not.toBeNull()
    expect(plain?.querySelector('pre')?.textContent).toBe('a\nb')
    expect(container.querySelector('[data-code-view=highlighted]')).toBeNull()
  })

  it('閾値を超える長さのコードは、language が json でもハイライトしない', () => {
    const code = 'x'.repeat(HIGHLIGHT_MAX_CHARS + 1)
    const { container } = render(<CodeView code={code} language="json" copyLabel="本文" />)
    expect(container.querySelector('[data-code-view=plain]')).not.toBeNull()
    expect(container.querySelector('[data-code-view=highlighted]')).toBeNull()
  })

  it('閾値ちょうどまではハイライトする', () => {
    const code = 'x'.repeat(HIGHLIGHT_MAX_CHARS)
    const { container } = render(<CodeView code={code} language="bash" copyLabel="本文" />)
    expect(container.querySelector('[data-code-view=highlighted]')).not.toBeNull()
  })

  it('素の pre でもヘッダーのコピーボタンが効く', async () => {
    const user = userEvent.setup()
    const code = 'y'.repeat(HIGHLIGHT_MAX_CHARS + 10)
    render(<CodeView code={code} language="json" copyLabel="本文" />)
    await user.click(screen.getByRole('button', { name: '本文をコピー' }))
    expect(await navigator.clipboard.readText()).toBe(code)
  })

  it('compact ではヘッダーを出さない', () => {
    const { container } = render(<CodeView code="x" language="text" copyLabel="x" compact />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('pre')?.className).toContain('p-2')
  })
})
