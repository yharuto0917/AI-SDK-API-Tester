// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/App'
import { ThemeProvider } from '@/components/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PROXY_NAME } from '@/lib/proxy'
import { settingsStore } from '@/lib/settings-store'

// 他担当のビューは差し替える（マウント / アンマウントの回数だけ記録する）
const probe = vi.hoisted(() => ({ mounted: [] as string[], unmounted: [] as string[] }))

vi.mock('@/views/chat-view', async () => {
  const { createElement, useEffect } = await import('react')
  return {
    ChatView: ({ mode }: { mode: string }) => {
      useEffect(() => {
        probe.mounted.push(`chat:${mode}`)
        return () => {
          probe.unmounted.push(`chat:${mode}`)
        }
      }, [mode])
      return createElement('div', { 'data-testid': `view-${mode}` }, `chat ${mode}`)
    },
  }
})

vi.mock('@/views/completion-view', async () => {
  const { createElement, useEffect } = await import('react')
  return {
    CompletionView: () => {
      useEffect(() => {
        probe.mounted.push('completion')
        return () => {
          probe.unmounted.push('completion')
        }
      }, [])
      return createElement('div', { 'data-testid': 'view-completion' }, 'completion')
    },
  }
})

vi.mock('@/views/raw-view', async () => {
  const { createElement, useEffect } = await import('react')
  return {
    RawView: () => {
      useEffect(() => {
        probe.mounted.push('raw')
        return () => {
          probe.unmounted.push('raw')
        }
      }, [])
      return createElement('div', { 'data-testid': 'view-raw' }, 'raw')
    },
  }
})

vi.mock('@/components/inspector/inspector-panel', async () => {
  const { createElement, useEffect } = await import('react')
  return {
    InspectorPanel: () => {
      useEffect(() => {
        probe.mounted.push('inspector')
        return () => {
          probe.unmounted.push('inspector')
        }
      }, [])
      return createElement('div', { 'data-testid': 'inspector' }, 'inspector')
    },
  }
})

// --- 画面幅（lg 判定）を切り替えられる matchMedia ---------------------------------

const DESKTOP_QUERY = '(min-width: 1024px)'
let desktop = true
const desktopListeners = new Set<() => void>()
const originalMatchMedia = window.matchMedia

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === DESKTOP_QUERY ? desktop : false
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, listener: () => void) => {
      if (query === DESKTOP_QUERY) desktopListeners.add(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      desktopListeners.delete(listener)
    },
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function resizeTo(isDesktop: boolean): void {
  desktop = isDesktop
  act(() => {
    for (const listener of [...desktopListeners]) listener()
  })
}

function renderApp() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>,
  )
}

type User = ReturnType<typeof userEvent.setup>

/**
 * 実クリックの代わりに座標つきで押す。
 * react-resizable-panels は pointerdown を window で拾い、jsdom ではレイアウトが全部 0 なので、
 * 座標 (0, 0) の既定クリックは「セパレーターの上」と判定されて Radix まで届かない。
 */
async function press(user: User, element: HTMLElement): Promise<void> {
  await user.pointer({
    keys: '[MouseLeft]',
    target: element,
    coords: { clientX: 400, clientY: 300 },
  })
}

function getTab(name: RegExp): HTMLElement {
  return screen.getByRole('tab', { name })
}

function panelOf(testId: string): HTMLElement {
  const panel = screen.getByTestId(testId).closest<HTMLElement>('[role="tabpanel"]')
  if (panel === null) throw new Error(`tabpanel not found for ${testId}`)
  return panel
}

beforeEach(() => {
  probe.mounted.length = 0
  probe.unmounted.length = 0
  desktop = true
  desktopListeners.clear()
  installMatchMedia()
  settingsStore.reset()
  localStorage.clear()
  sessionStorage.clear()
  document.documentElement.className = ''
  // devプロキシの生存確認（/__proxy）が実通信にならないようにする
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ proxy: 'ai-sdk-tester' }), { status: 200 })),
  )
})

