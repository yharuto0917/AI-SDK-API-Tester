// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTheme } from '@/components/theme-context'
import { ThemeProvider } from '@/components/theme-provider'
import indexHtml from '../../index.html?raw'

const DARK_QUERY = '(prefers-color-scheme: dark)'
let systemDark = false
const darkListeners = new Set<() => void>()
const originalMatchMedia = window.matchMedia

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === DARK_QUERY ? systemDark : false
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, listener: () => void) => {
      if (query === DARK_QUERY) darkListeners.add(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      darkListeners.delete(listener)
    },
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

/** OS のダーク設定を切り替え、change イベントを流す。 */
function setSystemDark(value: boolean): void {
  systemDark = value
  act(() => {
    for (const listener of [...darkListeners]) listener()
  })
}

function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

function Probe() {
  const { theme, setTheme } = useTheme()
  return (
    <>
      <output data-testid="theme">{theme}</output>
      <button onClick={() => setTheme('system')}>system</button>
      <button onClick={() => setTheme('light')}>light</button>
      <button onClick={() => setTheme('dark')}>dark</button>
    </>
  )
}

function renderProvider() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  )
}

beforeEach(() => {
  systemDark = false
  darkListeners.clear()
  installMatchMedia()
  localStorage.clear()
  document.documentElement.className = ''
})

afterEach(() => {
  window.matchMedia = originalMatchMedia
  vi.restoreAllMocks()
})

describe('ThemeProvider', () => {
  // React は同じ警告を 1 プロセスで 1 回しか出さないので、このテストは必ずファイルの先頭に置く
  it('React 19 で script タグ由来のコンソールエラーを出さない', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderProvider()
    expect(errors).not.toHaveBeenCalled()
  })

  it('保存がなければ system で、OS がダークなら .dark を付ける', () => {
    systemDark = true
    renderProvider()
    expect(screen.getByTestId('theme').textContent).toBe('system')
    expect(isDark()).toBe(true)
  })

  it('保存済みのテーマで始まる', () => {
    localStorage.setItem('theme', 'dark')
    renderProvider()
    expect(screen.getByTestId('theme').textContent).toBe('dark')
    expect(isDark()).toBe(true)
  })

  it('保存値が不正なら system として扱う', () => {
    localStorage.setItem('theme', 'sepia')
    systemDark = true
    renderProvider()
    expect(screen.getByTestId('theme').textContent).toBe('system')
    expect(isDark()).toBe(true)
  })

  it('system のあいだは OS 設定の変更に追従する', () => {
    renderProvider()
    expect(isDark()).toBe(false)

    setSystemDark(true)
    expect(isDark()).toBe(true)
    setSystemDark(false)
    expect(isDark()).toBe(false)
  })

  it('明示的に選んだテーマは OS 設定の変更で変わらない', async () => {
    const user = userEvent.setup()
    renderProvider()
    await user.click(screen.getByRole('button', { name: 'light' }))
    setSystemDark(true)
    expect(isDark()).toBe(false)

    await user.click(screen.getByRole('button', { name: 'dark' }))
    setSystemDark(false)
    expect(isDark()).toBe(true)
  })

  it('テーマを選ぶと保存され、system に戻すと OS 設定への追従を再開する', async () => {
    const user = userEvent.setup()
    renderProvider()

    await user.click(screen.getByRole('button', { name: 'dark' }))
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(isDark()).toBe(true)

    await user.click(screen.getByRole('button', { name: 'system' }))
    expect(localStorage.getItem('theme')).toBe('system')
    expect(isDark()).toBe(false)
    setSystemDark(true)
    expect(isDark()).toBe(true)
  })

  it('アンマウントすると OS 設定の監視を外す', () => {
    const { unmount } = renderProvider()
    expect(darkListeners.size).toBe(1)
    unmount()
    expect(darkListeners.size).toBe(0)
  })

  it('localStorage が使えなくても切替できる', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const user = userEvent.setup()
    renderProvider()
    expect(screen.getByTestId('theme').textContent).toBe('system')

    await user.click(screen.getByRole('button', { name: 'dark' }))
    expect(screen.getByTestId('theme').textContent).toBe('dark')
    expect(isDark()).toBe(true)
  })

  it('切替の一瞬だけ transition を止め、すぐ元に戻す', async () => {
    const append = vi.spyOn(document.head, 'appendChild')
    const user = userEvent.setup()
    renderProvider()

    await user.click(screen.getByRole('button', { name: 'dark' }))
    const guard = append.mock.calls
      .map(([node]) => node)
      .find((node) => node instanceof HTMLStyleElement && node.textContent.includes('transition'))
    expect(guard).toBeDefined()
    await waitFor(() => expect(guard?.isConnected).toBe(false))
  })

  it('Provider の外で useTheme を呼んでも例外にならず system を返す', () => {
    render(<Probe />)
    expect(screen.getByTestId('theme').textContent).toBe('system')
  })
})

describe('index.html のちらつき防止スクリプト', () => {
  const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1]

  it('React より先に動く静的な script として存在する', () => {
    expect(inlineScript).toBeDefined()
  })

  // スクリプトと Provider の判定がずれると、起動の瞬間にテーマが切り替わってちらつく
  it.each([
    [null, false, false],
    [null, true, true],
    ['system', true, true],
    ['system', false, false],
    ['light', true, false],
    ['dark', false, true],
    ['sepia', true, true],
    ['sepia', false, false],
  ] as const)(
    '保存=%s / OS ダーク=%s のとき ThemeProvider と同じ結果になる',
    (stored, osDark, expected) => {
      if (stored !== null) localStorage.setItem('theme', stored)
      systemDark = osDark

      new Function(inlineScript ?? '')()
      expect(isDark()).toBe(expected)

      document.documentElement.className = ''
      renderProvider()
      expect(isDark()).toBe(expected)
    },
  )
})
