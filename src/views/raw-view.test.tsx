// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_BODY_CHARS } from '@/components/raw/raw-utils'
import { formatBytes } from '@/lib/format'
import { networkLog } from '@/lib/network-log'
import { PROXY_NAME } from '@/lib/proxy'
import { newHeaderEntry } from '@/lib/settings'
import { settingsStore } from '@/lib/settings-store'
import { RawView } from '@/views/raw-view'

const encoder = new TextEncoder()
const fetchMock = vi.fn<typeof fetch>()

interface ControlledStream {
  stream: ReadableStream<Uint8Array>
  push: (text: string) => void
  close: () => void
}

/** 手動でチャンクを流せる ReadableStream。abort されたらエラーで終わる（本物の fetch と同じ）。 */
function controlledStream(signal: AbortSignal | null | undefined): ControlledStream {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  signal?.addEventListener('abort', () => {
    try {
      controller?.error(new DOMException('The operation was aborted.', 'AbortError'))
    } catch {
      // すでに閉じていれば何もしない
    }
  })
  return {
    stream,
    push: (text) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  }
}

function respondWith(body: string, init: ResponseInit = {}): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(body, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json', 'x-test': '1' },
        ...init,
      }),
  )
}

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1)
  if (call === undefined) throw new Error('fetch が呼ばれていません')
  return { url: String(call[0]), init: call[1] ?? {} }
}

function sentHeaders(): Record<string, string> {
  return (lastCall().init.headers ?? {}) as Record<string, string>
}

const sendButton = () => screen.getByRole('button', { name: '送信' })
const bodyBox = () =>
  screen.getByRole('textbox', { name: 'リクエストボディ' }) as HTMLTextAreaElement
const endpointBox = () =>
  screen.getByRole('textbox', { name: 'エンドポイント' }) as HTMLInputElement
const responseBody = () => document.querySelector('pre')?.textContent ?? ''

