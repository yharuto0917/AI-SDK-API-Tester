// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HttpStatusBadge, LogStateIcon, LogStateLabel } from '@/components/inspector/status-badge'
import type { LogState } from '@/types'

describe('HttpStatusBadge', () => {
  const classOf = (status: number | undefined) => {
    const { container, unmount } = render(<HttpStatusBadge status={status} />)
    const className = container.firstElementChild?.className ?? ''
    unmount()
    return className
  }

  it('2xx は緑、3xx は青、4xx・5xx は赤（いずれもダーク用のクラス付き）', () => {
    expect(classOf(200)).toContain('emerald')
    expect(classOf(200)).toContain('dark:')
    expect(classOf(302)).toContain('sky')
    expect(classOf(302)).toContain('dark:')
    expect(classOf(404)).toContain('text-destructive')
    expect(classOf(503)).toContain('text-destructive')
  })

  it('未受信は — で、色を付けない', () => {
    render(<HttpStatusBadge status={undefined} />)
    const badge = screen.getByLabelText('ステータス 未受信')
    expect(badge.textContent).toBe('—')
    expect(badge.className).toContain('text-muted-foreground')
  })

  it('statusText を渡すと「200 OK」の形で出す', () => {
    render(<HttpStatusBadge status={200} statusText="OK" />)
    expect(screen.getByText('200 OK')).not.toBeNull()
    expect(screen.getByLabelText('ステータス 200 OK')).not.toBeNull()
  })

  it('statusText が空文字ならコードだけ出す', () => {
    render(<HttpStatusBadge status={200} statusText="" />)
    expect(screen.getByText('200')).not.toBeNull()
  })
})

describe('LogStateIcon', () => {
  const labels: Record<LogState, string> = {
    pending: '送信中',
    streaming: '受信中',
    done: '完了',
    error: 'エラー',
    aborted: '中断',
  }

  it.each(Object.entries(labels))('%s は「%s」のラベル付きの画像として出す', (state, label) => {
    render(<LogStateIcon state={state as LogState} />)
    expect(screen.getByRole('img', { name: label })).not.toBeNull()
  })

  it('decorative のときは読み上げ対象にしない', () => {
    const { container } = render(<LogStateIcon state="done" decorative />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('pending / streaming はスピナー（回転）、それ以外は回転しない', () => {
    const spin = (state: LogState) => {
      const { container, unmount } = render(<LogStateIcon state={state} />)
      const className = container.querySelector('svg')?.getAttribute('class') ?? ''
      unmount()
      return className.includes('animate-spin')
    }
    expect(spin('pending')).toBe(true)
    expect(spin('streaming')).toBe(true)
    expect(spin('done')).toBe(false)
    expect(spin('error')).toBe(false)
    expect(spin('aborted')).toBe(false)
  })
})

describe('LogStateLabel', () => {
  it('アイコン + 状態名を出し、状態名は 1 回だけ読み上げられる', () => {
    render(<LogStateLabel state="streaming" />)
    expect(screen.getByText('受信中')).not.toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })
})
