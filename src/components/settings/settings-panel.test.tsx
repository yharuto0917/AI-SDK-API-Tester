// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '@/components/settings/settings-panel'
import { PROXY_NAME, PROXY_TOGGLE_LABEL, checkProxyAvailable } from '@/lib/proxy'
import { MOCK_ENDPOINTS, newHeaderEntry } from '@/lib/settings'
import { BEARER_TOKEN_STORAGE_KEY, SETTINGS_STORAGE_KEY, settingsStore } from '@/lib/settings-store'
import type { ConnectionSettings, Mode } from '@/types'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
// 生存確認だけ差し替える。PROXY_NAME などの定数は実物を使う（画面の文言がここから組み立てられるため）
vi.mock('@/lib/proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/proxy')>()),
  checkProxyAvailable: vi.fn(),
}))

const mockedCheck = vi.mocked(checkProxyAvailable)

function setSettings(patch: Partial<ConnectionSettings>): void {
  act(() => {
    settingsStore.update(patch)
  })
}

function setMode(mode: Mode): void {
  setSettings({ mode })
}

function renderPanel() {
  return render(<SettingsPanel />)
}

function endpointInput(): HTMLInputElement {
  return screen.getByLabelText(/エンドポイント/)
}

beforeEach(() => {
  settingsStore.reset()
  localStorage.clear()
  sessionStorage.clear()
  vi.mocked(toast.success).mockClear()
  mockedCheck.mockReset()
  // 既定では devプロキシが応答する環境にする
  mockedCheck.mockResolvedValue(true)
})

