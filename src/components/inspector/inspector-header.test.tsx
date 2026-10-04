// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { InspectorHeader } from '@/components/inspector/inspector-header'

function setup(overrides: Partial<Parameters<typeof InspectorHeader>[0]> = {}) {
  const props = {
    count: 3,
    canExport: true,
    revealSecrets: false,
    onRevealSecretsChange: vi.fn(),
    onClear: vi.fn(),
    onExport: vi.fn(),
    ...overrides,
  }
  render(<InspectorHeader {...props} />)
  return props
}

describe('InspectorHeader', () => {
  it('見出しと件数を出す', () => {
    setup({ count: 12 })
    expect(screen.getByRole('heading', { name: 'インスペクタ' })).not.toBeNull()
    expect(screen.getByLabelText('通信 12 件').textContent).toBe('12')
  })

  it('スイッチを押すと、反転した値で onRevealSecretsChange が呼ばれる', async () => {
    const user = userEvent.setup()
    const props = setup({ revealSecrets: false })
    const toggle = screen.getByRole('switch', { name: '秘匿情報を表示' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await user.click(toggle)
    expect(props.onRevealSecretsChange).toHaveBeenCalledWith(true)
  })

  it('ラベルをクリックしてもスイッチが切り替わる', async () => {
    const user = userEvent.setup()
    const props = setup({ revealSecrets: true })
    await user.click(screen.getByText('秘匿情報を表示'))
    expect(props.onRevealSecretsChange).toHaveBeenCalledWith(false)
  })

  it('クリア・保存ボタンが呼び出しを行う', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByRole('button', { name: 'クリア' }))
    await user.click(screen.getByRole('button', { name: 'ログをJSONで保存' }))
    expect(props.onClear).toHaveBeenCalledTimes(1)
    expect(props.onExport).toHaveBeenCalledTimes(1)
  })

  it('件数が 0 ならクリアを、選択が無ければ保存を無効にする', async () => {
    const user = userEvent.setup()
    const props = setup({ count: 0, canExport: false })
    const clear = screen.getByRole('button', { name: 'クリア' })
    const exportButton = screen.getByRole('button', { name: 'ログをJSONで保存' })
    expect(clear.hasAttribute('disabled')).toBe(true)
    expect(exportButton.hasAttribute('disabled')).toBe(true)
    await user.click(clear)
    await user.click(exportButton)
    expect(props.onClear).not.toHaveBeenCalled()
    expect(props.onExport).not.toHaveBeenCalled()
  })
})
