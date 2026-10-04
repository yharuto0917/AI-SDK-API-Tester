import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { THEME_STORAGE_KEY, ThemeContext, isTheme } from '@/components/theme-context'
import type { Theme } from '@/components/theme-context'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(stored) ? stored : 'system'
  } catch {
    // localStorage が使えない環境（プライベートモードなど）でも OS 設定で動かす
    return 'system'
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 保存できなくても、このセッション中の切替は有効なままにする
  }
}

/** .dark クラスを切り替える。切替の一瞬だけ transition を止め、要素ごとに色の変わる速さがずれるのを防ぐ。 */
function applyDarkClass(dark: boolean): void {
  const root = document.documentElement
  // index.html のスクリプトで反映済みなら何もしない（初回マウントで style を差し込まない）
  if (root.classList.contains('dark') === dark) return

  const style = document.createElement('style')
  style.textContent = '*,*::before,*::after{transition:none!important}'
  document.head.appendChild(style)
  root.classList.toggle('dark', dark)
  // 強制リフロー: style を外す前に切替後の見た目を確定させ、transition を発火させない
  void window.getComputedStyle(document.body).opacity
  setTimeout(() => style.remove(), 1)
}

/**
 * ダークモードの切替を担う軽量プロバイダ。
 * next-themes はテーマ初期化用の script タグを React の中で描画するため、React 19 でコンソールエラーになる。
 * 初期化は index.html の静的スクリプトに任せ、ここは React 起動後の切替と OS 設定への追従だけを行う。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    if (theme !== 'system') {
      applyDarkClass(theme === 'dark')
      return undefined
    }
    const query = window.matchMedia(DARK_QUERY)
    const sync = () => applyDarkClass(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    writeStoredTheme(next)
    setThemeState(next)
  }, [])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])

  return <ThemeContext value={value}>{children}</ThemeContext>
}