afterEach(() => {
  window.matchMedia = originalMatchMedia
  vi.unstubAllGlobals()
})

describe('App シェル（モード切替とビュー）', () => {
  it('最初は Chat (UI Message Stream) だけをマウントする', () => {
    renderApp()
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    expect(getTab(/UI Message Stream/).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('view-chat-ui')).toBeTruthy()
    // 未訪問のビューは遅延マウント
    expect(screen.queryByTestId('view-chat-text')).toBeNull()
    expect(screen.queryByTestId('view-completion')).toBeNull()
    expect(screen.queryByTestId('view-raw')).toBeNull()
  })

  it('保存済みの mode から開始したときは、そのビューだけをマウントする', () => {
    settingsStore.update({ mode: 'raw' })
    renderApp()
    expect(screen.getByTestId('view-raw')).toBeTruthy()
    expect(screen.queryByTestId('view-chat-ui')).toBeNull()
  })

  it('タブを切り替えると settings.mode が変わり、初回訪問でビューがマウントされる', async () => {
    const user = userEvent.setup()
    renderApp()

    await press(user, getTab(/Completion/))
    expect(settingsStore.getSettings().mode).toBe('completion')
    expect(getTab(/Completion/).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('view-completion')).toBeTruthy()

    await press(user, getTab(/Raw/))
    expect(settingsStore.getSettings().mode).toBe('raw')
    expect(screen.getByTestId('view-raw')).toBeTruthy()
  })

  it('訪問済みのビューはマウントしたまま隠し、戻っても再マウントしない', async () => {
    const user = userEvent.setup()
    renderApp()

    await press(user, getTab(/Completion/))
    await press(user, getTab(/Raw/))
    await press(user, getTab(/UI Message Stream/))

    // 3 つとも 1 回だけマウントされ、1 度もアンマウントされていない
    expect(probe.mounted.filter((m) => m === 'chat:chat-ui')).toHaveLength(1)
    expect(probe.mounted.filter((m) => m === 'completion')).toHaveLength(1)
    expect(probe.mounted.filter((m) => m === 'raw')).toHaveLength(1)
    expect(probe.unmounted).toEqual([])

    expect(panelOf('view-chat-ui').hidden).toBe(false)
    expect(panelOf('view-completion').hidden).toBe(true)
    expect(panelOf('view-raw').hidden).toBe(true)
  })

  it('Chat (UI) と Chat (Text) は別のインスタンスとしてマウントする', async () => {
    const user = userEvent.setup()
    renderApp()
    await press(user, getTab(/Text Stream/))

    expect(screen.getByTestId('view-chat-ui')).toBeTruthy()
    expect(screen.getByTestId('view-chat-text')).toBeTruthy()
    expect(probe.mounted).toContain('chat:chat-ui')
    expect(probe.mounted).toContain('chat:chat-text')
    expect(panelOf('view-chat-ui').hidden).toBe(true)
    expect(panelOf('view-chat-text').hidden).toBe(false)
  })

  it('タブと tabpanel を aria で対応づける', async () => {
    const user = userEvent.setup()
    renderApp()
    await press(user, getTab(/Completion/))

    const panel = panelOf('view-completion')
    const tab = getTab(/Completion/)
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id)
    expect(tab.getAttribute('aria-controls')).toBe(panel.id)
    // 非表示のパネルはアクセシビリティツリーから外れる
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  })
})