describe('接続', () => {
  it('現在のモードのエンドポイントを表示し、ラベルにモード名を出す', () => {
    renderPanel()
    expect(endpointInput().value).toBe(MOCK_ENDPOINTS['chat-ui'])
    expect(screen.getByText('（Chat (UI Message Stream)）')).toBeTruthy()

    setMode('completion')
    expect(endpointInput().value).toBe(MOCK_ENDPOINTS.completion)
    expect(screen.getByText('（Completion）')).toBeTruthy()
  })

  it('エンドポイントの編集が、現在のモードの設定だけに反映される', async () => {
    const user = userEvent.setup()
    setMode('completion')
    renderPanel()

    await user.clear(endpointInput())
    await user.type(endpointInput(), 'https://example.com/api/complete')

    const { endpoints } = settingsStore.getSettings()
    expect(endpoints.completion).toBe('https://example.com/api/complete')
    expect(endpoints['chat-ui']).toBe(MOCK_ENDPOINTS['chat-ui'])
    expect(endpoints.raw).toBe(MOCK_ENDPOINTS.raw)
  })

  it('不正なエンドポイントはインラインでエラー表示する', async () => {
    const user = userEvent.setup()
    renderPanel()
    expect(screen.queryByRole('alert')).toBeNull()

    await user.clear(endpointInput())
    expect(screen.getByRole('alert').textContent).toBe('エンドポイントを入力してください')
    expect(endpointInput().getAttribute('aria-invalid')).toBe('true')
    expect(endpointInput().getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)

    await user.type(endpointInput(), 'example.com')
    expect(screen.getByRole('alert').textContent).toContain('絶対URL')

    await user.clear(endpointInput())
    await user.type(endpointInput(), '/api/chat')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(endpointInput().getAttribute('aria-invalid')).toBe('false')
  })

  it('「モックサーバーに接続」で全モードのエンドポイントが戻り、toast で通知する', async () => {
    const user = userEvent.setup()
    act(() => {
      settingsStore.update((prev) => ({
        ...prev,
        endpoints: {
          'chat-ui': 'https://a.example.com',
          'chat-text': 'https://b.example.com',
          completion: 'https://c.example.com',
          raw: 'https://d.example.com',
        },
      }))
    })
    renderPanel()

    await user.click(screen.getByRole('button', { name: 'モックサーバーに接続' }))

    expect(settingsStore.getSettings().endpoints).toEqual(MOCK_ENDPOINTS)
    expect(endpointInput().value).toBe(MOCK_ENDPOINTS['chat-ui'])
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('モックサーバーの起動コマンドを表示する', () => {
    renderPanel()
    const command = screen.getByLabelText('モックサーバーの起動コマンド') as HTMLInputElement
    expect(command.value).toBe('pnpm mock')
    expect(screen.getByRole('button', { name: '起動コマンドをコピー' })).toBeTruthy()
  })

  it('devプロキシのスイッチで useDevProxy が切り替わる', async () => {
    const user = userEvent.setup()
    renderPanel()
    const toggle = screen.getByRole('switch', { name: PROXY_TOGGLE_LABEL })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await user.click(toggle)
    expect(settingsStore.getSettings().useDevProxy).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('プロキシの状態を表示し、「再確認」で確認し直す', async () => {
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('利用可能'))
    expect(mockedCheck).toHaveBeenCalledTimes(1)

    mockedCheck.mockResolvedValue(false)
    await user.click(screen.getByRole('button', { name: '再確認' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('利用不可'))
    expect(mockedCheck).toHaveBeenCalledTimes(2)
  })

  it('プロキシが ON なのに利用不可なら警告する', async () => {
    mockedCheck.mockResolvedValue(false)
    setSettings({ useDevProxy: true })
    renderPanel()
    expect(await screen.findByText(`${PROXY_NAME}を利用できません`)).toBeTruthy()
  })

  it('プロキシが OFF なら、利用不可でも警告しない', async () => {
    mockedCheck.mockResolvedValue(false)
    renderPanel()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('利用不可'))
    expect(screen.queryByText(`${PROXY_NAME}を利用できません`)).toBeNull()
  })

  it('プロキシが ON で利用可能なら警告しない', async () => {
    setSettings({ useDevProxy: true })
    renderPanel()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('利用可能'))
    expect(screen.queryByText(`${PROXY_NAME}を利用できません`)).toBeNull()
  })

  it('プロキシ利用時に相対パスなら「絶対URLが必要」と表示する', () => {
    setSettings({ useDevProxy: true })
    act(() => {
      settingsStore.update((prev) => ({
        ...prev,
        endpoints: { ...prev.endpoints, 'chat-ui': '/api/chat' },
      }))
    })
    renderPanel()
    expect(screen.getByText('絶対URLが必要です')).toBeTruthy()
  })

  it('プロキシ利用時でも絶対URLなら「絶対URLが必要」とは言わない', () => {
    setSettings({ useDevProxy: true })
    renderPanel()
    expect(screen.queryByText('絶対URLが必要です')).toBeNull()
  })

  it('プロキシの呼び名は PROXY_NAME に統一し、揺れた表記を画面に出さない', async () => {
    mockedCheck.mockResolvedValue(false)
    setSettings({ useDevProxy: true })
    act(() => {
      settingsStore.update((prev) => ({
        ...prev,
        endpoints: { ...prev.endpoints, 'chat-ui': '/api/chat' },
      }))
    })
    const { container } = renderPanel()
    // ON・利用不可・相対パスで、プロキシに触れる文言がすべて出る状態にする
    await screen.findByText(`${PROXY_NAME}を利用できません`)

    expect(screen.getByText(PROXY_TOGGLE_LABEL)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(`${PROXY_NAME}: 利用不可`)
    expect(screen.getByText(new RegExp(`^${PROXY_NAME}利用時は`))).toBeTruthy()
    expect(screen.getByText(new RegExp(`^${PROXY_NAME}利用中は`))).toBeTruthy()
    expect(container.textContent).not.toMatch(/開発プロキシ|dev プロキシ/)
  })
})

describe('認証', () => {
  it('Bearer トークンは sessionStorage にだけ保存される', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.type(screen.getByLabelText('Bearer トークン'), 'secret-token')

    expect(settingsStore.getSettings().bearerToken).toBe('secret-token')
    expect(sessionStorage.getItem(BEARER_TOKEN_STORAGE_KEY)).toBe('secret-token')
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').not.toContain('secret-token')
    expect(screen.getByText(/sessionStorage\s*にのみ保存され、タブを閉じると消えます/)).toBeTruthy()
  })

  it('トークンは既定で隠し、ボタンで表示を切り替えられる', async () => {
    const user = userEvent.setup()
    renderPanel()
    const input = screen.getByLabelText('Bearer トークン') as HTMLInputElement
    const toggle = screen.getByRole('button', { name: 'トークンを表示' })
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('off')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    await user.click(toggle)
    expect(input.type).toBe('text')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    await user.click(toggle)
    expect(input.type).toBe('password')
  })

  it('有効な Authorization ヘッダーがあるときは、トークンが使われない旨を示す', () => {
    setSettings({
      bearerToken: 'tok',
      headers: [newHeaderEntry({ name: 'authorization', value: 'Basic abc' })],
    })
    renderPanel()
    expect(screen.getByText(/このトークンは使われません/)).toBeTruthy()
  })

  it('Authorization ヘッダーが無効ならトークンは有効のまま', () => {
    setSettings({
      bearerToken: 'tok',
      headers: [newHeaderEntry({ name: 'Authorization', value: 'Basic abc', enabled: false })],
    })
    renderPanel()
    expect(screen.queryByText(/このトークンは使われません/)).toBeNull()
  })
})

describe('追加ヘッダー', () => {
  it('ヘッダーが無いときは空の表示を出す', () => {
    renderPanel()
    expect(screen.getByText('追加ヘッダーはありません')).toBeTruthy()
    expect(screen.queryByRole('list', { name: '追加ヘッダー' })).toBeNull()
  })

  it('「追加」で有効な行が増え、名前欄にフォーカスが移る', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole('button', { name: '追加' }))

    const { headers } = settingsStore.getSettings()
    expect(headers).toHaveLength(1)
    expect(headers[0]).toMatchObject({ name: '', value: '', enabled: true })
    const nameInput = screen.getByLabelText('ヘッダー 1 の名前')
    expect(document.activeElement).toBe(nameInput)
    expect(screen.queryByText('追加ヘッダーはありません')).toBeNull()
  })

  it('名前と値の編集が設定に反映される', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: '追加' }))

    await user.type(screen.getByLabelText('ヘッダー 1 の名前'), 'X-Test')
    await user.type(screen.getByLabelText('ヘッダー 1 の値'), 'abc 123')

    expect(settingsStore.getSettings().headers[0]).toMatchObject({
      name: 'X-Test',
      value: 'abc 123',
    })
  })

  it('スイッチで行を無効化・有効化できる', async () => {
    const user = userEvent.setup()
    setSettings({ headers: [newHeaderEntry({ name: 'X-A', value: '1' })] })
    renderPanel()
    const toggle = screen.getByRole('switch', { name: 'ヘッダー 1 を有効にする' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await user.click(toggle)
    expect(settingsStore.getSettings().headers[0]?.enabled).toBe(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await user.click(toggle)
    expect(settingsStore.getSettings().headers[0]?.enabled).toBe(true)
  })

  it('行を削除でき、他の行は残る', async () => {
    const user = userEvent.setup()
    setSettings({
      headers: [
        newHeaderEntry({ name: 'X-A', value: '1' }),
        newHeaderEntry({ name: 'X-B', value: '2' }),
        newHeaderEntry({ name: 'X-C', value: '3' }),
      ],
    })
    renderPanel()

    await user.click(screen.getByRole('button', { name: 'ヘッダー 2 を削除' }))

    expect(settingsStore.getSettings().headers.map((h) => h.name)).toEqual(['X-A', 'X-C'])
    const list = screen.getByRole('list', { name: '追加ヘッダー' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    // フォーカスは「追加」ボタンに戻る
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '追加' }))
  })

  it('最後の行を削除すると空の表示に戻る', async () => {
    const user = userEvent.setup()
    setSettings({ headers: [newHeaderEntry({ name: 'X-A', value: '1' })] })
    renderPanel()
    await user.click(screen.getByRole('button', { name: 'ヘッダー 1 を削除' }))
    expect(screen.getByText('追加ヘッダーはありません')).toBeTruthy()
  })

  it('ヘッダー名が RFC 7230 の token でなければエラーを出す（有効な行のみ）', async () => {
    const user = userEvent.setup()
    setSettings({ headers: [newHeaderEntry({ name: 'bad name', value: '1' })] })
    renderPanel()
    const nameInput = screen.getByLabelText('ヘッダー 1 の名前')
    expect(screen.getByRole('alert').textContent).toContain('ヘッダー名に使えない文字')
    expect(nameInput.getAttribute('aria-invalid')).toBe('true')

    // 無効な行は送信されないので、エラーも出さない
    await user.click(screen.getByRole('switch', { name: 'ヘッダー 1 を有効にする' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ヘッダー名の入力中に検証結果が切り替わる', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: '追加' }))
    // 未入力はエラーにしない
    expect(screen.queryByRole('alert')).toBeNull()

    await user.type(screen.getByLabelText('ヘッダー 1 の名前'), 'X Y')
    expect(screen.getByRole('alert')).toBeTruthy()

    await user.clear(screen.getByLabelText('ヘッダー 1 の名前'))
    await user.type(screen.getByLabelText('ヘッダー 1 の名前'), 'X-Y')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ヘッダー値に ISO-8859-1 外の文字があればエラーを出す', () => {
    setSettings({ headers: [newHeaderEntry({ name: 'X-A', value: 'こんにちは' })] })
    renderPanel()
    expect(screen.getByRole('alert').textContent).toContain('値に使えない文字')
    expect(screen.getByLabelText('ヘッダー 1 の値').getAttribute('aria-invalid')).toBe('true')
  })

  it('入力欄はオートコンプリートとスペルチェックを無効にする', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: '追加' }))
    for (const label of ['ヘッダー 1 の名前', 'ヘッダー 1 の値']) {
      const input = screen.getByLabelText(label) as HTMLInputElement
      expect(input.autocomplete).toBe('off')
      // jsdom は spellcheck プロパティを実装していないので属性で確認する
      expect(input.getAttribute('spellcheck')).toBe('false')
    }
  })

  describe('ブラウザが送らないヘッダーの警告', () => {
    const WARNING = /ブラウザの仕様でこのヘッダーは送信されません/

    it.each(['Cookie', 'Origin', 'Referer', 'Host'])(
      '%s の行には、非ブロッキングの警告を出す',
      (name) => {
        setSettings({ headers: [newHeaderEntry({ name, value: 'x' })] })
        renderPanel()

        const warning = screen.getByText(WARNING)
        expect(warning.textContent).toContain('「送信されなかったヘッダー」')
        // 警告はエラーではない: alert にせず、aria-invalid も付けず、入力も妨げない
        expect(screen.queryByRole('alert')).toBeNull()
        const nameInput = screen.getByLabelText('ヘッダー 1 の名前')
        expect(nameInput.getAttribute('aria-invalid')).toBe('false')
        expect(nameInput.getAttribute('aria-describedby')).toBe(warning.closest('p')?.id)
        expect(settingsStore.getSettings().headers[0]?.name).toBe(name)
      },
    )

    it('送れるヘッダーには警告を出さない', () => {
      setSettings({
        headers: [
          newHeaderEntry({ name: 'X-Api-Key', value: 'k' }),
          newHeaderEntry({ name: 'Authorization', value: 'Basic abc' }),
        ],
      })
      renderPanel()
      expect(screen.queryByText(WARNING)).toBeNull()
      expect(screen.getByLabelText('ヘッダー 1 の名前').getAttribute('aria-describedby')).toBeNull()
    })

    it('入力した名前に応じて警告が現れ、消える', async () => {
      const user = userEvent.setup()
      renderPanel()
      await user.click(screen.getByRole('button', { name: '追加' }))
      const nameInput = screen.getByLabelText('ヘッダー 1 の名前')

      await user.type(nameInput, 'Cookie')
      expect(screen.getByText(WARNING)).toBeTruthy()

      await user.clear(nameInput)
      await user.type(nameInput, 'X-Cookie-Id')
      expect(screen.queryByText(WARNING)).toBeNull()
    })

    it('無効にした行は送信されないので、警告も出さない', async () => {
      const user = userEvent.setup()
      setSettings({ headers: [newHeaderEntry({ name: 'Cookie', value: 'a=b' })] })
      renderPanel()
      expect(screen.getByText(WARNING)).toBeTruthy()

      await user.click(screen.getByRole('switch', { name: 'ヘッダー 1 を有効にする' }))
      expect(screen.queryByText(WARNING)).toBeNull()
    })

    it('メソッド上書きヘッダーは値が CONNECT / TRACE / TRACK のときだけ警告する', () => {
      setSettings({
        headers: [
          newHeaderEntry({ name: 'X-HTTP-Method-Override', value: 'TRACE' }),
          newHeaderEntry({ name: 'X-HTTP-Method-Override', value: 'PUT' }),
        ],
      })
      renderPanel()
      const rows = within(screen.getByRole('list', { name: '追加ヘッダー' })).getAllByRole(
        'listitem',
      )
      expect(within(rows[0]!).queryByText(WARNING)).not.toBeNull()
      expect(within(rows[1]!).queryByText(WARNING)).toBeNull()
    })

    it('エラーと警告は別々に出て、どちらも名前欄から参照される', () => {
      // 名前は有効（警告）、値は無効（エラー）
      setSettings({ headers: [newHeaderEntry({ name: 'Cookie', value: 'こんにちは' })] })
      renderPanel()

      const error = screen.getByRole('alert')
      expect(error.textContent).toContain('値に使えない文字')
      const warning = screen.getByText(WARNING).closest('p')
      expect(warning).not.toBeNull()
      expect(screen.getByLabelText('ヘッダー 1 の名前').getAttribute('aria-describedby')).toBe(
        `${error.id} ${warning?.id}`,
      )
    })

    it('名前がエラー（不正な文字）のときは、エラーだけを出して警告は重ねない', () => {
      setSettings({ headers: [newHeaderEntry({ name: 'sec-a b', value: 'x' })] })
      renderPanel()
      expect(screen.getByRole('alert').textContent).toContain('ヘッダー名に使えない文字')
      expect(screen.queryByText(WARNING)).toBeNull()
    })
  })

  it('認証系ヘッダーがマスク表示される旨のヒントを出す', () => {
    renderPanel()
    expect(screen.getByText(/インスペクタと cURL\s*ではマスクして表示されます/)).toBeTruthy()
  })
})

