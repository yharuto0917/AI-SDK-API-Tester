// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DiagnosticsTab } from '@/components/inspector/diagnostics-tab'
import { diagnostic, makeEntry } from '@/components/inspector/test-fixtures'

describe('DiagnosticsTab', () => {
  it('診断を error → warn → info → ok の順に並べる', () => {
    const entry = makeEntry({
      diagnostics: [
        diagnostic('summary', 'ok', '概要'),
        diagnostic('i1', 'info', '情報1'),
        diagnostic('w1', 'warn', '警告1'),
        diagnostic('e1', 'error', 'エラー1'),
        diagnostic('w2', 'warn', '警告2'),
      ],
    })
    const { container } = render(<DiagnosticsTab revealSecrets={false} entry={entry} />)
    const levels = [...container.querySelectorAll('[data-level]')].map((el) =>
      el.getAttribute('data-level'),
    )
    expect(levels).toEqual(['error', 'warn', 'warn', 'info', 'ok'])
    const titles = [...container.querySelectorAll('[data-slot=alert-title]')].map(
      (el) => el.textContent,
    )
    expect(titles).toEqual(['エラー1', '警告1', '警告2', '情報1', '概要'])
  })

  it('detail は改行を残して表示する（whitespace-pre-line）', () => {
    const entry = makeEntry({
      diagnostics: [diagnostic('e1', 'error', '接続できません', '原因 A\n原因 B\n対処: 再起動')],
    })
    render(<DiagnosticsTab revealSecrets={false} entry={entry} />)
    const alert = screen.getByRole('group', { name: 'エラー: 接続できません' })
    const detail = within(alert).getByText(/原因 A/)
    expect(detail.className).toContain('whitespace-pre-line')
    expect(detail.textContent).toBe('原因 A\n原因 B\n対処: 再起動')
  })

  it('level ごとに Alert の見た目が変わる（error は destructive、それ以外は色付き）', () => {
    const entry = makeEntry({
      diagnostics: [
        diagnostic('e', 'error', 'E'),
        diagnostic('w', 'warn', 'W'),
        diagnostic('i', 'info', 'I'),
        diagnostic('o', 'ok', 'O'),
      ],
    })
    const { container } = render(<DiagnosticsTab revealSecrets={false} entry={entry} />)
    const byLevel = (level: string) =>
      container.querySelector(`[data-level=${level}]`)?.className ?? ''
    expect(byLevel('error')).toContain('text-destructive')
    expect(byLevel('warn')).toContain('amber')
    expect(byLevel('warn')).toContain('dark:')
    expect(byLevel('info')).toContain('sky')
    expect(byLevel('ok')).toContain('emerald')
  })

  it('実行中で診断がまだ無いときは「実行中…」を出す', () => {
    render(
      <DiagnosticsTab
        revealSecrets={false}
        entry={makeEntry({ state: 'pending', diagnostics: [] })}
      />,
    )
    expect(screen.getByText('実行中…')).not.toBeNull()
    expect(screen.queryByText('診断項目はありません')).toBeNull()
  })

  it('ストリーミング中は診断を出しつつ「実行中…」も示す', () => {
    const entry = makeEntry({
      state: 'streaming',
      diagnostics: [diagnostic('http-status', 'ok', 'HTTP 200')],
    })
    render(<DiagnosticsTab revealSecrets={false} entry={entry} />)
    expect(screen.getByText('実行中…')).not.toBeNull()
    expect(screen.getByText('HTTP 200')).not.toBeNull()
  })

  it('完了していて診断も無いときは、その旨を出す', () => {
    render(
      <DiagnosticsTab
        revealSecrets={false}
        entry={makeEntry({ state: 'done', diagnostics: [] })}
      />,
    )
    expect(screen.queryByText('実行中…')).toBeNull()
    expect(screen.getByText('診断項目はありません')).not.toBeNull()
  })

  it('entry.error の name / message / hint を診断より上に目立たせて出す', () => {
    const entry = makeEntry({
      state: 'error',
      error: {
        name: 'TypeError',
        message: 'Failed to fetch',
        hint: 'CORS か、サーバーが起動しているか確認してください',
      },
      diagnostics: [diagnostic('network-error', 'error', 'ネットワークエラー')],
    })
    const { container } = render(<DiagnosticsTab revealSecrets={false} entry={entry} />)
    const errorAlert = screen.getByRole('group', { name: '通信エラー: TypeError' })
    expect(within(errorAlert).getByText('TypeError')).not.toBeNull()
    expect(within(errorAlert).getByText('Failed to fetch')).not.toBeNull()
    expect(within(errorAlert).getByText(/CORS か、サーバーが/)).not.toBeNull()
    expect(within(errorAlert).getByText(/ヒント/)).not.toBeNull()

    const alerts = [...container.querySelectorAll('[data-slot=alert]')]
    expect(alerts[0]).toBe(errorAlert)
    expect(alerts).toHaveLength(2)
  })

  it('hint が無い error は hint 行を出さない', () => {
    const entry = makeEntry({
      state: 'error',
      error: { name: 'AbortError', message: 'The operation was aborted' },
    })
    render(<DiagnosticsTab revealSecrets={false} entry={entry} />)
    expect(screen.getByText('The operation was aborted')).not.toBeNull()
    expect(screen.queryByText(/ヒント/)).toBeNull()
  })

  describe('秘匿情報', () => {
    const URL_KEY = 'sk-live-SECRETSECRET'
    const leaky = () =>
      makeEntry({
        state: 'error',
        targetUrl: `https://api.example.com/v1/chat?api_key=${URL_KEY}`,
        error: {
          name: 'TypeError',
          message: `Failed to fetch https://api.example.com/v1/chat?api_key=${URL_KEY}`,
          hint: `キー ${URL_KEY} を確認してください`,
        },
        diagnostics: [
          diagnostic(
            'network-error',
            'error',
            `接続できません: ${URL_KEY}`,
            `転送先 https://api.example.com/v1/chat?api_key=${URL_KEY} を確認してください`,
          ),
        ],
      })

    it('エラー文言・診断の見出しと詳細に引用された URL・秘匿値を伏せる', () => {
      const { container } = render(<DiagnosticsTab revealSecrets={false} entry={leaky()} />)
      expect(container.textContent).not.toContain(URL_KEY)
      expect(container.textContent).toContain(
        'Failed to fetch https://api.example.com/v1/chat?api_key=••••',
      )
      expect(container.textContent).toContain('を確認してください')
      // aria-label（見出し）にも出さない
      expect(screen.getByRole('group', { name: /^エラー: 接続できません: ••••/ })).not.toBeNull()
    })

    it('秘匿情報を表示する設定ではそのまま出す', () => {
      const { container } = render(<DiagnosticsTab revealSecrets entry={leaky()} />)
      expect(container.textContent).toContain(URL_KEY)
    })

    it('秘匿値を含まない診断は変えない', () => {
      const entry = makeEntry({ diagnostics: [diagnostic('a', 'warn', '警告', '詳細 text')] })
      render(<DiagnosticsTab revealSecrets={false} entry={entry} />)
      expect(screen.getByText('警告')).not.toBeNull()
      expect(screen.getByText('詳細 text')).not.toBeNull()
    })
  })
})
