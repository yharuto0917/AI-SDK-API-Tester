// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProxyStatusBadge } from '@/components/proxy-status-badge'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PROXY_NAME, PROXY_TOGGLE_LABEL, checkProxyAvailable } from '@/lib/proxy'
import { settingsStore } from '@/lib/settings-store'

// 生存確認だけ差し替える。PROXY_NAME などの定数は実物を使う（画面の文言がここから組み立てられるため）
vi.mock('@/lib/proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/proxy')>()),
  checkProxyAvailable: vi.fn(),
}))

const mockedCheck = vi.mocked(checkProxyAvailable)

function renderBadge() {
  return render(
    <TooltipProvider>
      <ProxyStatusBadge />
    </TooltipProvider>,
  )
}

beforeEach(() => {
  mockedCheck.mockReset()
  settingsStore.reset()
  localStorage.clear()
  sessionStorage.clear()
})

describe('ProxyStatusBadge', () => {
  it('確認中 → 利用可能 と遷移する', async () => {
    let resolve: (value: boolean) => void = () => {}
    mockedCheck.mockReturnValue(
      new Promise<boolean>((r) => {
        resolve = r
      }),
    )
    renderBadge()
    expect(screen.getByRole('button', { name: `${PROXY_NAME}: 確認中` }).dataset.status).toBe(
      'checking',
    )

    await act(async () => {
      resolve(true)
    })
    expect(screen.getByRole('button', { name: `${PROXY_NAME}: 利用可能` }).dataset.status).toBe(
      'available',
    )
  })

  it('利用不可のとき、その状態を表示する', async () => {
    mockedCheck.mockResolvedValue(false)
    renderBadge()
    const badge = await screen.findByRole('button', { name: `${PROXY_NAME}: 利用不可` })
    expect(badge.dataset.status).toBe('unavailable')
  })

  it('クリックで再確認する', async () => {
    const user = userEvent.setup()
    mockedCheck.mockResolvedValue(false)
    renderBadge()
    await screen.findByRole('button', { name: `${PROXY_NAME}: 利用不可` })
    expect(mockedCheck).toHaveBeenCalledTimes(1)

    mockedCheck.mockResolvedValue(true)
    await user.click(screen.getByRole('button', { name: `${PROXY_NAME}: 利用不可` }))
    await screen.findByRole('button', { name: `${PROXY_NAME}: 利用可能` })
    expect(mockedCheck).toHaveBeenCalledTimes(2)
  })

  it('キーボードフォーカスで、利用不可の理由（vite dev / vite preview のみ有効）を説明する', async () => {
    const user = userEvent.setup()
    mockedCheck.mockResolvedValue(false)
    renderBadge()
    await screen.findByRole('button', { name: `${PROXY_NAME}: 利用不可` })

    await user.tab()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain('vite dev / vite preview')
    expect(tooltip.textContent).toContain('クリックで再確認')
  })

  it('プロキシを ON にしているときは、利用不可の説明に失敗する旨を含める', async () => {
    const user = userEvent.setup()
    mockedCheck.mockResolvedValue(false)
    settingsStore.update({ useDevProxy: true })
    renderBadge()
    await screen.findByRole('button', { name: `${PROXY_NAME}: 利用不可` })

    await user.tab()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain('リクエストは失敗します')
  })

  it('利用可能のとき、CORS 回避に使う旨を説明する', async () => {
    const user = userEvent.setup()
    mockedCheck.mockResolvedValue(true)
    renderBadge()
    await waitFor(() => expect(screen.getByRole('button').dataset.status).toBe('available'))

    await user.tab()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain('CORS')
  })

  it('ツールチップの説明は PROXY_NAME に統一し、スイッチは PROXY_TOGGLE_LABEL で案内する', async () => {
    const user = userEvent.setup()
    mockedCheck.mockResolvedValue(true)
    renderBadge()
    await waitFor(() => expect(screen.getByRole('button').dataset.status).toBe('available'))

    await user.tab()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain(`${PROXY_NAME}が応答しています`)
    expect(tooltip.textContent).toContain(`「${PROXY_TOGGLE_LABEL}」`)
    expect(tooltip.textContent).not.toMatch(/開発プロキシ|dev プロキシ/)
  })

  it.each([
    { enabled: false, status: false },
    { enabled: true, status: false },
    { enabled: true, status: true },
  ])('どの状態の説明にも揺れた表記を使わない（ON=$enabled, 応答=$status）', async (c) => {
    const user = userEvent.setup()
    mockedCheck.mockResolvedValue(c.status)
    settingsStore.update({ useDevProxy: c.enabled })
    renderBadge()
    await waitFor(() => expect(screen.getByRole('button').dataset.status).not.toBe('checking'))

    await user.tab()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain(PROXY_NAME)
    expect(tooltip.textContent).not.toMatch(/開発プロキシ|dev プロキシ/)
  })
})
