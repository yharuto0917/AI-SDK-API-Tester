// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RequestTab } from '@/components/inspector/request-tab'
import { makeEntry } from '@/components/inspector/test-fixtures'
import { PROXY_NAME } from '@/lib/proxy'

vi.mock('@/components/ai-elements/code-block', async (importOriginal) =>
  (await import('@/components/inspector/test-fixtures')).mockCodeBlock(await importOriginal()),
)

const SECRET = 'sk-live-abcdef1234567890'

function codeBlockOf(language: string): HTMLElement {
  const block = screen
    .getAllByTestId('code-block')
    .find((element) => element.getAttribute('data-language') === language)
  if (block === undefined) throw new Error(`language=${language} の CodeBlock が見つかりません`)
  return block
}

describe('RequestTab', () => {
  it('メソッドと宛先 URL を表示する', () => {
    render(<RequestTab entry={makeEntry()} revealSecrets={false} />)
    const url = screen.getByLabelText<HTMLInputElement>('宛先 URL')
    expect(url.value).toBe('https://api.example.com/api/chat')
    expect(screen.getByText('POST')).not.toBeNull()
  })

  it('宛先 URL をコピーできる', async () => {
    const user = userEvent.setup()
    render(<RequestTab entry={makeEntry()} revealSecrets={false} />)
    await user.click(screen.getByRole('button', { name: '宛先 URL をコピー' }))
    expect(await navigator.clipboard.readText()).toBe('https://api.example.com/api/chat')
  })

  it('プロキシ経由のときだけ注記を出す', () => {
    const { rerender } = render(
      <RequestTab entry={makeEntry({ viaProxy: true })} revealSecrets={false} />,
    )
    expect(screen.getByText(`${PROXY_NAME}経由（実際の宛先はこの URL）`)).not.toBeNull()
    rerender(<RequestTab entry={makeEntry({ viaProxy: false })} revealSecrets={false} />)
    expect(screen.queryByText(/プロキシ経由/)).toBeNull()
  })

  it('旧表記の「dev プロキシ」（スペースあり）を使わない', () => {
    const { container } = render(
      <RequestTab entry={makeEntry({ viaProxy: true })} revealSecrets={false} />,
    )
    expect(container.textContent).toContain(PROXY_NAME)
    expect(container.textContent).not.toContain('dev プロキシ')
  })

  describe('送信されなかったヘッダー（droppedHeaders）', () => {
    it('あれば、ヘッダー表の下に名前だけを控えめに出す', () => {
      render(
        <RequestTab
          entry={makeEntry({ droppedHeaders: ['cookie', 'origin'] })}
          revealSecrets={false}
        />,
      )
      expect(
        screen.getByText('ブラウザの仕様で送信されなかったヘッダー: cookie, origin'),
      ).not.toBeNull()
      // 表（実際に送ったヘッダー）には混ざらない
      const table = screen.getByRole('table', { name: 'リクエストヘッダー' })
      expect(within(table).queryByText('cookie')).toBeNull()
    })

    it('無い・空のときは何も出さない', () => {
      const { rerender } = render(<RequestTab entry={makeEntry()} revealSecrets={false} />)
      expect(screen.queryByText(/送信されなかったヘッダー/)).toBeNull()
      rerender(<RequestTab entry={makeEntry({ droppedHeaders: [] })} revealSecrets={false} />)
      expect(screen.queryByText(/送信されなかったヘッダー/)).toBeNull()
    })

    it('秘匿情報を表示する設定でも同じ（値を持たないので伏せるものが無い）', () => {
      render(<RequestTab entry={makeEntry({ droppedHeaders: ['cookie'] })} revealSecrets />)
      expect(screen.getByText('ブラウザの仕様で送信されなかったヘッダー: cookie')).not.toBeNull()
    })
  })

  describe('本文の切り詰め（requestBodyTruncated）', () => {
    it('切り詰められているときだけ、上限と cURL が再現しないことを案内する', () => {
      const { rerender } = render(
        <RequestTab entry={makeEntry({ requestBodyTruncated: true })} revealSecrets={false} />,
      )
      const note = screen.getByRole('note')
      expect(note.textContent).toContain(
        'リクエスト本文は保持の上限（200,000 文字）で切り詰められています',
      )
      expect(note.textContent).toContain('cURL は実際の送信内容を再現しません')
      rerender(<RequestTab entry={makeEntry()} revealSecrets={false} />)
      expect(screen.queryByRole('note')).toBeNull()
      rerender(
        <RequestTab entry={makeEntry({ requestBodyTruncated: false })} revealSecrets={false} />,
      )
      expect(screen.queryByRole('note')).toBeNull()
    })

    it('cURL の先頭に注意のコメント行が付く（表示・コピーの両方）', async () => {
      const user = userEvent.setup()
      render(<RequestTab entry={makeEntry({ requestBodyTruncated: true })} revealSecrets={false} />)
      expect(codeBlockOf('bash').querySelector('pre')?.textContent).toMatch(/^# 注意: /)
      await user.click(within(codeBlockOf('bash')).getByRole('button', { name: 'cURLをコピー' }))
      expect(await navigator.clipboard.readText()).toMatch(/^# 注意: .*\ncurl -N /)
    })

    it('切り詰められていなければ、cURL にコメント行を付けない', () => {
      render(<RequestTab entry={makeEntry()} revealSecrets={false} />)
      expect(codeBlockOf('bash').textContent).not.toContain('# 注意')
    })

    it('巨大な本文（全文コピー用に cURL を後から作る場合）でも、コピーした cURL に注意が付く', async () => {
      const user = userEvent.setup()
      const body = 'z'.repeat(40_000)
      render(
        <RequestTab
          entry={makeEntry({ requestBody: body, requestBodyTruncated: true })}
          revealSecrets={false}
        />,
      )
      expect(codeBlockOf('bash').querySelector('pre')?.textContent).toMatch(/^# 注意: /)
      await user.click(within(codeBlockOf('bash')).getByRole('button', { name: 'cURLをコピー' }))
      const copied = await navigator.clipboard.readText()
      expect(copied).toMatch(/^# 注意: /)
      expect(copied).toContain(`--data-raw '${body}'`)
    })

    it('本文が無ければ（ボディはありません）案内も出さない', () => {
      render(
        <RequestTab
          entry={makeEntry({ method: 'GET', requestBody: undefined })}
          revealSecrets={false}
        />,
      )
      expect(screen.queryByRole('note')).toBeNull()
    })
  })

  describe('秘匿情報のマスク', () => {
    it('既定ではヘッダー表の Authorization をマスクする', () => {
      render(<RequestTab entry={makeEntry()} revealSecrets={false} />)
      const table = screen.getByRole('table', { name: 'リクエストヘッダー' })
      expect(within(table).getByText('Authorization')).not.toBeNull()
      expect(table.textContent).not.toContain(SECRET)
      expect(table.textContent).toContain('Bearer ••••7890')
      // 秘匿でないヘッダーはそのまま
      expect(within(table).getByText('application/json')).not.toBeNull()
      expect(screen.getByText(/認証情報の値はマスクしています/)).not.toBeNull()
    })

    it('表示する設定ではそのまま出し、マスクの注記も消える', () => {
      render(<RequestTab entry={makeEntry()} revealSecrets />)
      const table = screen.getByRole('table', { name: 'リクエストヘッダー' })
      expect(table.textContent).toContain(`Bearer ${SECRET}`)
      expect(screen.queryByText(/認証情報の値はマスクしています/)).toBeNull()
    })

    it('cURL も設定に従ってマスクする', () => {
      const { rerender } = render(<RequestTab entry={makeEntry()} revealSecrets={false} />)
      expect(codeBlockOf('bash').textContent).not.toContain(SECRET)
      expect(codeBlockOf('bash').textContent).toContain('Authorization: Bearer ••••7890')
      rerender(<RequestTab entry={makeEntry()} revealSecrets />)
      expect(codeBlockOf('bash').textContent).toContain(`Authorization: Bearer ${SECRET}`)
    })

    it('cURL は宛先 URL とボディを含む', () => {
      render(<RequestTab entry={makeEntry()} revealSecrets={false} />)
      const curl = codeBlockOf('bash').textContent ?? ''
      expect(curl).toContain("curl -N -X POST 'https://api.example.com/api/chat'")
      expect(curl).toContain('--data-raw')
    })

    it('cURL のコピー結果もマスクに従う', async () => {
      const user = userEvent.setup()
      render(<RequestTab entry={makeEntry()} revealSecrets={false} />)
      await user.click(within(codeBlockOf('bash')).getByRole('button', { name: 'cURLをコピー' }))
      const copied = await navigator.clipboard.readText()
      expect(copied).not.toContain(SECRET)
      expect(copied).toContain('curl -N')
    })
  })

  describe('ボディ', () => {
    it('JSON は整形して json の CodeBlock に出す', () => {
      render(<RequestTab entry={makeEntry({ requestBody: '{"a":1}' })} revealSecrets={false} />)
      expect(codeBlockOf('json').querySelector('pre')?.textContent).toBe('{\n  "a": 1\n}')
    })

    it('JSON でないボディはテキストのまま、ハイライトしない pre で出す', () => {
      const { container } = render(
        <RequestTab
          entry={makeEntry({ requestBody: 'prompt=hello world' })}
          revealSecrets={false}
        />,
      )
      const plain = container.querySelector('[data-code-view=plain]')
      expect(plain?.textContent).toContain('prompt=hello world')
      expect(screen.getAllByTestId('code-block')).toHaveLength(1) // cURL だけ
    })

    it('ボディが無いときはその旨を出す', () => {
      render(
        <RequestTab
          entry={makeEntry({ method: 'GET', requestBody: undefined })}
          revealSecrets={false}
        />,
      )
      expect(screen.getByText('ボディはありません')).not.toBeNull()
    })

    it('ボディのコピーは整形前の原文（桁落ち・重複キーを起こさない）', async () => {
      const user = userEvent.setup()
      const body = '{"id":12345678901234567890,"a":1,"a":2,"n":1.0}'
      render(<RequestTab entry={makeEntry({ requestBody: body })} revealSecrets={false} />)
      expect(codeBlockOf('json').querySelector('pre')?.textContent).toContain(
        '"id": 12345678901234567890',
      )
      await user.click(screen.getByRole('button', { name: 'リクエストボディをコピー' }))
      expect(await navigator.clipboard.readText()).toBe(body)
    })
  })

  describe('URL・本文の秘匿情報', () => {
    const URL_KEY = 'sk-live-SECRETSECRET'
    const BODY_KEY = 'sk-body-secret-0000000'
    const leaky = () =>
      makeEntry({
        targetUrl: `https://api.example.com/v1/chat?api_key=${URL_KEY}&model=gpt`,
        requestBody: `{"apiKey":"${BODY_KEY}","messages":[]}`,
      })

    it('既定では、宛先 URL・本文・cURL のどこにも秘密を出さない', () => {
      const { container } = render(<RequestTab entry={leaky()} revealSecrets={false} />)
      const url = screen.getByLabelText<HTMLInputElement>('宛先 URL').value
      expect(url).toContain('api_key=••••')
      expect(url).toContain('model=gpt')
      expect(container.textContent).not.toContain(URL_KEY)
      expect(container.textContent).not.toContain(BODY_KEY)
      expect(codeBlockOf('json').textContent).toContain('"apiKey": "••••')
      expect(codeBlockOf('bash').textContent).toContain('api_key=••••')
      // 本文のマスクを案内する
      expect(screen.getAllByText(/認証情報らしい値/)).toHaveLength(2)
    })

    it('コピーした宛先 URL・本文・cURL もマスク済み', async () => {
      const user = userEvent.setup()
      render(<RequestTab entry={leaky()} revealSecrets={false} />)

      await user.click(screen.getByRole('button', { name: '宛先 URL をコピー' }))
      const url = await navigator.clipboard.readText()
      expect(url).not.toContain(URL_KEY)
      expect(url).toContain('api_key=••••')

      await user.click(screen.getByRole('button', { name: 'リクエストボディをコピー' }))
      const body = await navigator.clipboard.readText()
      expect(body).not.toContain(BODY_KEY)
      expect(body).toMatch(/^\{"apiKey":"••••.*","messages":\[\]\}$/)

      await user.click(within(codeBlockOf('bash')).getByRole('button', { name: 'cURLをコピー' }))
      const curl = await navigator.clipboard.readText()
      expect(curl).not.toContain(URL_KEY)
      expect(curl).not.toContain(BODY_KEY)
      expect(curl).toContain('api_key=••••')
      expect(curl).toContain('--data-raw')
    })

    it('秘匿情報を表示する設定では、そのまま出し、注記も消える', () => {
      render(<RequestTab entry={leaky()} revealSecrets />)
      expect(screen.getByLabelText<HTMLInputElement>('宛先 URL').value).toContain(URL_KEY)
      expect(codeBlockOf('json').textContent).toContain(BODY_KEY)
      expect(codeBlockOf('bash').textContent).toContain(URL_KEY)
      expect(screen.queryByText(/認証情報らしい値/)).toBeNull()
    })

    it('秘匿でない URL・本文には注記を出さない', () => {
      render(<RequestTab entry={makeEntry()} revealSecrets={false} />)
      expect(screen.queryByText(/認証情報らしい値/)).toBeNull()
    })
  })

  describe('大きいボディ', () => {
    const big = `${'x'.repeat(39_999)}\n` // 40,000 文字（JSON ではない）

    it('先頭だけを描画し、cURL には全文を出さない', () => {
      const { container } = render(
        <RequestTab entry={makeEntry({ requestBody: big })} revealSecrets={false} />,
      )
      const rendered = container.querySelector('[data-code-view=plain] pre')?.textContent ?? ''
      expect(rendered.length).toBe(30_000)
      expect(screen.getByText(/先頭 30,000 文字のみ表示/)).not.toBeNull()
      expect(screen.getByText(/全 40,000 文字/)).not.toBeNull()
      const curl = codeBlockOf('bash').textContent ?? ''
      expect(curl).toContain('<省略: 40,000 文字')
      expect(curl.length).toBeLessThan(1000)
    })

    it('「全文を表示」で全文を描画する', async () => {
      const user = userEvent.setup()
      const { container } = render(
        <RequestTab entry={makeEntry({ requestBody: big })} revealSecrets={false} />,
      )
      await user.click(screen.getByRole('button', { name: '全文を表示' }))
      expect(container.querySelector('[data-code-view=plain] pre')?.textContent).toBe(big)
      expect(screen.queryByRole('button', { name: '全文を表示' })).toBeNull()
    })

    it('「全文を表示」でも描画する文字数に上限があり、全文はコピーできる', async () => {
      const user = userEvent.setup()
      const huge = 'y'.repeat(2_100_000)
      const { container } = render(
        <RequestTab entry={makeEntry({ requestBody: huge })} revealSecrets={false} />,
      )
      await user.click(screen.getByRole('button', { name: '全文を表示' }))
      const rendered = container.querySelector('[data-code-view=plain] pre')?.textContent ?? ''
      expect(rendered.length).toBe(2_000_000)
      expect(screen.getByText(/表示上限（2,000,000 文字）を超える/)).not.toBeNull()
      await user.click(screen.getByRole('button', { name: '全文をコピー' }))
      expect(await navigator.clipboard.readText()).toBe(huge)
    })

    it('全文のコピーと cURL のコピーは、切り詰めていない全文を含む', async () => {
      const user = userEvent.setup()
      render(<RequestTab entry={makeEntry({ requestBody: big })} revealSecrets={false} />)
      await user.click(screen.getByRole('button', { name: '全文をコピー' }))
      expect(await navigator.clipboard.readText()).toBe(big)

      await user.click(within(codeBlockOf('bash')).getByRole('button', { name: 'cURLをコピー' }))
      const curl = await navigator.clipboard.readText()
      expect(curl).toContain(`--data-raw '${big}'`)
      expect(curl).toContain('Authorization: Bearer ••••')
      expect(curl).not.toContain('<省略')
    })

    it('巨大なボディの cURL も、秘匿情報はマスクしたままコピーされる', async () => {
      const user = userEvent.setup()
      const body = JSON.stringify({ apiKey: 'sk-body-secret-0000000', blob: 'z'.repeat(40_000) })
      render(<RequestTab entry={makeEntry({ requestBody: body })} revealSecrets={false} />)
      await user.click(within(codeBlockOf('bash')).getByRole('button', { name: 'cURLをコピー' }))
      const curl = await navigator.clipboard.readText()
      expect(curl).not.toContain('sk-body-secret-0000000')
      expect(curl).toContain('z'.repeat(40_000))
    })

    it('小さいボディには切り詰めの案内を出さない', () => {
      render(<RequestTab entry={makeEntry()} revealSecrets={false} />)
      expect(screen.queryByRole('button', { name: '全文を表示' })).toBeNull()
      expect(codeBlockOf('bash').textContent).not.toContain('<省略')
    })
  })

  it('ヘッダーが無いときは空表示', () => {
    render(<RequestTab entry={makeEntry({ requestHeaders: {} })} revealSecrets={false} />)
    expect(screen.getByText('ヘッダーはありません')).not.toBeNull()
  })
})
