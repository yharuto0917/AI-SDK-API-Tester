// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { networkLog } from '@/lib/network-log'
import { newHeaderEntry } from '@/lib/settings'
import { settingsStore } from '@/lib/settings-store'
import { CompletionView } from '@/views/completion-view'

const encoder = new TextEncoder()
const fetchMock = vi.fn<typeof fetch>()

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'x-vercel-ai-ui-message-stream': 'v1',
}

/** UI Message Stream（data プロトコル）の SSE 本文。 */
function sse(...events: unknown[]): string {
  return events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
}

const textDelta = (delta: string) => ({ type: 'text-delta', id: 't1', delta })

function uiStream(...deltas: string[]): string {
  return sse(
    { type: 'start' },
    { type: 'text-start', id: 't1' },
    ...deltas.map(textDelta),
    { type: 'text-end', id: 't1' },
    { type: 'finish' },
    '[DONE]',
  )
}

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

/** 呼び出しのたびに新しい Response を返す（ボディは 1 回しか読めないため）。 */
function respondWith(body: string, init: ResponseInit = {}): void {
  fetchMock.mockImplementation(async () => new Response(body, { status: 200, ...init }))
}

function respondWithUi(...deltas: string[]): void {
  respondWith(uiStream(...deltas), { headers: SSE_HEADERS })
}

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1)
  if (call === undefined) throw new Error('fetch が呼ばれていません')
  return { url: String(call[0]), init: call[1] ?? {} }
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall().init.body)) as Record<string, unknown>
}

const promptBox = () => screen.getByRole('textbox', { name: 'プロンプト' }) as HTMLTextAreaElement
const generateButton = () => screen.getByRole('button', { name: '生成' }) as HTMLButtonElement
const stopButton = () => screen.getByRole('button', { name: '停止' }) as HTMLButtonElement
const clearButton = () => screen.getByRole('button', { name: 'クリア' }) as HTMLButtonElement
const output = () => document.querySelector('pre')?.textContent ?? ''

function setPrompt(value: string): void {
  fireEvent.change(promptBox(), { target: { value } })
}

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

