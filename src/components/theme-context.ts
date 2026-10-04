import { createContext, useContext } from 'react'

export const THEMES = ['system', 'light', 'dark'] as const

/** system は OS の設定（prefers-color-scheme）に追従する。 */
export type Theme = (typeof THEMES)[number]

export function isTheme(value: unknown): value is Theme {
  return (THEMES as readonly unknown[]).includes(value)
}

/** index.html のちらつき防止スクリプトと同じキーにしておくこと。 */
export const THEME_STORAGE_KEY = 'theme'

export interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
}

// Provider の外でも例外にしない（Toaster などを単体で描画するテストを壊さないため）
export const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  setTheme: () => {},
})

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