describe('リクエスト設定', () => {
  function visible() {
    return {
      credentials: screen.queryByText('credentials') !== null,
      extraBody: screen.queryByLabelText(/追加ボディ/) !== null,
      lastOnly: screen.queryByRole('switch', { name: '最後のメッセージのみ送信' }) !== null,
      autoSend:
        screen.queryByRole('switch', { name: 'ツール出力・承認が揃ったら自動再送' }) !== null,
      protocol: screen.queryByText('Completion のプロトコル') !== null,
    }
  }

  it('Chat (UI) ではすべての Chat 向け項目を表示する', () => {
    renderPanel()
    expect(visible()).toEqual({
      credentials: true,
      extraBody: true,
      lastOnly: true,
      autoSend: true,
      protocol: false,
    })
  })

  it('Chat (Text) には自動再送を出さない', () => {
    setMode('chat-text')
    renderPanel()
    expect(visible()).toEqual({
      credentials: true,
      extraBody: true,
      lastOnly: true,
      autoSend: false,
      protocol: false,
    })
  })

  it('Completion にはプロトコルを出し、Chat 向けの項目は出さない', () => {
    setMode('completion')
    renderPanel()
    expect(visible()).toEqual({
      credentials: true,
      extraBody: true,
      lastOnly: false,
      autoSend: false,
      protocol: true,
    })
  })

  it('Raw では追加ボディなどを出さず credentials だけ表示する', () => {
    setMode('raw')
    renderPanel()
    expect(visible()).toEqual({
      credentials: true,
      extraBody: false,
      lastOnly: false,
      autoSend: false,
      protocol: false,
    })
  })

  it('モードを切り替えると項目の出し分けが追従する', () => {
    renderPanel()
    expect(visible().autoSend).toBe(true)
    setMode('raw')
    expect(visible().extraBody).toBe(false)
    setMode('completion')
    expect(visible().protocol).toBe(true)
  })

  it('credentials を選択すると設定に反映され、説明が切り替わる', async () => {
    const user = userEvent.setup()
    renderPanel()
    expect(screen.getByRole('combobox', { name: 'credentials' }).textContent).toContain(
      'same-origin',
    )

    await user.click(screen.getByRole('combobox', { name: 'credentials' }))
    await user.click(await screen.findByRole('option', { name: /^include/ }))

    expect(settingsStore.getSettings().credentials).toBe('include')
    expect(screen.getByText(/クロスオリジンでも Cookie を送ります/)).toBeTruthy()
  })

  it('プロキシ利用中は credentials が omit 固定になる旨を示す', () => {
    renderPanel()
    expect(screen.queryByText(/omit で送信されます/)).toBeNull()
    setSettings({ useDevProxy: true })
    expect(screen.getByText(/omit で送信されます/)).toBeTruthy()
  })

  it('追加ボディの JSON 検証をインライン表示する', () => {
    renderPanel()
    const textarea = screen.getByLabelText(/追加ボディ/)
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.change(textarea, { target: { value: '{"temperature": ' } })
    expect(screen.getByRole('alert').textContent).toContain('正しいJSONではありません')
    expect(textarea.getAttribute('aria-invalid')).toBe('true')
    // 入力そのものは壊れた状態でも保持する（直している途中で消えない）
    expect(settingsStore.getSettings().extraBody).toBe('{"temperature": ')

    fireEvent.change(textarea, { target: { value: '[1, 2]' } })
    expect(screen.getByRole('alert').textContent).toContain('JSONオブジェクト')

    fireEvent.change(textarea, { target: { value: '{"temperature": 0.2}' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(textarea.getAttribute('aria-invalid')).toBe('false')
    expect(settingsStore.getSettings().extraBody).toBe('{"temperature": 0.2}')
  })

  it('追加ボディが空欄なら何もしない旨を示し、エラーにしない', () => {
    renderPanel()
    expect(screen.getByText(/空欄なら何もしません/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('スイッチで「最後のメッセージのみ送信」と「自動再送」を切り替える', async () => {
    const user = userEvent.setup()
    renderPanel()
    const lastOnly = screen.getByRole('switch', { name: '最後のメッセージのみ送信' })
    const autoSend = screen.getByRole('switch', { name: 'ツール出力・承認が揃ったら自動再送' })
    expect(lastOnly.getAttribute('aria-checked')).toBe('false')
    expect(autoSend.getAttribute('aria-checked')).toBe('true')

    await user.click(lastOnly)
    await user.click(autoSend)

    expect(settingsStore.getSettings().sendLastMessageOnly).toBe(true)
    expect(settingsStore.getSettings().autoSendAfterToolOutput).toBe(false)
  })

  it('Completion のプロトコルを選択すると設定に反映される', async () => {
    const user = userEvent.setup()
    setMode('completion')
    renderPanel()
    const select = screen.getByRole('combobox', { name: 'Completion のプロトコル' })
    expect(select.textContent).toContain('data')

    await user.click(select)
    await user.click(await screen.findByRole('option', { name: /^text/ }))

    expect(settingsStore.getSettings().completionProtocol).toBe('text')
    expect(screen.getByText(/プレーンテキストのストリームとして解釈します/)).toBeTruthy()
  })
})

describe('保存とリセット', () => {
  it('localStorage に保存される旨（トークンを除く）を示す', () => {
    renderPanel()
    expect(screen.getByText(/localStorage に保存されます（Bearer トークンを除く）/)).toBeTruthy()
  })

  it('リセットは確認ダイアログを挟み、キャンセルなら何も変えない', async () => {
    const user = userEvent.setup()
    setSettings({ bearerToken: 'tok', extraBody: '{"a":1}', mode: 'raw' })
    renderPanel()

    await user.click(screen.getByRole('button', { name: '設定をリセット' }))
    const dialog = await screen.findByRole('dialog', { name: '設定をリセットしますか？' })
    expect(within(dialog).getByText(/この操作は元に戻せません/)).toBeTruthy()
    // 押す前は何も変わっていない
    expect(settingsStore.getSettings().bearerToken).toBe('tok')

    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(settingsStore.getSettings().bearerToken).toBe('tok')
    expect(settingsStore.getSettings().mode).toBe('raw')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('確認すると設定が初期値に戻り、toast で通知する', async () => {
    const user = userEvent.setup()
    setSettings({
      bearerToken: 'tok',
      extraBody: '{"a":1}',
      useDevProxy: true,
      headers: [newHeaderEntry({ name: 'X-A', value: '1' })],
    })
    renderPanel()

    await user.click(screen.getByRole('button', { name: '設定をリセット' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'リセットする' }))

    const s = settingsStore.getSettings()
    expect(s.bearerToken).toBe('')
    expect(s.extraBody).toBe('')
    expect(s.useDevProxy).toBe(false)
    expect(s.headers).toEqual([])
    expect(toast.success).toHaveBeenCalledWith('設定をリセットしました')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sessionStorage.getItem(BEARER_TOKEN_STORAGE_KEY)).toBeNull()
  })
})

describe('レイアウト', () => {
  it('セクションごとに見出しを持つ', () => {
    renderPanel()
    for (const name of ['接続', '認証', '追加ヘッダー', 'リクエスト設定', '保存とリセット']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy()
    }
    expect(screen.getAllByRole('region').length).toBeGreaterThanOrEqual(5)
  })

  it('ルートは親の高さに収まり、内部でスクロールする', () => {
    const { container } = renderPanel()
    const root = container.firstElementChild
    expect(root?.className).toContain('h-full')
    expect(root?.className).toContain('min-h-0')
    expect(root?.className).toContain('overflow-y-auto')
  })
})
