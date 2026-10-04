// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { StreamTab } from '@/components/inspector/stream-tab'
import { jsonEvent, makeEntry, makeTextStreamEvents } from '@/components/inspector/test-fixtures'
import { STREAM_ROW_HEIGHT } from '@/components/inspector/stream-utils'
import type { StreamEvent } from '@/types'

vi.mock('@/components/ai-elements/code-block', async (importOriginal) =>
  (await import('@/components/inspector/test-fixtures')).mockCodeBlock(await importOriginal()),
)

const noop = () => {}

function rows(): HTMLElement[] {
  return screen.queryAllByRole('listitem')
}

function mixedEvents(): StreamEvent[] {
  return [
    jsonEvent(0, { type: 'start' }),
    jsonEvent(1, { type: 'text-delta', id: 't', delta: 'Hello' }),
    jsonEvent(2, { type: 'tool-input-start', toolCallId: 'c1', toolName: 'weather' }),
    jsonEvent(3, { type: 'data-weather', data: { c: 1 } }),
    jsonEvent(4, { type: 'error', errorText: 'boom' }),
    jsonEvent(5, { type: 'finish' }),
    { index: 6, atMs: 30, kind: 'sse-done', raw: '[DONE]' },
  ]
}

describe('StreamTab', () => {
  describe('一覧', () => {
    it('# / +ms / type / プレビューを出す', () => {
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      const second = rows()[1] as HTMLElement
      expect(second.textContent).toContain('1')
      expect(second.textContent).toContain('+5')
      expect(second.textContent).toContain('text-delta')
      expect(second.textContent).toContain('"Hello"')
      expect(screen.getByText('表示 7 / 全 7 件')).not.toBeNull()
    })

    it('type ごとに色のファミリーが付く', () => {
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      const familyOf = (label: string) =>
        screen
          .getAllByTitle(label)
          .find((el) => el.hasAttribute('data-family'))
          ?.getAttribute('data-family')
      expect(familyOf('start')).toBe('lifecycle')
      expect(familyOf('text-delta')).toBe('text')
      expect(familyOf('tool-input-start')).toBe('tool')
      expect(familyOf('data-weather')).toBe('data')
      expect(familyOf('error')).toBe('error')
      expect(familyOf('[DONE]')).toBe('control')
    })

    it('5000 イベントでも、DOM に出す行は数十行に収まる', () => {
      const events = makeTextStreamEvents(5000)
      expect(events).toHaveLength(5000)
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events, state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      const count = rows().length
      expect(count).toBeGreaterThan(0)
      expect(count).toBeLessThan(100)
      expect(screen.getByText('表示 5000 / 全 5000 件')).not.toBeNull()
      // 先頭から描画される
      expect((rows()[0] as HTMLElement).getAttribute('data-event-index')).toBe('0')
    })

    it('スクロールすると、見えている範囲の行に入れ替わる', () => {
      const events = makeTextStreamEvents(5000)
      const { container } = render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events, state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      const scroller =
        container.querySelector<HTMLElement>('[role=list]')?.parentElement?.parentElement
      expect(scroller).toBeDefined()
      fireEvent.scroll(scroller as HTMLElement, { target: { scrollTop: 28 * 2500 } })
      const indexes = rows().map((row) => Number(row.getAttribute('data-event-index')))
      expect(indexes.length).toBeLessThan(100)
      expect(Math.min(...indexes)).toBeGreaterThan(2400)
      expect(Math.max(...indexes)).toBeLessThan(2700)
      expect(indexes).toContain(2500)
    })
  })

  describe('絞り込み', () => {
    it('type の部分一致で絞り込み、件数も更新する', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      await user.type(screen.getByLabelText('タイプで絞り込み'), 'TOOL')
      expect(rows()).toHaveLength(1)
      expect((rows()[0] as HTMLElement).textContent).toContain('tool-input-start')
      expect(screen.getByText('表示 1 / 全 7 件')).not.toBeNull()
    })

    it('一致が無いときはその旨を出し、消すと元に戻る', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      const input = screen.getByLabelText('タイプで絞り込み')
      await user.type(input, 'zzz')
      expect(rows()).toHaveLength(0)
      expect(screen.getByText('条件に一致するイベントがありません')).not.toBeNull()
      expect(screen.getByText('表示 0 / 全 7 件')).not.toBeNull()
      await user.clear(input)
      expect(rows()).toHaveLength(7)
    })

    it('5000 件を絞り込んでも描画行数は少ない', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: makeTextStreamEvents(5000), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      await user.type(screen.getByLabelText('タイプで絞り込み'), 'text-delta')
      expect(screen.getByText('表示 4996 / 全 5000 件')).not.toBeNull()
      expect(rows().length).toBeLessThan(100)
    })

    it('種別の Select で絞り込める', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      await user.click(screen.getByRole('combobox', { name: '種別で絞り込み' }))
      await user.click(await screen.findByRole('option', { name: 'SSE [DONE]' }))
      expect(rows()).toHaveLength(1)
      expect((rows()[0] as HTMLElement).textContent).toContain('[DONE]')
      expect(screen.getByText('表示 1 / 全 7 件')).not.toBeNull()
      expect(screen.getByRole('combobox', { name: '種別で絞り込み' }).textContent).toContain(
        'SSE [DONE]',
      )
    })

    it('種別 Select の選択肢はすべての種別 + 5 種類', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      await user.click(screen.getByRole('combobox', { name: '種別で絞り込み' }))
      const names = (await screen.findAllByRole('option')).map((option) => option.textContent)
      expect(names).toEqual([
        'すべての種別',
        'SSE (JSON)',
        'SSE (非JSON)',
        'SSE [DONE]',
        'SSE コメント',
        'テキストチャンク',
      ])
    })

    it('種別の Select がある', () => {
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      const trigger = screen.getByRole('combobox', { name: '種別で絞り込み' })
      expect(trigger.textContent).toContain('すべての種別')
    })
  })

  describe('展開', () => {
    it('行をクリックすると data の JSON を整形して出し、もう一度で閉じる', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      const row = rows()[1] as HTMLElement
      const button = within(row).getByRole('button')
      expect(button.getAttribute('aria-expanded')).toBe('false')

      await user.click(button)
      expect(button.getAttribute('aria-expanded')).toBe('true')
      const detail = within(row).getByTestId('event-detail')
      const block = within(detail).getByTestId('code-block')
      expect(block.getAttribute('data-language')).toBe('json')
      expect(block.querySelector('pre')?.textContent).toBe(
        '{\n  "type": "text-delta",\n  "id": "t",\n  "delta": "Hello"\n}',
      )
      expect(detail.textContent).toContain('種別: sse-json')

      await user.click(button)
      expect(within(row).queryByTestId('event-detail')).toBeNull()
    })

    it('JSON でないイベントは raw をそのまま出す', async () => {
      const user = userEvent.setup()
      const events: StreamEvent[] = [
        { index: 0, atMs: 1, kind: 'sse-text', raw: '{broken', parseError: 'Unexpected end' },
        { index: 1, atMs: 2, kind: 'text-chunk', raw: 'Hello\nworld' },
      ]
      const { container } = render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events, state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      await user.click(within(rows()[0] as HTMLElement).getByRole('button'))
      const detail = within(rows()[0] as HTMLElement).getByTestId('event-detail')
      expect(detail.textContent).toContain('{broken')
      expect(detail.textContent).toContain('JSON として解釈できません: Unexpected end')

      await user.click(within(rows()[1] as HTMLElement).getByRole('button'))
      const pres = container.querySelectorAll('[data-code-view=plain] pre')
      expect([...pres].map((pre) => pre.textContent)).toEqual(['{broken', 'Hello\nworld'])
    })

    it('SSE の event 名を出す', async () => {
      const user = userEvent.setup()
      const events = [jsonEvent(0, { type: 'start' }, { eventName: 'message' })]
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events, state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      await user.click(within(rows()[0] as HTMLElement).getByRole('button'))
      expect(screen.getByTestId('event-detail').textContent).toContain('event: message')
    })

    it('展開しても、見えている行の数は増えない（高さを加味して窓を決める）', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: makeTextStreamEvents(5000), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      const before = rows().length
      await user.click(within(rows()[0] as HTMLElement).getByRole('button'))
      expect(rows().length).toBeLessThanOrEqual(before)
      expect(rows().length).toBeLessThan(100)
    })
  })

  describe('イベントの注記バッジ', () => {
    const REASON = '「delta」が数値 1 です（string が必要）'
    const annotated = (): StreamEvent[] => [
      jsonEvent(0, { type: 'start' }),
      jsonEvent(1, { type: 'text-delta', id: 't', delta: 1 }, { schemaError: REASON }),
      { index: 2, atMs: 20, kind: 'sse-text', raw: '{"a":', incomplete: true },
      jsonEvent(3, { type: 'tool-input-available', input: { q: 'x' } }, { rawTruncated: true }),
      { index: 4, atMs: 40, kind: 'sse-text', raw: 'x'.repeat(80), parseSkipped: true },
    ]
    const renderTab = (events: StreamEvent[], revealSecrets = false) =>
      render(
        <StreamTab
          revealSecrets={revealSecrets}
          entry={makeEntry({ events, state: 'done' })}
          onOpenResponse={noop}
        />,
      )

    it('注記が無いイベントにはバッジを出さない', () => {
      const { container } = renderTab(mixedEvents())
      expect(container.querySelector('[data-note]')).toBeNull()
    })

    it('フラグごとに、該当する行だけに小さなバッジを出す', () => {
      renderTab(annotated())
      const noteIdsOf = (row: HTMLElement) =>
        [...row.querySelectorAll('[data-note]')].map((el) => el.getAttribute('data-note'))
      const list = rows()
      expect(noteIdsOf(list[0] as HTMLElement)).toEqual([])
      expect(noteIdsOf(list[1] as HTMLElement)).toEqual(['schemaError'])
      expect(noteIdsOf(list[2] as HTMLElement)).toEqual(['incomplete'])
      expect(noteIdsOf(list[3] as HTMLElement)).toEqual(['rawTruncated'])
      expect(noteIdsOf(list[4] as HTMLElement)).toEqual(['parseSkipped'])

      expect(within(list[1] as HTMLElement).getByText('スキーマ不一致')).not.toBeNull()
      expect(within(list[2] as HTMLElement).getByText('未完了・SDK未受信')).not.toBeNull()
      expect(within(list[3] as HTMLElement).getByText('切り詰め')).not.toBeNull()
      expect(within(list[4] as HTMLElement).getByText('巨大のためJSON判定を省略')).not.toBeNull()
    })

    it('スキーマ不一致だけが warn 色で、ほかは控えめな muted', () => {
      const { container } = renderTab(annotated())
      const toneOf = (id: string) =>
        container.querySelector(`[data-note=${id}]`)?.getAttribute('data-tone')
      expect(toneOf('schemaError')).toBe('warn')
      expect(toneOf('incomplete')).toBe('muted')
      expect(toneOf('rawTruncated')).toBe('muted')
      expect(toneOf('parseSkipped')).toBe('muted')
    })

    it('バッジが付いても、行の高さは固定のまま（種別バッジ・プレビューも残る）', () => {
      renderTab(annotated())
      for (const row of rows()) expect(row.style.height).toBe(`${STREAM_ROW_HEIGHT}px`)
      const second = rows()[1] as HTMLElement
      expect(second.textContent).toContain('text-delta')
      expect(second.textContent).toContain('スキーマ不一致')
    })

    it('バッジの title に説明を持つ', () => {
      renderTab(annotated())
      const badge = within(rows()[2] as HTMLElement).getByText('未完了・SDK未受信')
      expect(badge.getAttribute('title')).toContain('空行')
      const schema = within(rows()[1] as HTMLElement).getByText('スキーマ不一致')
      expect(schema.getAttribute('title')).toContain(REASON)
    })

    it('展開すると、スキーマ不一致の日本語の理由を出し、行の高さに注記の分が加わる', async () => {
      const user = userEvent.setup()
      renderTab(annotated())
      const row = rows()[1] as HTMLElement
      await user.click(within(row).getByRole('button'))
      const detail = within(row).getByTestId('event-detail')
      expect(detail.textContent).toContain(REASON)
      expect(within(detail).getByLabelText('イベントの注記').textContent).toContain(
        'SDK のスキーマ（UIMessageChunk）に合いません',
      )
      // 注記が無い行の展開より、注記の行数ぶん高い
      const plainRow = rows()[0] as HTMLElement
      await user.click(within(plainRow).getByRole('button'))
      const heightOf = (el: HTMLElement) => Number.parseFloat(el.style.height)
      expect(heightOf(within(row).getByTestId('event-detail'))).toBeGreaterThan(
        heightOf(within(plainRow).getByTestId('event-detail')),
      )
      expect(heightOf(row)).toBe(STREAM_ROW_HEIGHT + heightOf(detail))
    })

    it('展開した説明に、注記の種類ごとの文を出す', async () => {
      const user = userEvent.setup()
      renderTab(annotated())
      await user.click(within(rows()[2] as HTMLElement).getByRole('button'))
      expect(within(rows()[2] as HTMLElement).getByTestId('event-detail').textContent).toContain(
        '末尾が空行で終わっていない',
      )
    })

    it('スキーマ不一致の理由に紛れたトークンも、設定に従って伏せる', async () => {
      const user = userEvent.setup()
      const TOKEN = 'sk-live-abcdef1234567890' // makeEntry の Authorization と同じ
      const events = [
        jsonEvent(
          0,
          { type: 'x', id: TOKEN },
          { schemaError: `「id」が "${TOKEN}"（使える値: "a"）` },
        ),
      ]
      const { container, unmount } = renderTab(events)
      await user.click(within(rows()[0] as HTMLElement).getByRole('button'))
      expect(container.innerHTML).not.toContain(TOKEN)
      expect(container.textContent).toContain('「id」が "••••7890"')
      unmount()

      const shown = renderTab(events, true)
      await user.click(within(rows()[0] as HTMLElement).getByRole('button'))
      expect(shown.container.textContent).toContain(`「id」が "${TOKEN}"`)
    })

    it('全行に注記があっても、仮想ウィンドウは数十行しか描画しない', () => {
      const events = makeTextStreamEvents(5000).map((event) => ({ ...event, incomplete: true }))
      renderTab(events)
      expect(rows().length).toBeLessThan(100)
      for (const row of rows()) expect(row.style.height).toBe(`${STREAM_ROW_HEIGHT}px`)
    })
  })

  describe('秘匿情報', () => {
    const TOKEN = 'sk-live-abcdef1234567890' // makeEntry の Authorization と同じ
    const leakyEvents = (): StreamEvent[] => [
      jsonEvent(0, { type: 'text-delta', id: 't', delta: `your token is ${TOKEN}` }),
      jsonEvent(1, {
        type: 'tool-input-available',
        input: { apiKey: 'abcdefghijklmnopqrstuvwxyz' },
      }),
    ]

    it('一覧のプレビューと展開した中身から、エコーされたトークンと秘匿キーの値を伏せる', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: leakyEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      expect(rows()[0]?.textContent).not.toContain(TOKEN)
      expect(rows()[0]?.textContent).toContain('your token is ')

      await user.click(within(rows()[0] as HTMLElement).getByRole('button'))
      await user.click(within(rows()[1] as HTMLElement).getByRole('button'))
      const text = screen
        .getAllByTestId('event-detail')
        .map((detail) => detail.textContent)
        .join('\n')
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz')
      expect(text).toContain('"apiKey": "••••')
    })

    it('「全イベントをJSONでコピー」も、展開した中身のコピーも、伏せたものをコピーする', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: leakyEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      await user.click(screen.getByRole('button', { name: '全イベントをJSONでコピー' }))
      const all = await navigator.clipboard.readText()
      expect(all).not.toContain(TOKEN)
      expect(all).not.toContain('abcdefghijklmnopqrstuvwxyz')
      expect(JSON.parse(all)).toHaveLength(2)

      await user.click(within(rows()[0] as HTMLElement).getByRole('button'))
      await user.click(
        within(screen.getByTestId('event-detail')).getByRole('button', {
          name: 'イベントをコピー',
        }),
      )
      const detail = await navigator.clipboard.readText()
      expect(detail).not.toContain(TOKEN)
      // 全イベントのコピーとは別の（この 1 件の）内容に置き換わっている
      expect(detail).toContain('"delta": "your token is ')
    })

    it('秘匿情報を表示する設定ではそのまま出す', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets
          entry={makeEntry({ events: leakyEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      expect(rows()[0]?.textContent).toContain(TOKEN)
      await user.click(screen.getByRole('button', { name: '全イベントをJSONでコピー' }))
      expect(await navigator.clipboard.readText()).toContain(TOKEN)
    })
  })

  describe('コピー・上限', () => {
    it('「全イベントをJSONでコピー」は絞り込みに関係なく全件をコピーする', async () => {
      const user = userEvent.setup()
      const events = mixedEvents()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events, state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      await user.type(screen.getByLabelText('タイプで絞り込み'), 'tool')
      await user.click(screen.getByRole('button', { name: '全イベントをJSONでコピー' }))
      const copied: unknown = JSON.parse(await navigator.clipboard.readText())
      expect(copied).toEqual(JSON.parse(JSON.stringify(events)))
    })

    it('eventsTruncated のときは上限を超えたことを明示する', () => {
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), eventsTruncated: true, state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      expect(
        screen.getByText(/保存上限を超えたため、先頭の 7 件だけを記録しています/),
      ).not.toBeNull()
    })

    it('eventsTruncated でなければ明示しない', () => {
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'done' })}
          onOpenResponse={noop}
        />,
      )
      expect(screen.queryByText(/保存上限/)).toBeNull()
    })
  })

  describe('最新を追う', () => {
    it('既定で有効、押すと切り替わる', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'streaming' })}
          onOpenResponse={noop}
        />,
      )
      const toggle = screen.getByRole('button', { name: '最新を追う' })
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      await user.click(toggle)
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
    })

    it('行を展開すると追従を止める', async () => {
      const user = userEvent.setup()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: mixedEvents(), state: 'streaming' })}
          onOpenResponse={noop}
        />,
      )
      await user.click(within(rows()[0] as HTMLElement).getByRole('button'))
      expect(screen.getByRole('button', { name: '最新を追う' }).getAttribute('aria-pressed')).toBe(
        'false',
      )
    })

    it('ストリーミング中は、イベントが増えるたびに末尾へスクロールする', () => {
      const initial = makeTextStreamEvents(40)
      const entry = makeEntry({ events: initial, state: 'streaming' })
      const { container, rerender } = render(
        <StreamTab revealSecrets={false} entry={entry} onOpenResponse={noop} />,
      )
      const scroller = container.querySelector<HTMLElement>('[role=list]')?.parentElement
        ?.parentElement as HTMLElement
      // jsdom はレイアウトを持たないので、scrollHeight の値と scrollTop への代入だけを再現する
      let scrollTop = 0
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 9999 })
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        },
      })
      rerender(
        <StreamTab
          revealSecrets={false}
          entry={{
            ...entry,
            events: [...initial, jsonEvent(40, { type: 'text-delta', delta: 'x' })],
          }}
          onOpenResponse={noop}
        />,
      )
      expect(scrollTop).toBe(9999)
    })

    it('追従が無効なら、イベントが増えてもスクロール位置を変えない', async () => {
      const user = userEvent.setup()
      const initial = makeTextStreamEvents(40)
      const entry = makeEntry({ events: initial, state: 'streaming' })
      const { container, rerender } = render(
        <StreamTab revealSecrets={false} entry={entry} onOpenResponse={noop} />,
      )
      await user.click(screen.getByRole('button', { name: '最新を追う' }))
      const scroller = container.querySelector<HTMLElement>('[role=list]')?.parentElement
        ?.parentElement as HTMLElement
      let scrollTop = 0
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 9999 })
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        },
      })
      rerender(
        <StreamTab
          revealSecrets={false}
          entry={{
            ...entry,
            events: [...initial, jsonEvent(40, { type: 'text-delta', delta: 'x' })],
          }}
          onOpenResponse={noop}
        />,
      )
      expect(scrollTop).toBe(0)
    })
  })

  describe('ストリームではないエントリ', () => {
    it('events が空で完了済みなら、その旨とレスポンスタブへの導線を出す', async () => {
      const user = userEvent.setup()
      const onOpenResponse = vi.fn()
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: [], state: 'done', rawBody: '{"ok":true}' })}
          onOpenResponse={onOpenResponse}
        />,
      )
      expect(screen.getByText('このレスポンスはストリームではありません')).not.toBeNull()
      expect(rows()).toHaveLength(0)
      await user.click(screen.getByRole('button', { name: 'レスポンスタブを開く' }))
      expect(onOpenResponse).toHaveBeenCalledTimes(1)
    })

    it('レスポンスを受信できなかったときは、それに合わせた説明にする', () => {
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: [], state: 'error', status: undefined })}
          onOpenResponse={noop}
        />,
      )
      expect(screen.getByText(/レスポンスを受信できなかったため/)).not.toBeNull()
    })

    it('通信中でまだイベントが無いときは、待機中の表示にする', () => {
      render(
        <StreamTab
          revealSecrets={false}
          entry={makeEntry({ events: [], state: 'streaming' })}
          onOpenResponse={noop}
        />,
      )
      expect(screen.getByText('イベントを待っています…')).not.toBeNull()
      expect(screen.queryByText('このレスポンスはストリームではありません')).toBeNull()
    })
  })
})