describe('CompletionView: 生成', () => {
  it('data プロトコル（UI Message Stream）で生成すると出力が出る', async () => {
    respondWithUi('Hello, ', 'world')
    const user = userEvent.setup()
    render(<CompletionView />)

    expect(screen.getByText('まだ出力はありません')).toBeTruthy()
    setPrompt('あいさつして')
    await user.click(generateButton())

    await waitFor(() => expect(output()).toBe('Hello, world'))
    expect(screen.getByText('12 文字')).toBeTruthy()

    // 設定のエンドポイントへ、prompt を JSON で送る
    const { url, init } = lastCall()
    expect(url).toBe('http://localhost:28787/api/completion')
    expect(init.method).toBe('POST')
    expect(sentBody()).toEqual({ prompt: 'あいさつして' })
    // 生成が終われば再度押せる。プロンプトは残る
    await waitFor(() => expect(generateButton().disabled).toBe(false))
    expect(promptBox().value).toBe('あいさつして')
    // ログにも completion として記録される
    expect(networkLog.getEntries()[0]?.mode).toBe('completion')
  })

  it('text プロトコルではプレーンテキストをそのまま出す', async () => {
    settingsStore.update({ completionProtocol: 'text' })
    respondWith('こんにちは、\n世界', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    const user = userEvent.setup()
    render(<CompletionView />)

    setPrompt('hi')
    await user.click(generateButton())
    await waitFor(() => expect(output()).toBe('こんにちは、\n世界'))
    expect(screen.getByText('9 文字')).toBeTruthy()
  })

  it('設定の completionProtocol を変えると、次の生成から反映される', async () => {
    const user = userEvent.setup()
    render(<CompletionView />)
    expect(screen.getByText(/プロトコル: data/)).toBeTruthy()

    respondWithUi('from data')
    setPrompt('first')
    await user.click(generateButton())
    await waitFor(() => expect(output()).toBe('from data'))

    act(() => settingsStore.update({ completionProtocol: 'text' }))
    expect(screen.getByText(/プロトコル: text/)).toBeTruthy()
    respondWith('from text', { headers: { 'content-type': 'text/plain' } })
    await user.click(generateButton())
    await waitFor(() => expect(output()).toBe('from text'))

    // 戻したら再び UI Message Stream として解釈される
    act(() => settingsStore.update({ completionProtocol: 'data' }))
    respondWithUi('data again')
    await user.click(generateButton())
    await waitFor(() => expect(output()).toBe('data again'))
  })

  it('出力が増えている途中でも文字数とローディング表示が追従し、完了で消える', async () => {
    let live: ControlledStream | undefined
    fetchMock.mockImplementation(async (_input, init) => {
      live = controlledStream(init?.signal)
      return new Response(live.stream, { status: 200, headers: SSE_HEADERS })
    })
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('stream')
    await user.click(generateButton())

    await waitFor(() => expect(live).toBeDefined())
    // 先頭チャンクが届く前は待機表示
    expect(await screen.findByText('応答を待っています…')).toBeTruthy()
    expect(screen.getByText('生成中…')).toBeTruthy()
    expect(generateButton().disabled).toBe(true)
    expect(stopButton().disabled).toBe(false)

    act(() =>
      live?.push(sse({ type: 'start' }, { type: 'text-start', id: 't1' }, textDelta('abc'))),
    )
    await waitFor(() => expect(output()).toBe('abc'))
    expect(screen.getByText('3 文字')).toBeTruthy()

    act(() => {
      live?.push(
        sse(textDelta('def'), { type: 'text-end', id: 't1' }, { type: 'finish' }, '[DONE]'),
      )
      live?.close()
    })
    await waitFor(() => expect(output()).toBe('abcdef'))
    await waitFor(() => expect(screen.queryByText('生成中…')).toBeNull())
    expect(stopButton().disabled).toBe(true)
  })

  it('設定の追加ヘッダー・Bearer・追加ボディが送信に反映される', async () => {
    settingsStore.update({
      headers: [newHeaderEntry({ name: 'X-Trace', value: 'abc' })],
      bearerToken: 'tok',
      extraBody: '{"model":"demo","temperature":0.2}',
    })
    respondWithUi('ok')
    const user = userEvent.setup()
    render(<CompletionView />)

    setPrompt('hi')
    await user.click(generateButton())
    await waitFor(() => expect(output()).toBe('ok'))

    const headers = lastCall().init.headers as Record<string, string>
    expect(headers['x-trace']).toBe('abc')
    expect(headers.authorization).toBe('Bearer tok')
    expect(sentBody()).toEqual({ prompt: 'hi', model: 'demo', temperature: 0.2 })
  })

  it('エンドポイントを設定で変えても出力は消えず、次の送信から新しい宛先を使う', async () => {
    respondWithUi('keep me')
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())
    await waitFor(() => expect(output()).toBe('keep me'))

    act(() =>
      settingsStore.update((prev) => ({
        ...prev,
        endpoints: { ...prev.endpoints, completion: 'http://localhost:9999/other' },
      })),
    )
    expect(output()).toBe('keep me')

    await user.click(generateButton())
    await waitFor(() => expect(lastCall().url).toBe('http://localhost:9999/other'))
    await waitFor(() => expect(output()).toBe('keep me'))
  })

  it('空のプロンプトでは生成できない', () => {
    render(<CompletionView />)
    expect(generateButton().disabled).toBe(true)
    setPrompt('x')
    expect(generateButton().disabled).toBe(false)
    setPrompt('')
    expect(generateButton().disabled).toBe(true)
  })

  it('例のプロンプトを選ぶと入力欄に入る', async () => {
    const user = userEvent.setup()
    render(<CompletionView />)
    await user.click(
      screen.getByRole('button', { name: '日本の四季について 3 行で説明してください。' }),
    )
    expect(promptBox().value).toBe('日本の四季について 3 行で説明してください。')
  })

  it('正常終了でも本文が空なら、プロトコル設定の確認を促す', async () => {
    // data プロトコルにプレーンテキストが返ると、SSE のイベントが無いので本文は空になる
    respondWith('plain text without sse', { headers: { 'content-type': 'text/plain' } })
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())

    expect(await screen.findByText('出力が空でした')).toBeTruthy()
    expect(screen.getByText(/プロトコル（data \/ text）を確認/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('CompletionView: 停止', () => {
  it('生成中に停止すると通信を止め、それまでの出力は残す', async () => {
    let live: ControlledStream | undefined
    fetchMock.mockImplementation(async (_input, init) => {
      live = controlledStream(init?.signal)
      return new Response(live.stream, { status: 200, headers: SSE_HEADERS })
    })
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('stop me')
    await user.click(generateButton())
    await waitFor(() => expect(live).toBeDefined())
    act(() =>
      live?.push(sse({ type: 'start' }, { type: 'text-start', id: 't1' }, textDelta('Hel'))),
    )
    await waitFor(() => expect(output()).toBe('Hel'))

    await user.click(stopButton())

    await waitFor(() => expect(generateButton().disabled).toBe(false))
    expect(output()).toBe('Hel')
    expect(stopButton().disabled).toBe(true)
    // 中止はエラーではない
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(networkLog.getEntries()[0]?.state).toBe('aborted'))
  })

  it('停止後に出力が空なら、空の出力扱いにはしない', async () => {
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        }),
    )
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('x')
    await user.click(generateButton())
    await waitFor(() => expect(stopButton().disabled).toBe(false))
    await user.click(stopButton())

    await waitFor(() => expect(generateButton().disabled).toBe(false))
    expect(screen.queryByText('出力が空でした')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('CompletionView: エラー', () => {
  it('HTTP エラーはレスポンス本文つきで表示し、インスペクタを案内する', async () => {
    respondWith('{"error":"boom"}', {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'content-type': 'application/json' },
    })
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('サーバーがエラーを返しました（HTTP 500）')).toBeTruthy()
    expect(within(alert).getByText('{"error":"boom"}')).toBeTruthy()
    expect(within(alert).getByText(/インスペクタの診断を確認/)).toBeTruthy()
    // 失敗しても、また生成できる状態に戻る
    await waitFor(() => expect(generateButton().disabled).toBe(false))
  })

  it('fetch 自体の失敗（CORS・接続不可など）を表示する', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('通信に失敗しました')).toBeTruthy()
    expect(within(alert).getByText('Failed to fetch')).toBeTruthy()
    expect(within(alert).getByText(/CORS/)).toBeTruthy()
  })

  it('ストリーム内の error チャンクを表示する', async () => {
    respondWith(
      sse({ type: 'start' }, { type: 'error', errorText: 'model overloaded' }, '[DONE]'),
      { headers: SSE_HEADERS },
    )
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('ストリーム内でエラーが返されました')).toBeTruthy()
    expect(within(alert).getByText('model overloaded')).toBeTruthy()
  })

  it('スキーマに合わないチャンクは、chunk の不一致とプロトコルの両方を原因の候補として示す', async () => {
    respondWith(sse({ type: 'text-delta', delta: 123 }), { headers: SSE_HEADERS })
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('レスポンスを解釈できませんでした')).toBeTruthy()
    expect(within(alert).getByText(/chunk が AI SDK の仕様に合っていません/)).toBeTruthy()
    expect(within(alert).getByText(/プロトコルを text にしてください/)).toBeTruthy()
  })

  it('エンドポイントが不正なら RequestShapeError を表示し、送信しない', async () => {
    settingsStore.update((prev) => ({ ...prev, endpoints: { ...prev.endpoints, completion: '' } }))
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('リクエストを組み立てられませんでした')).toBeTruthy()
    expect(within(alert).getByText('エンドポイントを入力してください')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('追加ボディが壊れた JSON のときもエラーとして表示する', async () => {
    settingsStore.update({ extraBody: '{oops' })
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/追加ボディが正しいJSONではありません/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('次の生成を始めるとエラー表示は消える', async () => {
    respondWith('bad', { status: 500, headers: { 'content-type': 'text/plain' } })
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())
    await screen.findByRole('alert')

    respondWithUi('recovered')
    await user.click(generateButton())
    await waitFor(() => expect(output()).toBe('recovered'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('CompletionView: クリア', () => {
  it('クリアで出力が消え、空の表示に戻る', async () => {
    respondWithUi('some output')
    const user = userEvent.setup()
    render(<CompletionView />)

    // 何も無いときは押せない
    expect(clearButton().disabled).toBe(true)

    setPrompt('hi')
    await user.click(generateButton())
    await waitFor(() => expect(output()).toBe('some output'))
    expect(clearButton().disabled).toBe(false)

    await user.click(clearButton())
    expect(screen.getByText('まだ出力はありません')).toBeTruthy()
    expect(screen.getByText('0 文字')).toBeTruthy()
    expect(clearButton().disabled).toBe(true)
    // プロンプトは残る
    expect(promptBox().value).toBe('hi')
  })

  it('クリアでエラー表示も消え、次の失敗では再び表示される', async () => {
    respondWith('first failure', { status: 500, headers: { 'content-type': 'text/plain' } })
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())
    await screen.findByRole('alert')

    await user.click(clearButton())
    expect(screen.queryByRole('alert')).toBeNull()

    respondWith('second failure', { status: 502, headers: { 'content-type': 'text/plain' } })
    await user.click(generateButton())
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('second failure')).toBeTruthy()
  })

  it('生成中はクリアできない（先に停止する）', async () => {
    let live: ControlledStream | undefined
    fetchMock.mockImplementation(async (_input, init) => {
      live = controlledStream(init?.signal)
      return new Response(live.stream, { status: 200, headers: SSE_HEADERS })
    })
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())
    await waitFor(() => expect(live).toBeDefined())
    act(() => live?.push(sse({ type: 'start' }, { type: 'text-start', id: 't1' }, textDelta('x'))))
    await waitFor(() => expect(output()).toBe('x'))
    expect(clearButton().disabled).toBe(true)
    act(() => live?.close())
  })
})

describe('CompletionView: 表示と操作', () => {
  it('既定は生テキスト、スイッチで Markdown 表示に切り替わる', async () => {
    respondWithUi('**bold** and `code`')
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())
    await waitFor(() => expect(output()).toBe('**bold** and `code`'))

    const toggle = screen.getByRole('switch', { name: 'Markdown 表示' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await user.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    // Streamdown は strong / inline code を data-streamdown 属性つきの要素で描画する
    await waitFor(() =>
      expect(document.querySelector('[data-streamdown="strong"]')?.textContent).toBe('bold'),
    )
    expect(document.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe('code')
    expect(document.querySelector('pre')).toBeNull()

    await user.click(toggle)
    expect(output()).toBe('**bold** and `code`')
  })

  it('Cmd/Ctrl+Enter で生成する。Enter 単独と IME の変換中は生成しない', async () => {
    respondWithUi('done')
    render(<CompletionView />)
    setPrompt('hi')

    fireEvent.keyDown(promptBox(), { key: 'Enter' })
    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true, isComposing: true })
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true, keyCode: 229 })
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(output()).toBe('done'))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('生成中の Cmd/Ctrl+Enter では二重に送らない', async () => {
    let live: ControlledStream | undefined
    fetchMock.mockImplementation(async (_input, init) => {
      live = controlledStream(init?.signal)
      return new Response(live.stream, { status: 200, headers: SSE_HEADERS })
    })
    render(<CompletionView />)
    setPrompt('hi')
    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true })
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    act(() => live?.close())
  })

  it('コピーで出力全文がクリップボードに入る', async () => {
    respondWithUi('copy ', 'this')
    const user = userEvent.setup()
    render(<CompletionView />)

    const copy = screen.getByRole('button', { name: 'コピー' }) as HTMLButtonElement
    expect(copy.disabled).toBe(true)

    setPrompt('hi')
    await user.click(generateButton())
    await waitFor(() => expect(output()).toBe('copy this'))
    await user.click(copy)
    expect(await navigator.clipboard.readText()).toBe('copy this')
  })

  it('絵文字を 1 文字として数える', async () => {
    respondWithUi('😀a')
    const user = userEvent.setup()
    render(<CompletionView />)
    setPrompt('hi')
    await user.click(generateButton())
    await waitFor(() => expect(screen.getByText('2 文字')).toBeTruthy())
  })
})
