import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { isTheme, useTheme } from '@/components/theme-context'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const THEME_OPTIONS = [
  { value: 'system', label: 'システム', Icon: MonitorIcon },
  { value: 'light', label: 'ライト', Icon: SunIcon },
  { value: 'dark', label: 'ダーク', Icon: MoonIcon },
] as const

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="テーマを切り替え" title="テーマを切り替え">
          {/* 実際の見た目（解決済みテーマ）は CSS で切り替える。state を介さないのでちらつかない */}
          <SunIcon className="dark:hidden" aria-hidden="true" />
          <MoonIcon className="hidden dark:block" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (isTheme(value)) setTheme(value)
          }}
        >
          {THEME_OPTIONS.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden="true" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