describe('App シェル（レイアウト）', () => {
  it('lg 以上では設定とインスペクタが左右のペインに出る', () => {
    renderApp()
    const settings = screen.getByRole('complementary', { name: '設定' })
    expect(within(settings).getByLabelText(/エンドポイント/)).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'インスペクタ' })).toBeTruthy()
    expect(screen.getByTestId('inspector')).toBeTruthy()
  })

  it('モードを切り替えると設定パネルの対象モードも切り替わる', async () => {
    const user = userEvent.setup()
    renderApp()
    const settings = screen.getByRole('complementary', { name: '設定' })
    expect(
      within(settings)
        .getByLabelText(/エンドポイント/)
        .getAttribute('value'),
    ).toBe('http://localhost:28787/api/chat')

    await press(user, getTab(/Completion/))
    expect(
      within(settings)
        .getByLabelText(/エンドポイント/)
        .getAttribute('value'),
    ).toBe('http://localhost:28787/api/completion')
  })

  it('ヘッダーのボタンで左右のペインを開閉でき、中央のビューは再マウントされない', async () => {
    const user = userEvent.setup()
    renderApp()
    const settingsToggle = screen.getByRole('button', { name: '設定パネル' })
    const inspectorToggle = screen.getByRole('button', { name: 'インスペクタ' })
    expect(settingsToggle.getAttribute('aria-pressed')).toBe('true')

    await user.click(settingsToggle)
    expect(screen.queryByRole('complementary', { name: '設定' })).toBeNull()
    expect(settingsToggle.getAttribute('aria-pressed')).toBe('false')

    await user.click(inspectorToggle)
    expect(screen.queryByTestId('inspector')).toBeNull()

    await user.click(settingsToggle)
    await user.click(inspectorToggle)
    expect(screen.getByRole('complementary', { name: '設定' })).toBeTruthy()
    expect(screen.getByTestId('inspector')).toBeTruthy()

    expect(probe.mounted.filter((m) => m === 'chat:chat-ui')).toHaveLength(1)
    expect(probe.unmounted).not.toContain('chat:chat-ui')
  })

  it('lg 未満ではペインを出さず、ボタンで設定をドロワーに開く', async () => {
    desktop = false
    const user = userEvent.setup()
    renderApp()
    expect(screen.queryByRole('complementary', { name: '設定' })).toBeNull()
    expect(screen.queryByTestId('inspector')).toBeNull()
    expect(screen.getByTestId('view-chat-ui')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '設定パネル' }))
    const dialog = await screen.findByRole('dialog', { name: '設定' })
    expect(within(dialog).getByLabelText(/エンドポイント/)).toBeTruthy()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('lg 未満でドロワーを開いても入力欄に自動フォーカスせず、フォーカスはドロワー自体に置く', async () => {
    desktop = false
    const user = userEvent.setup()
    renderApp()

    await user.click(screen.getByRole('button', { name: '設定パネル' }))
    const dialog = await screen.findByRole('dialog', { name: '設定' })
    // スマホでは入力欄にフォーカスが当たるとソフトウェアキーボードが勝手に出てしまう
    expect(document.activeElement).toBe(dialog)
    expect(within(dialog).getByLabelText(/エンドポイント/)).not.toBe(document.activeElement)

    // フォーカストラップは維持される（Tab / Shift+Tab でドロワーの外へ出ない）
    await user.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(dialog)
    await user.tab({ shift: true })
    await user.tab({ shift: true })
    expect(dialog.contains(document.activeElement)).toBe(true)

    // Escape でも閉じられる
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('インスペクタのドロワーでも先頭の操作要素に自動フォーカスしない', async () => {
    desktop = false
    const user = userEvent.setup()
    renderApp()

    await user.click(screen.getByRole('button', { name: 'インスペクタ' }))
    const dialog = await screen.findByRole('dialog', { name: 'インスペクタ' })
    expect(document.activeElement).toBe(dialog)
  })

  it('ドロワーを Escape で閉じると、フォーカスは開いたヘッダーのボタンに戻る', async () => {
    desktop = false
    const user = userEvent.setup()
    renderApp()
    const opener = screen.getByRole('button', { name: '設定パネル' })

    await user.click(opener)
    await screen.findByRole('dialog', { name: '設定' })
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // body に落ちると、キーボード操作が先頭からやり直しになる
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('ドロワーを閉じるボタンで閉じても、フォーカスは開いたボタンに戻る', async () => {
    desktop = false
    const user = userEvent.setup()
    renderApp()
    const opener = screen.getByRole('button', { name: 'インスペクタ' })

    await user.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'インスペクタ' })
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('クリックでボタンにフォーカスが移らない環境（Safari・タッチ）でも、開いたボタンに戻す', async () => {
    desktop = false
    const user = userEvent.setup()
    renderApp()
    const opener = screen.getByRole('button', { name: '設定パネル' })

    // fireEvent.click は mousedown を伴わないので、ボタンにフォーカスが移らない状態を再現できる
    fireEvent.click(opener)
    await screen.findByRole('dialog', { name: '設定' })
    expect(document.activeElement).not.toBe(opener)
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('lg 未満ではインスペクタをドロワーに開く', async () => {
    desktop = false
    const user = userEvent.setup()
    renderApp()

    await user.click(screen.getByRole('button', { name: 'インスペクタ' }))
    const dialog = await screen.findByRole('dialog', { name: 'インスペクタ' })
    expect(within(dialog).getByTestId('inspector')).toBeTruthy()
  })

  it('画面幅が lg をまたいでも中央のビューは再マウントされない', async () => {
    const user = userEvent.setup()
    renderApp()
    await press(user, getTab(/Raw/))
    expect(probe.mounted.filter((m) => m === 'raw')).toHaveLength(1)

    resizeTo(false)
    expect(screen.queryByRole('complementary', { name: '設定' })).toBeNull()
    expect(screen.getByTestId('view-raw')).toBeTruthy()

    resizeTo(true)
    expect(screen.getByRole('complementary', { name: '設定' })).toBeTruthy()

    expect(probe.mounted.filter((m) => m === 'raw')).toHaveLength(1)
    expect(probe.unmounted).not.toContain('raw')
    expect(probe.unmounted).not.toContain('chat:chat-ui')
  })

  it('lg 未満で開いたドロワーは、lg 以上に広げると閉じる', async () => {
    desktop = false
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: '設定パネル' }))
    await screen.findByRole('dialog', { name: '設定' })

    resizeTo(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('complementary', { name: '設定' })).toBeTruthy()

    // 再び狭めても、閉じたはずのドロワーが勝手に開き直さない
    resizeTo(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('App シェル（ヘッダー）', () => {
  it('devプロキシの状態をバッジで表示する', async () => {
    renderApp()
    const badge = await screen.findByRole('button', { name: `${PROXY_NAME}: 利用可能` })
    expect(badge.getAttribute('data-status')).toBe('available')
  })

  it('テーマ切替でダークモードの class が html に付く', async () => {
    const user = userEvent.setup()
    renderApp()
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    await press(user, screen.getByRole('button', { name: 'テーマを切り替え' }))
    await press(user, await screen.findByRole('menuitemradio', { name: 'ダーク' }))
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true))
    expect(localStorage.getItem('theme')).toBe('dark')

    await press(user, screen.getByRole('button', { name: 'テーマを切り替え' }))
    await press(user, await screen.findByRole('menuitemradio', { name: 'ライト' }))
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(false))
    expect(localStorage.getItem('theme')).toBe('light')
  })

  it('テーマを保存していないときは「システム」にチェックが付く', async () => {
    const user = userEvent.setup()
    renderApp()

    await press(user, screen.getByRole('button', { name: 'テーマを切り替え' }))
    const system = await screen.findByRole('menuitemradio', { name: 'システム' })
    expect(system.getAttribute('aria-checked')).toBe('true')
  })

  it('テーマ切替メニューは現在のテーマにチェックが付く', async () => {
    const user = userEvent.setup()
    localStorage.setItem('theme', 'light')
    renderApp()

    await press(user, screen.getByRole('button', { name: 'テーマを切り替え' }))
    const light = await screen.findByRole('menuitemradio', { name: 'ライト' })
    expect(light.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'ダーク' }).getAttribute('aria-checked')).toBe(
      'false',
    )
  })
})
