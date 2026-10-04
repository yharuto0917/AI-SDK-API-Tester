// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RequestList } from '@/components/inspector/request-list'
import { makeEntry } from '@/components/inspector/test-fixtures'
import { PROXY_NAME } from '@/lib/proxy'
import type { NetworkLogEntry } from '@/types'

function threeEntries(): NetworkLogEntry[] {
  // 新しい順
  return [
    makeEntry({
      id: 'req-3',
      method: 'GET',
      mode: 'raw',
      targetUrl: '/health',
      state: 'streaming',
      status: undefined,
      statusText: undefined,
      totalMs: undefined,
      startedAt: new Date(2026, 0, 2, 3, 4, 7, 9).getTime(),
    }),
    makeEntry({
      id: 'req-2',
      mode: 'completion',
      targetUrl: 'http://localhost:8787/api/complete?x=1',
      viaProxy: true,
      state: 'error',
      status: 502,
      statusText: 'Bad Gateway',
      totalMs: 80,
    }),
    makeEntry({ id: 'req-1', state: 'done', status: 200, totalMs: 1500 }),
  ]
}

function options(): HTMLElement[] {
  return screen.getAllByRole('option')
}

/** 親が選択状態を持つ、実際の使われ方に近いラッパー。 */
function Harness({
  entries,
  onSelect,
}: {
  entries: NetworkLogEntry[]
  onSelect?: (id: string) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return (
    <RequestList
      revealSecrets={false}
      entries={entries}
      selectedId={selectedId}
      onSelect={(id) => {
        setSelectedId(id)
        onSelect?.(id)
      }}
    />
  )
}

describe('RequestList', () => {
  it('空のときは案内を出す', () => {
    render(<RequestList revealSecrets={false} entries={[]} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByText('まだ通信がありません')).not.toBeNull()
    expect(screen.getByText('メッセージを送信するとここに表示されます')).not.toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('渡された順（新しい順）に行を出す', () => {
    render(
      <RequestList
        revealSecrets={false}
        entries={threeEntries()}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    expect(options().map((option) => option.getAttribute('data-entry-id'))).toEqual([
      'req-3',
      'req-2',
      'req-1',
    ])
  })

  it('各行にメソッド・URL・ステータス・所要時間・時刻・モードを出す', () => {
    render(
      <RequestList
        revealSecrets={false}
        entries={threeEntries()}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    const [streaming, failed, done] = options() as [HTMLElement, HTMLElement, HTMLElement]

    expect(within(done).getByText('POST')).not.toBeNull()
    // ホスト（origin）は薄く、パスは強調する
    expect(within(done).getByText('https://api.example.com').className).toContain(
      'text-muted-foreground',
    )
    expect(within(done).getByText('/api/chat').className).toContain('text-foreground')
    expect(within(done).getByText('200')).not.toBeNull()
    expect(within(done).getByText('1.50 s')).not.toBeNull()
    expect(within(done).getByText('03:04:05.006')).not.toBeNull()
    expect(within(done).getByText('chat-ui')).not.toBeNull()

    expect(within(failed).getByText('502')).not.toBeNull()
    expect(within(failed).getByText('80 ms')).not.toBeNull()
    expect(within(failed).getByText('completion')).not.toBeNull()
    expect(within(failed).getByText('/api/complete?x=1')).not.toBeNull()

    // 相対パスは origin が空
    expect(within(streaming).getByText('/health')).not.toBeNull()
    expect(within(streaming).getByText('raw')).not.toBeNull()
  })

  describe('URL の秘匿情報', () => {
    const KEY = 'sk-live-SECRETSECRET'
    const leaky = () => [
      makeEntry({
        id: 'req-1',
        targetUrl: `https://api.example.com/v1/chat?api_key=${KEY}&model=gpt`,
      }),
    ]

    it('既定ではクエリの秘匿キーの値を伏せ、ホストとそれ以外のクエリは残す', () => {
      render(
        <RequestList
          revealSecrets={false}
          entries={leaky()}
          selectedId={null}
          onSelect={() => {}}
        />,
      )
      const [row] = options() as [HTMLElement]
      expect(row.textContent).not.toContain(KEY)
      expect(within(row).getByText('https://api.example.com')).not.toBeNull()
      expect(within(row).getByText(/^\/v1\/chat\?api_key=••••.*&model=gpt$/)).not.toBeNull()
      // ツールチップ（title）にも秘密を出さない
      const titled = row.querySelector('[title^="https://api.example.com"]')
      expect(titled?.getAttribute('title')).not.toContain(KEY)
    })

    it('秘匿情報を表示する設定ではそのまま出す', () => {
      render(<RequestList revealSecrets entries={leaky()} selectedId={null} onSelect={() => {}} />)
      const [row] = options() as [HTMLElement]
      expect(row.textContent).toContain(`api_key=${KEY}`)
      expect(row.querySelector(`[title$="model=gpt"]`)?.getAttribute('title')).toContain(KEY)
    })

    it('設定を切り替えると表示も切り替わる', () => {
      const { rerender } = render(
        <RequestList
          revealSecrets={false}
          entries={leaky()}
          selectedId={null}
          onSelect={() => {}}
        />,
      )
      expect(options()[0]?.textContent).not.toContain(KEY)
      rerender(
        <RequestList revealSecrets entries={leaky()} selectedId={null} onSelect={() => {}} />,
      )
      expect(options()[0]?.textContent).toContain(KEY)
    })
  })

  it('ステータスコードを色分けする（2xx 緑 / 4xx・5xx 赤 / 未受信は —）', () => {
    render(
      <RequestList
        revealSecrets={false}
        entries={threeEntries()}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    const [streaming, failed, done] = options() as [HTMLElement, HTMLElement, HTMLElement]
    expect(within(done).getByText('200').className).toContain('emerald')
    expect(within(done).getByText('200').className).toContain('dark:')
    expect(within(failed).getByText('502').className).toContain('text-destructive')
    const none = within(streaming).getByLabelText('ステータス 未受信')
    expect(none.textContent).toBe('—')
  })

  it('通信中は所要時間が — で、状態アイコンが状態ごとに変わる', () => {
    render(
      <RequestList
        revealSecrets={false}
        entries={threeEntries()}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    const [streaming, failed, done] = options() as [HTMLElement, HTMLElement, HTMLElement]
    expect(within(streaming).getByTitle('所要時間').textContent).toBe('—')
    expect(within(streaming).getByRole('img', { name: '受信中' })).not.toBeNull()
    expect(within(failed).getByRole('img', { name: 'エラー' })).not.toBeNull()
    expect(within(done).getByRole('img', { name: '完了' })).not.toBeNull()
  })

  it('プロキシ経由の行にだけ proxy バッジを出す', () => {
    render(
      <RequestList
        revealSecrets={false}
        entries={threeEntries()}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    const [streaming, failed, done] = options() as [HTMLElement, HTMLElement, HTMLElement]
    expect(within(failed).getByText('proxy')).not.toBeNull()
    expect(within(done).queryByText('proxy')).toBeNull()
    expect(within(streaming).queryByText('proxy')).toBeNull()
  })

  it('proxy バッジの説明（title）は PROXY_NAME の呼び名を使い、旧表記を使わない', () => {
    render(
      <RequestList
        revealSecrets={false}
        entries={threeEntries()}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    const badge = within(options()[1] as HTMLElement).getByText('proxy')
    expect(badge.getAttribute('title')).toBe(`${PROXY_NAME}経由で送信`)
    expect(badge.getAttribute('title')).not.toContain('dev プロキシ')
  })

  it('選択中の行に aria-selected が付く', () => {
    render(
      <RequestList
        revealSecrets={false}
        entries={threeEntries()}
        selectedId="req-2"
        onSelect={() => {}}
      />,
    )
    const selected = options().filter((option) => option.getAttribute('aria-selected') === 'true')
    expect(selected.map((option) => option.getAttribute('data-entry-id'))).toEqual(['req-2'])
  })

  it('行をクリックすると onSelect が呼ばれる', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <RequestList
        revealSecrets={false}
        entries={threeEntries()}
        selectedId={null}
        onSelect={onSelect}
      />,
    )
    await user.click(options()[1] as HTMLElement)
    expect(onSelect).toHaveBeenCalledWith('req-2')
  })

  describe('キーボード', () => {
    it('Tab で入れる行は 1 つだけ（選択中の行、無ければ先頭）', () => {
      const { rerender } = render(
        <RequestList
          revealSecrets={false}
          entries={threeEntries()}
          selectedId={null}
          onSelect={() => {}}
        />,
      )
      expect(options().map((o) => o.tabIndex)).toEqual([0, -1, -1])
      rerender(
        <RequestList
          revealSecrets={false}
          entries={threeEntries()}
          selectedId="req-1"
          onSelect={() => {}}
        />,
      )
      expect(options().map((o) => o.tabIndex)).toEqual([-1, -1, 0])
    })

    it('下キーで次（古い方）、上キーで前（新しい方）を選び、フォーカスも移す', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      render(<Harness entries={threeEntries()} onSelect={onSelect} />)

      await user.click(options()[0] as HTMLElement)
      expect(onSelect).toHaveBeenLastCalledWith('req-3')

      await user.keyboard('{ArrowDown}')
      expect(onSelect).toHaveBeenLastCalledWith('req-2')
      expect(document.activeElement).toBe(options()[1])
      expect(options()[1]?.getAttribute('aria-selected')).toBe('true')

      await user.keyboard('{ArrowDown}')
      expect(onSelect).toHaveBeenLastCalledWith('req-1')
      expect(document.activeElement).toBe(options()[2])

      await user.keyboard('{ArrowUp}')
      expect(onSelect).toHaveBeenLastCalledWith('req-2')
      expect(document.activeElement).toBe(options()[1])
    })

    it('端では止まる（循環しない）', async () => {
      const user = userEvent.setup()
      render(<Harness entries={threeEntries()} />)
      await user.click(options()[2] as HTMLElement)
      await user.keyboard('{ArrowDown}')
      expect(options()[2]?.getAttribute('aria-selected')).toBe('true')
      await user.click(options()[0] as HTMLElement)
      await user.keyboard('{ArrowUp}')
      expect(options()[0]?.getAttribute('aria-selected')).toBe('true')
    })

    it('Home / End で先頭・末尾へ移る', async () => {
      const user = userEvent.setup()
      render(<Harness entries={threeEntries()} />)
      await user.click(options()[1] as HTMLElement)
      await user.keyboard('{End}')
      expect(options()[2]?.getAttribute('aria-selected')).toBe('true')
      await user.keyboard('{Home}')
      expect(options()[0]?.getAttribute('aria-selected')).toBe('true')
    })

    it('Enter で選択する', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      render(
        <RequestList
          revealSecrets={false}
          entries={threeEntries()}
          selectedId={null}
          onSelect={onSelect}
        />,
      )
      ;(options()[1] as HTMLElement).focus()
      await user.keyboard('{Enter}')
      expect(onSelect).toHaveBeenCalledWith('req-2')
    })

    it('それ以外のキーは何もしない', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      render(
        <RequestList
          revealSecrets={false}
          entries={threeEntries()}
          selectedId={null}
          onSelect={onSelect}
        />,
      )
      ;(options()[0] as HTMLElement).focus()
      await user.keyboard('a')
      expect(onSelect).not.toHaveBeenCalled()
    })
  })

  it('選択が変わったら、その行をスクロールで見える位置に出す', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { rerender } = render(
      <RequestList
        revealSecrets={false}
        entries={threeEntries()}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    spy.mockClear()
    rerender(
      <RequestList
        revealSecrets={false}
        entries={threeEntries()}
        selectedId="req-2"
        onSelect={() => {}}
      />,
    )
    expect(spy).toHaveBeenCalledWith({ block: 'nearest' })
    spy.mockRestore()
  })
})
