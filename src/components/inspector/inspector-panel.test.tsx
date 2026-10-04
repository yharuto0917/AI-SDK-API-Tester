// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InspectorPanel } from '@/components/inspector/inspector-panel'
import { makeTextStreamEvents } from '@/components/inspector/test-fixtures'
import { networkLog } from '@/lib/network-log'
import { PROXY_NAME } from '@/lib/proxy'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@/components/ai-elements/code-block', async (importOriginal) =>
  (await import('@/components/inspector/test-fixtures')).mockCodeBlock(await importOriginal()),
)

const SECRET = 'sk-live-abcdef1234567890'
const URL_SECRET = 'sk-url-SECRETSECRETSECRET'
const BODY_SECRET = 'sk-body-SECRETSECRETSECRET'

interface LogOptions {
  url?: string
  /** SSE として記録するイベント数。0 ならボディの無い 204 応答（イベントが 1 件も無い）にする */
  events?: number
  /** true なら finish せず、通信中のままにする */
  open?: boolean
  viaProxy?: boolean
  /** リクエスト本文。既定は秘匿情報を含まないチャット本文 */
  body?: string
  /** SSE ではなく、この JSON を本文とする 200 応答にする（エコー系のバックエンドを模す） */
  jsonResponse?: string
}

/** 本物のストア（アプリが使うもの）に 1 件の通信を記録する。 */
function logRequest(opts: LogOptions = {}): string {
  const {
    url = 'https://api.example.com/api/chat',
    events = 4,
    open = false,
    viaProxy = false,
    body = '{"messages":[{"role":"user","content":"hi"}]}',
    jsonResponse,
  } = opts
  let id = ''
  act(() => {
    id = networkLog.begin({
      mode: 'chat-ui',
      method: 'POST',
      targetUrl: url,
      viaProxy,
      requestHeaders: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      requestBody: body,
    })
    const sse = jsonResponse === undefined && events > 0
    const hasBody = sse || jsonResponse !== undefined
    networkLog.recordHead(id, {
      status: hasBody ? 200 : 204,
      statusText: hasBody ? 'OK' : 'No Content',
      responseHeaders: sse
        ? { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' }
        : jsonResponse !== undefined
          ? { 'Content-Type': 'application/json' }
          : {},
    })
    if (sse) {
      const lines = makeTextStreamEvents(events).map((event) => `data: ${event.raw}\n\n`)
      networkLog.recordText(id, lines.join('') + 'data: [DONE]\n\n', { sse: true })
    } else if (jsonResponse !== undefined) {
      networkLog.recordText(id, jsonResponse, { sse: false })
    }
    if (!open) networkLog.finish(id, { state: 'done' })
  })
  return id
}

function options(): HTMLElement[] {
  return screen.queryAllByRole('option')
}

function tab(name: RegExp): HTMLElement {
  return screen.getByRole('tab', { name })
}

function revealSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: '秘匿情報を表示' })
}

/** Blob の中身を読む（jsdom の Blob に text() が無くても動くよう FileReader を使う）。 */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Blob を読めません'))
    reader.readAsText(blob)
  })
}

beforeEach(() => {
  act(() => networkLog.clear())
})