beforeEach(() => {
  settingsStore.reset()
  localStorage.clear()
  sessionStorage.clear()
  networkLog.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RawView: 送信と表示', () => {
  it('POST で送信し、ステータス・ボディ・所要時間・ヘッダーを表示する', async () => {
    respondWith('{"ok":true}')
    const user = userEvent.setup()
    render(<RawView />)

    expect(screen.getByText('レスポンスはまだありません')).toBeTruthy()
    await user.click(sendButton())

    expect(await screen.findByText('200 OK')).toBeTruthy()
    await waitFor(() => expect(responseBody()).toBe('{"ok":true}'))
    expect(screen.getByText(/TTFB/)).toBeTruthy()
    expect(screen.getByText(/合計/)).toBeTruthy()
    expect(screen.getByText(/11 B/)).toBeTruthy()

    const { url, init } = lastCall()
    expect(url).toBe('http://localhost:28787/api/json')
    expect(init.method).toBe('POST')
    // 設定の既定 body がそのまま送られ、JSON なので Content-Type が付く
    expect(init.body).toBe('{\n  "hello": "world"\n}')
    expect(sentHeaders()['content-type']).toBe('application/json')

    // ログ側にも raw として記録される
    expect(networkLog.getEntries()).toHaveLength(1)
    expect(networkLog.getEntries()[0]?.mode).toBe('raw')

    // 送信が終われば「中止」は消え、「送信」が押せる
    expect(screen.queryByRole('button', { name: '中止' })).toBeNull()
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('GET ではボディ欄を無効化し、body なしで送る', async () => {
    settingsStore.update({ rawMethod: 'GET' })
    respondWith('[]')
    const user = userEvent.setup()
    render(<RawView />)

    expect(bodyBox().disabled).toBe(true)
    expect(screen.getByText('GET ではボディは送信されません')).toBeTruthy()

    await user.click(sendButton())
    await screen.findByText('200 OK')

    const { init } = lastCall()
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })

  it('空のボディは送らない（空文字 body を渡さない）', async () => {
    settingsStore.update({ rawBody: '   \n' })
    respondWith('{}')
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(sendButton())
    await screen.findByText('200 OK')
    expect(lastCall().init.body).toBeUndefined()
  })

  it('JSON でないボディも文字列のまま送れる（Content-Type は自動付与しない）', async () => {
    settingsStore.update({ rawBody: 'plain text' })
    respondWith('ok', { headers: { 'content-type': 'text/plain' } })
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(sendButton())
    await screen.findByText('200 OK')
    expect(lastCall().init.body).toBe('plain text')
    expect(sentHeaders()['content-type']).toBeUndefined()
  })

  it('設定パネルのヘッダーと Bearer トークンが送信に反映される', async () => {
    settingsStore.update({
      headers: [
        newHeaderEntry({ name: 'X-Custom', value: 'abc' }),
        newHeaderEntry({ name: 'X-Off', value: 'no', enabled: false }),
      ],
      bearerToken: 'secret-token',
    })
    respondWith('{}')
    const user = userEvent.setup()
    render(<RawView />)

    // 適用中の設定が画面に出る
    expect(screen.getByText('追加ヘッダー 1 件')).toBeTruthy()
    expect(screen.getByText('Bearer トークン')).toBeTruthy()

    await user.click(sendButton())
    await screen.findByText('200 OK')
    const headers = sentHeaders()
    expect(headers['x-custom']).toBe('abc')
    expect(headers['x-off']).toBeUndefined()
    expect(headers.authorization).toBe('Bearer secret-token')
  })

  it.each([
    [201, 'Created', 'success'],
    [301, 'Moved Permanently', 'redirect'],
    [404, 'Not Found', 'client-error'],
    [500, 'Internal Server Error', 'server-error'],
  ])('ステータス %i は %s として色分けされ、ボディも表示する', async (status, statusText, tone) => {
    respondWith('{"error":"x"}', { status, statusText })
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(sendButton())
    const badge = await screen.findByText(`${status} ${statusText}`)
    expect(badge.getAttribute('data-tone')).toBe(tone)
    await waitFor(() => expect(responseBody()).toBe('{"error":"x"}'))
  })

  it('レスポンスヘッダーは畳まれていて、開くと一覧が見える', async () => {
    respondWith('{}')
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(sendButton())
    await screen.findByText('200 OK')

    expect(screen.queryByText('x-test')).toBeNull()
    await user.click(screen.getByRole('button', { name: /レスポンスヘッダー（2）/ }))
    expect(screen.getByText('x-test')).toBeTruthy()
    expect(screen.getByText('application/json')).toBeTruthy()
  })

  it('ボディが空のレスポンスはその旨を表示する', async () => {
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 204, statusText: 'No Content' }),
    )
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(sendButton())
    expect(await screen.findByText('204 No Content')).toBeTruthy()
    expect(screen.getByText('（レスポンスボディは空です）')).toBeTruthy()
  })

  it('クリアで表示がすべて消える', async () => {
    respondWith('{"ok":true}')
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(sendButton())
    await screen.findByText('200 OK')
    await user.click(screen.getByRole('button', { name: 'レスポンスをクリア' }))

    expect(screen.getByText('レスポンスはまだありません')).toBeTruthy()
    expect(screen.queryByText('200 OK')).toBeNull()
  })

  it('バイナリらしい Content-Type には注意書きを出す', async () => {
    respondWith('PNGDATA', { headers: { 'content-type': 'image/png' } })
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(sendButton())
    expect(await screen.findByText('バイナリの可能性があります')).toBeTruthy()
  })

  it('表示上限を超えたら切り詰めて明示し、受信バイト数は最後まで数える', async () => {
    const size = MAX_BODY_CHARS + 500
    respondWith('a'.repeat(size), { headers: { 'content-type': 'text/plain' } })
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(sendButton())
    expect(await screen.findByText('表示を切り詰めました')).toBeTruthy()
    await waitFor(() => expect(responseBody().length).toBe(MAX_BODY_CHARS))
    // 切り詰めた 1,000,000 文字ではなく、実際に受信した 1,000,500 バイトを出す
    expect(screen.getByText(new RegExp(formatBytes(size)))).toBeTruthy()
  })
})

