// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EntryDetail } from '@/components/inspector/entry-detail'
import {
  diagnostic,
  jsonEvent,
  makeEntry,
  makeTextStreamEvents,
  recordSseEntry,
} from '@/components/inspector/test-fixtures'

vi.mock('@/components/ai-elements/code-block', async (importOriginal) =>
  (await import('@/components/inspector/test-fixtures')).mockCodeBlock(await importOriginal()),
)

const tab = (name: RegExp) => screen.getByRole('tab', { name })

describe('EntryDetail', () => {
  it('診断 / リクエスト / レスポンス / ストリームのタブを持ち、診断が最初に開く', () => {
    render(<EntryDetail entry={makeEntry()} revealSecrets={false} />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual([
      '診断',
      'リクエスト',
      'レスポンス',
      'ストリーム',
    ])
    expect(tab(/診断/).getAttribute('aria-selected')).toBe('true')
  })

  it('診断タブのバッジは最悪 level の色と件数を示す', () => {
    const entry = makeEntry({
      diagnostics: [
        diagnostic('a', 'ok'),
        diagnostic('b', 'warn'),
        diagnostic('c', 'error'),
        diagnostic('d', 'error'),
        diagnostic('e', 'info'),
      ],
    })
    render(<EntryDetail entry={entry} revealSecrets={false} />)
    const badge = within(tab(/診断/)).getByLabelText('エラー 2 件')
    expect(badge.textContent).toBe('2')
    expect(badge.getAttribute('data-level')).toBe('error')
    expect(badge.className).toContain('text-destructive')
  })

  it('警告だけなら警告色（amber）で件数を示す', () => {
    const entry = makeEntry({ diagnostics: [diagnostic('w', 'warn'), diagnostic('o', 'ok')] })
    render(<EntryDetail entry={entry} revealSecrets={false} />)
    const badge = within(tab(/診断/)).getByLabelText('警告 1 件')
    expect(badge.className).toContain('amber')
    expect(badge.className).toContain('dark:')
  })

  it('診断が無ければバッジを出さない', () => {
    render(<EntryDetail entry={makeEntry({ diagnostics: [] })} revealSecrets={false} />)
    expect(within(tab(/診断/)).queryByText(/^\d+$/)).toBeNull()
  })

  it('ストリームタブにはイベント数のバッジを出す（0 件なら出さない）', () => {
    const { rerender } = render(
      <EntryDetail entry={makeEntry({ events: makeTextStreamEvents(10) })} revealSecrets={false} />,
    )
    expect(within(tab(/ストリーム/)).getByLabelText('イベント 10 件').textContent).toBe('10')
    rerender(<EntryDetail entry={makeEntry({ events: [] })} revealSecrets={false} />)
    expect(within(tab(/ストリーム/)).queryByText(/^\d+$/)).toBeNull()
  })

  it('タブを切り替えると中身が切り替わる', async () => {
    const user = userEvent.setup()
    render(
      <EntryDetail
        entry={makeEntry({ diagnostics: [diagnostic('x', 'ok', 'OK です')] })}
        revealSecrets={false}
      />,
    )
    expect(screen.getByText('OK です')).not.toBeNull()

    await user.click(tab(/リクエスト/))
    expect(screen.getByLabelText('宛先 URL')).not.toBeNull()
    expect(screen.queryByText('OK です')).toBeNull()

    await user.click(tab(/レスポンス/))
    expect(screen.getByRole('table', { name: 'レスポンスヘッダー' })).not.toBeNull()

    await user.click(tab(/ストリーム/))
    expect(screen.getByText('このレスポンスはストリームではありません')).not.toBeNull()
  })

  it('revealSecrets がリクエストタブへ伝わる', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<EntryDetail entry={makeEntry()} revealSecrets={false} />)
    await user.click(tab(/リクエスト/))
    expect(screen.getByRole('table', { name: 'リクエストヘッダー' }).textContent).not.toContain(
      'sk-live-abcdef',
    )
    rerender(<EntryDetail entry={makeEntry()} revealSecrets />)
    expect(screen.getByRole('table', { name: 'リクエストヘッダー' }).textContent).toContain(
      'sk-live-abcdef',
    )
  })

  it('revealSecrets がレスポンス・ストリームタブへも伝わる', async () => {
    const user = userEvent.setup()
    const TOKEN = 'sk-live-abcdef1234567890'
    const entry = makeEntry({
      rawBody: `{"echo":"${TOKEN}"}`,
      events: [jsonEvent(0, { type: 'text-delta', delta: TOKEN })],
    })
    const { rerender } = render(<EntryDetail entry={entry} revealSecrets={false} />)
    await user.click(tab(/レスポンス/))
    expect(screen.getByTestId('code-block').textContent).not.toContain(TOKEN)
    await user.click(tab(/ストリーム/))
    expect(screen.getAllByRole('listitem')[0]?.textContent).not.toContain(TOKEN)

    rerender(<EntryDetail entry={entry} revealSecrets />)
    expect(screen.getAllByRole('listitem')[0]?.textContent).toContain(TOKEN)
    await user.click(tab(/レスポンス/))
    expect(screen.getByTestId('code-block').textContent).toContain(TOKEN)
  })

  it('エントリを切り替えると、リクエストボディの「全文を表示」は元に戻る', async () => {
    const user = userEvent.setup()
    const big = `${'x'.repeat(39_999)}\n`
    const { rerender } = render(
      <EntryDetail entry={makeEntry({ id: 'a', requestBody: big })} revealSecrets={false} />,
    )
    await user.click(tab(/リクエスト/))
    await user.click(screen.getByRole('button', { name: '全文を表示' }))
    expect(screen.queryByRole('button', { name: '全文を表示' })).toBeNull()

    rerender(<EntryDetail entry={makeEntry({ id: 'b', requestBody: big })} revealSecrets={false} />)
    expect(tab(/リクエスト/).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('button', { name: '全文を表示' })).not.toBeNull()
  })

  it('本物のログから作ったエントリ（診断つき）を表示できる', () => {
    render(<EntryDetail entry={recordSseEntry({ events: 8 })} revealSecrets={false} />)
    expect(screen.getByText('ストリームは正常に完了しました')).not.toBeNull()
  })

  it('エントリを切り替えると、ストリームの絞り込みは作り直され、タブは保たれる', async () => {
    const user = userEvent.setup()
    const first = makeEntry({
      id: 'a',
      events: [jsonEvent(0, { type: 'start' }), jsonEvent(1, { type: 'finish' })],
    })
    const second = makeEntry({
      id: 'b',
      events: [jsonEvent(0, { type: 'start' }), jsonEvent(1, { type: 'finish' })],
    })
    const { rerender } = render(<EntryDetail entry={first} revealSecrets={false} />)
    await user.click(tab(/ストリーム/))
    await user.type(screen.getByLabelText('タイプで絞り込み'), 'finish')
    expect(screen.getByText('表示 1 / 全 2 件')).not.toBeNull()

    rerender(<EntryDetail entry={second} revealSecrets={false} />)
    // タブは保たれ、絞り込みは空に戻る
    expect(tab(/ストリーム/).getAttribute('aria-selected')).toBe('true')
    expect((screen.getByLabelText('タイプで絞り込み') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('表示 2 / 全 2 件')).not.toBeNull()
  })
})