describe('InspectorPanel', () => {
  describe('空の状態', () => {
    it('一覧と詳細の両方に案内を出し、操作ボタンは無効にする', () => {
      render(<InspectorPanel />)
      expect(screen.getByText('まだ通信がありません')).not.toBeNull()
      expect(screen.getByText('メッセージを送信するとここに表示されます')).not.toBeNull()
      expect(screen.getByText('通信を選択してください')).not.toBeNull()
      expect(screen.getByRole('button', { name: 'クリア' }).hasAttribute('disabled')).toBe(true)
      expect(
        screen.getByRole('button', { name: 'ログをJSONで保存' }).hasAttribute('disabled'),
      ).toBe(true)
      expect(screen.getByLabelText('通信 0 件')).not.toBeNull()
    })

    it('秘匿情報を表示するスイッチは既定でオフ', () => {
      render(<InspectorPanel />)
      expect(revealSwitch().getAttribute('aria-checked')).toBe('false')
    })
  })

  describe('通信の表示', () => {
    it('通信が記録されると、一覧に出て自動で選択され、診断が表示される', () => {
      render(<InspectorPanel />)
      logRequest()
      expect(screen.getByLabelText('通信 1 件')).not.toBeNull()
      expect(options()).toHaveLength(1)
      expect(options()[0]?.getAttribute('aria-selected')).toBe('true')
      expect(screen.getByText('ストリームは正常に完了しました')).not.toBeNull()
      expect(screen.queryByText('通信を選択してください')).toBeNull()
    })

    it('診断タブに最悪 level の件数バッジが付く', () => {
      render(<InspectorPanel />)
      logRequest()
      const badge = within(tab(/診断/)).getByText(/^\d+$/)
      expect(badge.getAttribute('data-level')).toBe('ok')
    })

    it('エラーの診断があるときは、バッジが error になる', () => {
      render(<InspectorPanel />)
      act(() => {
        const id = networkLog.begin({
          mode: 'chat-ui',
          method: 'POST',
          targetUrl: 'https://api.example.com/api/chat',
          viaProxy: false,
          requestHeaders: {},
        })
        networkLog.finish(id, {
          state: 'error',
          error: {
            name: 'TypeError',
            message: 'Failed to fetch',
            hint: 'サーバーを確認してください',
          },
        })
      })
      expect(within(tab(/診断/)).getByText(/^\d+$/).getAttribute('data-level')).toBe('error')
      expect(screen.getByRole('group', { name: '通信エラー: TypeError' })).not.toBeNull()
    })

    it('新しい通信が先頭に来て、そちらが選択される', () => {
      render(<InspectorPanel />)
      const first = logRequest({ url: 'https://api.example.com/first' })
      const second = logRequest({ url: 'https://api.example.com/second' })
      expect(options().map((o) => o.getAttribute('data-entry-id'))).toEqual([second, first])
      expect(options()[0]?.getAttribute('aria-selected')).toBe('true')
    })

    it('一覧の行をクリックすると、詳細がその通信に切り替わる', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest({ url: 'https://api.example.com/first' })
      logRequest({ url: 'https://api.example.com/second' })

      await user.click(tab(/リクエスト/))
      expect(screen.getByLabelText<HTMLInputElement>('宛先 URL').value).toBe(
        'https://api.example.com/second',
      )
      await user.click(options()[1] as HTMLElement)
      expect(screen.getByLabelText<HTMLInputElement>('宛先 URL').value).toBe(
        'https://api.example.com/first',
      )
    })

    it('上下キーで選択を動かすと、詳細も追従する', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest({ url: 'https://api.example.com/first' })
      logRequest({ url: 'https://api.example.com/second' })
      await user.click(tab(/リクエスト/))

      options()[0]?.focus()
      await user.keyboard('{ArrowDown}')
      expect(screen.getByLabelText<HTMLInputElement>('宛先 URL').value).toBe(
        'https://api.example.com/first',
      )
      await user.keyboard('{ArrowUp}')
      expect(screen.getByLabelText<HTMLInputElement>('宛先 URL').value).toBe(
        'https://api.example.com/second',
      )
    })

    it('選択を切り替えても、開いているタブは保たれる', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest()
      logRequest()
      await user.click(tab(/レスポンス/))
      await user.click(options()[1] as HTMLElement)
      expect(tab(/レスポンス/).getAttribute('aria-selected')).toBe('true')
    })

    it('プロキシ経由の通信は一覧に proxy バッジ、リクエストタブに注記を出す', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest({ viaProxy: true })
      expect(within(options()[0] as HTMLElement).getByText('proxy')).not.toBeNull()
      await user.click(tab(/リクエスト/))
      expect(screen.getByText(`${PROXY_NAME}経由（実際の宛先はこの URL）`)).not.toBeNull()
    })
  })

  describe('リアルタイム更新', () => {
    it('ストリーミング中のイベントが増えると、ストリームタブの件数も増える', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      const id = logRequest({ events: 4, open: true })
      await user.click(tab(/ストリーム/))
      await waitFor(() => expect(screen.getByText(/表示 5 \/ 全 5 件/)).not.toBeNull())

      act(() => {
        networkLog.recordText(
          id,
          `data: ${JSON.stringify({ type: 'text-delta', id: 't1', delta: 'more' })}\n\n`,
          { sse: true },
        )
      })
      await waitFor(() => expect(screen.getByText(/表示 6 \/ 全 6 件/)).not.toBeNull())

      act(() => networkLog.finish(id, { state: 'done' }))
      expect(within(options()[0] as HTMLElement).getByRole('img', { name: '完了' })).not.toBeNull()
    })

    it('通信中は診断タブに「実行中…」が出て、完了すると消える', () => {
      render(<InspectorPanel />)
      const id = logRequest({ events: 4, open: true })
      expect(screen.getByText('実行中…')).not.toBeNull()
      act(() => networkLog.finish(id, { state: 'done' }))
      expect(screen.queryByText('実行中…')).toBeNull()
    })
  })

  describe('秘匿情報の表示切替', () => {
    it('スイッチでリクエストヘッダーのマスクを切り替える', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest()
      await user.click(tab(/リクエスト/))
      const table = () => screen.getByRole('table', { name: 'リクエストヘッダー' })

      expect(table().textContent).not.toContain(SECRET)
      await user.click(revealSwitch())
      expect(revealSwitch().getAttribute('aria-checked')).toBe('true')
      expect(table().textContent).toContain(`Bearer ${SECRET}`)
      await user.click(revealSwitch())
      expect(table().textContent).not.toContain(SECRET)
    })

    it('cURL も切り替えに従う', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest()
      await user.click(tab(/リクエスト/))
      const curl = () =>
        screen
          .getAllByTestId('code-block')
          .find((el) => el.getAttribute('data-language') === 'bash')?.textContent ?? ''
      expect(curl()).not.toContain(SECRET)
      await user.click(revealSwitch())
      expect(curl()).toContain(SECRET)
    })

    it('一覧の URL・宛先 URL・リクエスト本文・レスポンス本文も切り替えに従う', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest({
        url: `https://api.example.com/v1/chat?api_key=${URL_SECRET}`,
        body: `{"apiKey":"${BODY_SECRET}"}`,
        jsonResponse: JSON.stringify({ echo: SECRET }),
      })
      const page = () => document.body.textContent ?? ''
      const targetUrl = () => screen.getByLabelText<HTMLInputElement>('宛先 URL').value

      expect(options()[0]?.textContent).not.toContain(URL_SECRET)
      await user.click(tab(/リクエスト/))
      expect(targetUrl()).not.toContain(URL_SECRET)
      expect(page()).not.toContain(BODY_SECRET)
      await user.click(tab(/レスポンス/))
      expect(page()).not.toContain(SECRET)

      await user.click(revealSwitch())
      expect(options()[0]?.textContent).toContain(URL_SECRET)
      expect(page()).toContain(`"echo": "${SECRET}"`)
      await user.click(tab(/リクエスト/))
      expect(targetUrl()).toContain(URL_SECRET)
      expect(page()).toContain(BODY_SECRET)
    })

    it('設定は選択を切り替えても保たれる', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest()
      logRequest()
      await user.click(tab(/リクエスト/))
      await user.click(revealSwitch())
      await user.click(options()[1] as HTMLElement)
      expect(screen.getByRole('table', { name: 'リクエストヘッダー' }).textContent).toContain(
        SECRET,
      )
    })
  })

  describe('ログをJSONで保存', () => {
    let created: Blob[]
    let downloads: string[]

    beforeEach(() => {
      created = []
      downloads = []
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: (blob: Blob) => {
          created.push(blob)
          return 'blob:mock'
        },
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: () => {},
      })
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        downloads.push(this.download)
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
      Reflect.deleteProperty(URL, 'createObjectURL')
      Reflect.deleteProperty(URL, 'revokeObjectURL')
    })

    it('選択中の通信を、マスクした JSON として保存する', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      const id = logRequest()
      await user.click(screen.getByRole('button', { name: 'ログをJSONで保存' }))

      expect(created).toHaveLength(1)
      expect(downloads).toHaveLength(1)
      expect(downloads[0]).toMatch(new RegExp(`^ai-sdk-log_${id}_\\d{8}-\\d{6}\\.json$`))
      const text = await readBlob(created[0] as Blob)
      expect(text).not.toContain(SECRET)
      const payload: unknown = JSON.parse(text)
      expect(payload).toMatchObject({
        secretsMasked: true,
        entry: { id, method: 'POST', status: 200 },
      })
    })

    it('秘匿情報を表示する設定なら、そのまま保存する', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest()
      await user.click(revealSwitch())
      await user.click(screen.getByRole('button', { name: 'ログをJSONで保存' }))
      const text = await readBlob(created[0] as Blob)
      expect(text).toContain(SECRET)
      expect(JSON.parse(text)).toMatchObject({ secretsMasked: false })
    })

    it('URL のクエリ・本文・エコーされた応答の秘匿情報も、マスクして保存する', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest({
        url: `https://api.example.com/v1/chat?api_key=${URL_SECRET}&model=gpt`,
        body: `{"apiKey":"${BODY_SECRET}","messages":[]}`,
        jsonResponse: JSON.stringify({ headers: { authorization: `Bearer ${SECRET}` }, ok: true }),
      })
      await user.click(screen.getByRole('button', { name: 'ログをJSONで保存' }))

      const text = await readBlob(created[0] as Blob)
      for (const secret of [SECRET, URL_SECRET, BODY_SECRET]) expect(text).not.toContain(secret)
      const payload: { maskingNote?: string; entry: { targetUrl: string; rawBody: string } } =
        JSON.parse(text)
      expect(payload.maskingNote).toContain('共有前に内容を確認')
      expect(payload.entry.targetUrl).toContain('model=gpt')
      expect(payload.entry.rawBody).toContain('"ok":true')
    })

    it('秘匿情報を表示する設定なら、URL・本文もそのまま保存する', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest({
        url: `https://api.example.com/v1/chat?api_key=${URL_SECRET}`,
        body: `{"apiKey":"${BODY_SECRET}"}`,
      })
      await user.click(revealSwitch())
      await user.click(screen.getByRole('button', { name: 'ログをJSONで保存' }))
      const text = await readBlob(created[0] as Blob)
      expect(text).toContain(URL_SECRET)
      expect(text).toContain(BODY_SECRET)
      expect(text).not.toContain('maskingNote')
    })

    it('保存の完了トーストで、マスクの範囲と限界を伝える', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest()
      await user.click(screen.getByRole('button', { name: 'ログをJSONで保存' }))
      expect(toast.success).toHaveBeenLastCalledWith(
        expect.stringContaining('を保存しました'),
        expect.objectContaining({ description: expect.stringContaining('共有前に内容を確認') }),
      )

      await user.click(revealSwitch())
      await user.click(screen.getByRole('button', { name: 'ログをJSONで保存' }))
      expect(toast.success).toHaveBeenLastCalledWith(
        expect.stringContaining('を保存しました'),
        expect.objectContaining({ description: '秘匿情報をマスクせずに保存しました' }),
      )
    })

    it('保存できないブラウザでも例外を投げない', async () => {
      const user = userEvent.setup()
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: () => {
          throw new Error('unsupported')
        },
      })
      render(<InspectorPanel />)
      logRequest()
      await user.click(screen.getByRole('button', { name: 'ログをJSONで保存' }))
      expect(downloads).toHaveLength(0)
    })
  })

  describe('クリア', () => {
    it('通信を全部消し、一覧と詳細を空に戻す', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest()
      logRequest()
      expect(options()).toHaveLength(2)

      await user.click(screen.getByRole('button', { name: 'クリア' }))
      expect(options()).toHaveLength(0)
      expect(screen.getByText('まだ通信がありません')).not.toBeNull()
      expect(screen.getByText('通信を選択してください')).not.toBeNull()
      expect(screen.getByLabelText('通信 0 件')).not.toBeNull()
    })
  })

  describe('ストリームタブ', () => {
    it('ストリームではない通信は、その旨とレスポンスタブへの導線を出す', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest({ events: 0 })
      await user.click(tab(/ストリーム/))
      expect(screen.getByText('このレスポンスはストリームではありません')).not.toBeNull()

      await user.click(screen.getByRole('button', { name: 'レスポンスタブを開く' }))
      expect(tab(/レスポンス/).getAttribute('aria-selected')).toBe('true')
      expect(screen.getByText('204 No Content')).not.toBeNull()
    })

    it('5000 イベントを受信しても、描画する行は少なく、上限超過も明示する', async () => {
      const user = userEvent.setup()
      render(<InspectorPanel />)
      logRequest({ events: 5000 })
      await user.click(tab(/ストリーム/))
      const rows = screen.getAllByRole('listitem')
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.length).toBeLessThan(100)
      expect(screen.getByText(/表示 5000 \/ 全 5000 件/)).not.toBeNull()
      expect(screen.getByText(/保存上限を超えたため/)).not.toBeNull()
    })
  })
})