describe('RawView: ストリーミングと中止', () => {
  it('ボディを受信しながらライブ表示し、完了で受信中の表示が消える', async () => {
    let live: ControlledStream | undefined
    fetchMock.mockImplementation(async (_input, init) => {
      live = controlledStream(init?.signal)
      return new Response(live.stream, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const user = userEvent.setup()
    render(<RawView />)
    await user.click(sendButton())

    await waitFor(() => expect(live).toBeDefined())
    await screen.findByText('200 OK')
    act(() => live?.push('data: one\n\n'))
    await waitFor(() => expect(responseBody()).toContain('data: one'))
    expect(screen.getAllByText('受信中…').length).toBeGreaterThan(0)
    // 受信中は「中止」が出て、「送信」は押せない
    expect(screen.getByRole('button', { name: '中止' })).toBeTruthy()
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true)

    act(() => {
      live?.push('data: two\n\n')
      live?.close()
    })
    await waitFor(() => expect(responseBody()).toBe('data: one\n\ndata: two\n\n'))
    await waitFor(() => expect(screen.queryAllByText('受信中…')).toHaveLength(0))
    expect(screen.queryByRole('button', { name: '中止' })).toBeNull()
  })

  it('中止すると通信を止め、それまでに届いたボディは残す', async () => {
    let live: ControlledStream | undefined
    fetchMock.mockImplementation(async (_input, init) => {
      live = controlledStream(init?.signal)
      return new Response(live.stream, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
      })
    })
    const user = userEvent.setup()
    render(<RawView />)
    await user.click(sendButton())
    await waitFor(() => expect(live).toBeDefined())
    act(() => live?.push('partial'))
    await waitFor(() => expect(responseBody()).toContain('partial'))

    await user.click(screen.getByRole('button', { name: '中止' }))

    expect(await screen.findByText('中止しました')).toBeTruthy()
    expect(responseBody()).toContain('partial')
    expect(screen.getByRole('button', { name: '送信' })).toBeTruthy()
    // ログ側も中止として記録される
    await waitFor(() => expect(networkLog.getEntries()[0]?.state).toBe('aborted'))
  })

  it('ヘッダー受信前でも中止できる', async () => {
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        }),
    )
    const user = userEvent.setup()
    render(<RawView />)
    await user.click(sendButton())

    expect(await screen.findByText('応答を待っています…')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '中止' }))
    expect(await screen.findByText('中止しました')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('連打しても二重に送らず、2 回目のクリックで中止もしない', async () => {
    let live: ControlledStream | undefined
    fetchMock.mockImplementation(async (_input, init) => {
      live = controlledStream(init?.signal)
      return new Response(live.stream, { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    render(<RawView />)
    const button = sendButton()
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 中止されていれば stream はエラーで閉じており、close() が例外になる
    expect(() => act(() => live?.close())).not.toThrow()
    await waitFor(() => expect(screen.queryByText('中止しました')).toBeNull())
    expect(await screen.findByText('200')).toBeTruthy()
  })
})

describe('RawView: エラー表示', () => {
  it('fetch の失敗をメッセージと原因の候補つきで表示する', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(sendButton())
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('リクエストに失敗しました')).toBeTruthy()
    expect(within(alert).getByText('Failed to fetch')).toBeTruthy()
    expect(within(alert).getByText(/CORS/)).toBeTruthy()
    expect(within(alert).getByText(/インスペクタの診断/)).toBeTruthy()
    expect(screen.getByText('失敗')).toBeTruthy()
    // ヘッダーを受け取れていないので「空のボディ」とは表示しない
    expect(screen.getByText('（レスポンスを受信していません）')).toBeTruthy()
    // 送信できる状態に戻る
    expect(sendButton()).toBeTruthy()
  })

  it('エンドポイントが不正だと RequestShapeError をメッセージつきで表示し、送信しない', async () => {
    settingsStore.update((prev) => ({ ...prev, endpoints: { ...prev.endpoints, raw: '' } }))
    const user = userEvent.setup()
    render(<RawView />)

    // 入力欄の下にも検証メッセージが出ている
    expect(screen.getAllByText('エンドポイントを入力してください')).toHaveLength(1)

    await user.click(sendButton())
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('リクエストを組み立てられませんでした')).toBeTruthy()
    expect(within(alert).getByText('エンドポイントを入力してください')).toBeTruthy()
    expect(within(alert).getByText(/設定パネル/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('受信中に接続が切れたら、届いた分を残してエラーを表示する', async () => {
    fetchMock.mockImplementation(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('half'))
          // 少し待ってから異常終了させる
          setTimeout(() => controller.error(new TypeError('network error')), 30)
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(sendButton())
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('network error')).toBeTruthy()
    expect(within(alert).getByText(/切断/)).toBeTruthy()
    expect(responseBody()).toContain('half')
  })
})

describe('RawView: 入力', () => {
  it('メソッドの Select と設定の rawMethod が連動する', async () => {
    const user = userEvent.setup()
    render(<RawView />)

    await user.click(screen.getByRole('combobox', { name: 'HTTP メソッド' }))
    await user.click(await screen.findByRole('option', { name: 'PUT' }))
    expect(settingsStore.getSettings().rawMethod).toBe('PUT')

    // 設定パネル側（ストア）の変更も画面に反映される
    act(() => settingsStore.update({ rawMethod: 'GET' }))
    expect(screen.getByRole('combobox', { name: 'HTTP メソッド' }).textContent).toContain('GET')
    expect(bodyBox().disabled).toBe(true)
  })

  it('エンドポイントは settings.endpoints.raw と双方向で、他モードの値を壊さない', () => {
    render(<RawView />)
    const before = settingsStore.getSettings().endpoints

    fireEvent.change(endpointBox(), { target: { value: 'https://example.com/v1/echo' } })
    const after = settingsStore.getSettings().endpoints
    expect(after.raw).toBe('https://example.com/v1/echo')
    expect(after['chat-ui']).toBe(before['chat-ui'])
    expect(after.completion).toBe(before.completion)

    act(() =>
      settingsStore.update((prev) => ({
        ...prev,
        endpoints: { ...prev.endpoints, raw: 'http://localhost:9999/x' },
      })),
    )
    expect(endpointBox().value).toBe('http://localhost:9999/x')
  })

  it('ボディは settings.rawBody と双方向', () => {
    render(<RawView />)
    fireEvent.change(bodyBox(), { target: { value: '{"edited":true}' } })
    expect(settingsStore.getSettings().rawBody).toBe('{"edited":true}')

    act(() => settingsStore.update({ rawBody: 'from settings' }))
    expect(bodyBox().value).toBe('from settings')
  })

  it('ボディが JSON として有効かを表示する（無効でも送信は止めない）', () => {
    render(<RawView />)

    fireEvent.change(bodyBox(), { target: { value: '{"a":1}' } })
    expect(screen.getByText('JSON として有効')).toBeTruthy()

    fireEvent.change(bodyBox(), { target: { value: 'hello' } })
    expect(screen.getByText('JSONではありません（文字列としてそのまま送信）')).toBeTruthy()
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(bodyBox(), { target: { value: '' } })
    expect(screen.getByText('ボディなし')).toBeTruthy()
  })

  it('整形ボタンで JSON を pretty print する（無効な JSON では押せない）', async () => {
    const user = userEvent.setup()
    render(<RawView />)

    const format = screen.getByRole('button', { name: '整形' }) as HTMLButtonElement
    fireEvent.change(bodyBox(), { target: { value: '{"a":1,"b":[1,2]}' } })
    expect(format.disabled).toBe(false)
    await user.click(format)
    expect(bodyBox().value).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
    expect(settingsStore.getSettings().rawBody).toBe(bodyBox().value)

    fireEvent.change(bodyBox(), { target: { value: '{"a":' } })
    expect(format.disabled).toBe(true)
  })

  it('Cmd/Ctrl+Enter で送信する。IME の変換中は送信しない', async () => {
    respondWith('{}')
    render(<RawView />)

    fireEvent.keyDown(bodyBox(), { key: 'Enter', metaKey: true, isComposing: true })
    fireEvent.keyDown(bodyBox(), { key: 'Enter' })
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.keyDown(bodyBox(), { key: 'Enter', ctrlKey: true })
    await screen.findByText('200 OK')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(bodyBox(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('エンドポイント欄の Enter でも送信する（変換確定の Enter では送らない）', async () => {
    respondWith('{}')
    render(<RawView />)

    fireEvent.keyDown(endpointBox(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(endpointBox(), { key: 'Enter', keyCode: 229 })
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.keyDown(endpointBox(), { key: 'Enter' })
    await screen.findByText('200 OK')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('RawView: 設定の適用状況と注記', () => {
  it('devプロキシが ON のときは、設定パネルと同じ呼び名で表示する', () => {
    settingsStore.update({ useDevProxy: true })
    render(<RawView />)

    expect(screen.getByText(`${PROXY_NAME}経由（credentials: omit）`)).toBeTruthy()
    expect(screen.queryByText(/開発プロキシ/)).toBeNull()
  })

  it('devプロキシが OFF のときは credentials を表示する', () => {
    settingsStore.update({ useDevProxy: false, credentials: 'include' })
    render(<RawView />)

    expect(screen.getByText('credentials: include')).toBeTruthy()
    expect(screen.queryByText(new RegExp(`${PROXY_NAME}経由`))).toBeNull()
  })

  it('この画面の表示は未マスクである旨を、設定の自動適用の注記の近くに出す', () => {
    render(<RawView />)

    const note = screen.getByText(/この画面の表示は未マスクです/)
    expect(note.textContent).toContain('画面共有時は注意してください')
    expect(note.textContent).toContain('インスペクタは既定でマスクします')
    // 設定パネルの値が自動適用される旨の注記と同じ「リクエスト」欄の中にある
    const section = screen.getByRole('region', { name: 'リクエスト' })
    expect(within(section).getByText(/設定パネルの値が自動で適用されます/)).toBeTruthy()
    expect(section.contains(note)).toBe(true)
  })
})

describe('RawView: JSON 整形トグル', () => {
  it('全体が JSON のときだけ整形表示に切り替わる', async () => {
    respondWith('{"a":1,"b":[1,2]}')
    const user = userEvent.setup()
    render(<RawView />)
    await user.click(sendButton())
    await waitFor(() => expect(responseBody()).toBe('{"a":1,"b":[1,2]}'))

    await user.click(screen.getByRole('switch', { name: 'JSON を整形' }))
    expect(responseBody()).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')

    await user.click(screen.getByRole('switch', { name: 'JSON を整形' }))
    expect(responseBody()).toBe('{"a":1,"b":[1,2]}')
  })

  it('JSON でないボディは整形せず、理由を表示する', async () => {
    respondWith('data: {"a":1}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    const user = userEvent.setup()
    render(<RawView />)
    await user.click(sendButton())
    await waitFor(() => expect(responseBody()).toBe('data: {"a":1}\n\n'))

    await user.click(screen.getByRole('switch', { name: 'JSON を整形' }))
    expect(responseBody()).toBe('data: {"a":1}\n\n')
    expect(screen.getByText('JSON として解析できないため、そのまま表示しています')).toBeTruthy()
  })

  it('大きな整数を整形で変えない', async () => {
    respondWith('{"id":12345678901234567890}')
    const user = userEvent.setup()
    render(<RawView />)
    await user.click(sendButton())
    await waitFor(() => expect(responseBody()).toBe('{"id":12345678901234567890}'))

    await user.click(screen.getByRole('switch', { name: 'JSON を整形' }))
    expect(responseBody()).toBe('{\n  "id": 12345678901234567890\n}')
  })
})
