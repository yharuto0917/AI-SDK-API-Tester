// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ResponseTab } from '@/components/inspector/response-tab'
import { makeEntry } from '@/components/inspector/test-fixtures'

vi.mock('@/components/ai-elements/code-block', async (importOriginal) =>
  (await import('@/components/inspector/test-fixtures')).mockCodeBlock(await importOriginal()),
)

describe('ResponseTab', () => {
  it('ステータス行・TTFB・合計・受信バイト・状態を出す', () => {
    render(<ResponseTab entry={makeEntry()} revealSecrets={false} />)
    expect(screen.getByText('200 OK')).not.toBeNull()
    const metrics = document.querySelector('dl')
    expect(metrics?.textContent).toContain('TTFB')
    expect(metrics?.textContent).toContain('120 ms')
    expect(metrics?.textContent).toContain('1.50 s')
    expect(metrics?.textContent).toContain('2.0 KB')
    expect(metrics?.textContent).toContain('完了')
  })

  it('未受信のときは — と注記を出す', () => {
    const entry = makeEntry({
      state: 'pending',
      status: undefined,
      statusText: undefined,
      responseHeaders: undefined,
      ttfbMs: undefined,
      totalMs: undefined,
      bytesReceived: 0,
    })
    render(<ResponseTab entry={entry} revealSecrets={false} />)
    expect(screen.getByText('レスポンスをまだ受信していません')).not.toBeNull()
    expect(screen.getByText('レスポンスヘッダーはまだありません')).not.toBeNull()
    expect(screen.getByText('受信を待っています…')).not.toBeNull()
    expect(document.querySelector('dl')?.textContent).toContain('送信中')
  })

  it('x-vercel-ai-ui-message-stream と content-type の行を強調する', () => {
    render(<ResponseTab entry={makeEntry()} revealSecrets={false} />)
    const table = screen.getByRole('table', { name: 'レスポンスヘッダー' })
    const emphasized = [...table.querySelectorAll('[data-emphasized=true]')].map(
      (row) => row.querySelector('td')?.textContent,
    )
    expect(emphasized.sort()).toEqual(['content-type', 'x-vercel-ai-ui-message-stream'])
    expect(
      within(table).getByText('cache-control').closest('tr')?.hasAttribute('data-emphasized'),
    ).toBe(false)
  })

  it('CORS 診断が見るヘッダーや、トークン数の使用量ヘッダーは隠さない', () => {
    const entry = makeEntry({
      responseHeaders: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': 'https://app.example.com',
        'www-authenticate': 'Bearer realm="api"',
        'x-ratelimit-remaining-tokens': '99000',
        authorization: 'Bearer sk-echoed-secret-0123456789',
        'x-api-key': 'sk-echoed-key-0123456789',
      },
    })
    render(<ResponseTab entry={entry} revealSecrets={false} />)
    const table = screen.getByRole('table', { name: 'レスポンスヘッダー' })
    const valueOf = (name: string) =>
      within(table).getByText(name).closest('tr')?.lastChild?.textContent
    expect(valueOf('access-control-allow-credentials')).toBe('true')
    expect(valueOf('access-control-allow-origin')).toBe('https://app.example.com')
    expect(valueOf('www-authenticate')).toBe('Bearer realm="api"')
    expect(valueOf('x-ratelimit-remaining-tokens')).toBe('99000')
    expect(valueOf('authorization')).toBe('Bearer ••••6789')
    expect(valueOf('x-api-key')).toBe('••••6789')
  })

  it('リクエストで送った認証情報がヘッダーにエコーされていたら、名前によらず伏せる', () => {
    const entry = makeEntry({
      responseHeaders: { 'x-forwarded-credential': 'Bearer sk-live-abcdef1234567890' },
    })
    render(<ResponseTab entry={entry} revealSecrets={false} />)
    const table = screen.getByRole('table', { name: 'レスポンスヘッダー' })
    expect(table.textContent).not.toContain('sk-live-abcdef1234567890')
    expect(table.textContent).toContain('Bearer ••••7890')
  })

  it('set-cookie などの秘匿ヘッダーは設定に従ってマスクする', () => {
    const entry = makeEntry({
      responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'session=abcdef123456' },
    })
    const { rerender } = render(<ResponseTab entry={entry} revealSecrets={false} />)
    const table = () => screen.getByRole('table', { name: 'レスポンスヘッダー' })
    expect(table().textContent).not.toContain('abcdef123456')
    rerender(<ResponseTab entry={entry} revealSecrets />)
    expect(table().textContent).toContain('session=abcdef123456')
  })

  it('本文全体が JSON なら整形して json の CodeBlock に出す', () => {
    const entry = makeEntry({ rawBody: '{"ok":true,"items":[1,2]}' })
    render(<ResponseTab entry={entry} revealSecrets={false} />)
    const block = screen.getByTestId('code-block')
    expect(block.getAttribute('data-language')).toBe('json')
    expect(block.querySelector('pre')?.textContent).toBe(
      '{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}',
    )
  })

  it('本文の表示・コピーはサーバーが返した値のまま（桁落ち・重複キーを起こさない）', async () => {
    const user = userEvent.setup()
    const body = '{"id":12345678901234567890,"a":1,"a":2,"n":1.0}'
    render(<ResponseTab entry={makeEntry({ rawBody: body })} revealSecrets={false} />)
    const text = screen.getByTestId('code-block').querySelector('pre')?.textContent ?? ''
    expect(text).toContain('"id": 12345678901234567890')
    expect(text.match(/"a": /g)).toHaveLength(2)
    expect(text).toContain('"n": 1.0')
    // コピーは整形前の原文
    await user.click(screen.getByRole('button', { name: 'レスポンス本文をコピー' }))
    expect(await navigator.clipboard.readText()).toBe(body)
  })

  describe('本文の秘匿情報', () => {
    const TOKEN = 'sk-live-abcdef1234567890' // makeEntry の Authorization と同じ
    const echo = JSON.stringify({
      headers: { authorization: `Bearer ${TOKEN}`, accept: '*/*' },
      echoed: `token=${TOKEN}`,
      usage: { totalTokens: 12 },
    })

    it('エコーされた Authorization と、秘匿キーの値を伏せ、それ以外はそのまま出す', () => {
      const { container } = render(
        <ResponseTab entry={makeEntry({ rawBody: echo })} revealSecrets={false} />,
      )
      const text = screen.getByTestId('code-block').querySelector('pre')?.textContent ?? ''
      expect(container.textContent).not.toContain(TOKEN)
      expect(text).toContain('"authorization": "Bearer ••••')
      expect(text).toContain('"echoed": "token=••••')
      expect(text).toContain('"accept": "*/*"')
      expect(text).toContain('"totalTokens": 12')
      expect(screen.getByText(/認証情報らしい値/)).not.toBeNull()
    })

    it('コピーもマスク済みの原文', async () => {
      const user = userEvent.setup()
      render(<ResponseTab entry={makeEntry({ rawBody: echo })} revealSecrets={false} />)
      await user.click(screen.getByRole('button', { name: 'レスポンス本文をコピー' }))
      const copied = await navigator.clipboard.readText()
      expect(copied).not.toContain(TOKEN)
      expect(copied).toMatch(/^\{"headers":\{"authorization":"Bearer ••••/)
    })

    it('SSE の本文も、data: 行の秘匿キーと既知の値を伏せる', () => {
      const body = [
        `data: {"type":"text-delta","delta":"your token is ${TOKEN}"}`,
        '',
        'data: {"type":"tool-input-available","input":{"apiKey":"abcdefghijklmnopqrstuvwxyz"}}',
        '',
      ].join('\n')
      const { container } = render(
        <ResponseTab entry={makeEntry({ rawBody: body })} revealSecrets={false} />,
      )
      const text = container.querySelector('[data-code-view=plain] pre')?.textContent ?? ''
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz')
      expect(text).toContain('your token is ')
    })

    it('秘匿情報を表示する設定ではそのまま出し、注記も消える', () => {
      const { container } = render(
        <ResponseTab entry={makeEntry({ rawBody: echo })} revealSecrets />,
      )
      expect(container.textContent).toContain(TOKEN)
      expect(screen.queryByText(/認証情報らしい値/)).toBeNull()
    })

    it('秘匿情報の無い本文には注記を出さない', () => {
      render(<ResponseTab entry={makeEntry({ rawBody: '{"ok":true}' })} revealSecrets={false} />)
      expect(screen.queryByText(/認証情報らしい値/)).toBeNull()
    })
  })

  it('JSON でない本文（SSE など）はそのままテキストで出す', () => {
    const body = 'data: {"type":"start"}\n\ndata: [DONE]\n\n'
    const { container } = render(
      <ResponseTab entry={makeEntry({ rawBody: body })} revealSecrets={false} />,
    )
    const plain = container.querySelector('[data-code-view=plain] pre')
    expect(plain?.textContent).toBe(body)
    expect(screen.queryByTestId('code-block')).toBeNull()
  })

  it('本文が無いときはその旨を出す', () => {
    render(<ResponseTab entry={makeEntry({ rawBody: '' })} revealSecrets={false} />)
    expect(screen.getByText('ボディはありません')).not.toBeNull()
  })

  describe('大きい本文', () => {
    const big = `${'x'.repeat(39_999)}\n` // 40,000 文字（JSON ではない）

    it('先頭だけを描画し、全文の文字数を案内する', () => {
      const { container } = render(
        <ResponseTab entry={makeEntry({ rawBody: big })} revealSecrets={false} />,
      )
      const rendered = container.querySelector('[data-code-view=plain] pre')?.textContent ?? ''
      expect(rendered.length).toBe(30_000)
      expect(screen.getByText(/先頭 30,000 文字のみ表示/)).not.toBeNull()
      expect(screen.getByText(/全 40,000 文字/)).not.toBeNull()
    })

    it('「全文を表示」で全文を描画する', async () => {
      const user = userEvent.setup()
      const { container } = render(
        <ResponseTab entry={makeEntry({ rawBody: big })} revealSecrets={false} />,
      )
      await user.click(screen.getByRole('button', { name: '全文を表示' }))
      expect(container.querySelector('[data-code-view=plain] pre')?.textContent).toBe(big)
      expect(screen.queryByRole('button', { name: '全文を表示' })).toBeNull()
      expect(screen.queryByText(/先頭 30,000 文字のみ表示/)).toBeNull()
    })

    it('「全文をコピー」は切り詰めていない全文をコピーする', async () => {
      const user = userEvent.setup()
      render(<ResponseTab entry={makeEntry({ rawBody: big })} revealSecrets={false} />)
      await user.click(screen.getByRole('button', { name: '全文をコピー' }))
      expect(await navigator.clipboard.readText()).toBe(big)
    })

    it('ヘッダーのコピーボタンも全文をコピーする', async () => {
      const user = userEvent.setup()
      render(<ResponseTab entry={makeEntry({ rawBody: big })} revealSecrets={false} />)
      await user.click(screen.getByRole('button', { name: 'レスポンス本文をコピー' }))
      expect(await navigator.clipboard.readText()).toBe(big)
    })

    it('小さい本文には切り詰めの案内を出さない', () => {
      render(<ResponseTab entry={makeEntry({ rawBody: 'small' })} revealSecrets={false} />)
      expect(screen.queryByRole('button', { name: '全文を表示' })).toBeNull()
    })

    it('大きな JSON も整形したうえで先頭だけを描画する', () => {
      const body = JSON.stringify({ items: Array.from({ length: 5000 }, (_, i) => `item-${i}`) })
      const { container } = render(
        <ResponseTab entry={makeEntry({ rawBody: body })} revealSecrets={false} />,
      )
      const rendered = container.querySelector('[data-code-view=plain] pre')?.textContent ?? ''
      expect(rendered.length).toBe(30_000)
      expect(rendered.startsWith('{\n  "items": [\n    "item-0"')).toBe(true)
    })
  })

  it('rawBodyTruncated のときは保存上限を超えたことを明示する', () => {
    render(
      <ResponseTab
        entry={makeEntry({ rawBody: 'partial', rawBodyTruncated: true, bytesReceived: 5_000_000 })}
        revealSecrets={false}
      />,
    )
    const note = screen.getByRole('note')
    expect(note.textContent).toContain('ボディが保存上限を超えたため')
    expect(note.textContent).toContain('4.8 MB')
  })

  it('rawBodyTruncated でなければ明示しない', () => {
    render(<ResponseTab entry={makeEntry({ rawBody: 'x' })} revealSecrets={false} />)
    expect(screen.queryByText(/保存上限/)).toBeNull()
  })
})
