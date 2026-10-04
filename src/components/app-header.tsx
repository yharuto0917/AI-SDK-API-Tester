import type { ComponentType, SVGProps } from 'react'
import { FlaskConicalIcon, PanelLeftIcon, PanelRightIcon } from 'lucide-react'
import { ProxyStatusBadge } from '@/components/proxy-status-badge'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSettings } from '@/hooks/use-settings'
import { MODE_LABELS, MODES } from '@/types'
import type { Mode } from '@/types'

/** 狭い画面でタブに収めるための短縮名。 */
const SHORT_MODE_LABELS: Record<Mode, string> = {
  'chat-ui': 'Chat UI',
  'chat-text': 'Chat Text',
  completion: 'Completion',
  raw: 'Raw',
}

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value)
}

interface PaneToggleProps {
  label: string
  Icon: ComponentType<SVGProps<SVGSVGElement>>
  open: boolean
  /** true: ペインの開閉トグル / false: ドロワー（Sheet）を開くボタン */
  isDesktop: boolean
  onClick: () => void
}

function PaneToggle({ label, Icon, open, isDesktop, onClick }: PaneToggleProps) {
  const hint = isDesktop && open ? `${label}を閉じる` : `${label}を開く`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          // 名前は固定にして、開閉の状態は aria-pressed で伝える。ドロワーは開くだけなので押下状態を持たない
          aria-pressed={isDesktop ? open : undefined}
          aria-haspopup={isDesktop ? undefined : 'dialog'}
          className="aria-pressed:bg-muted"
          onClick={onClick}
        >
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{hint}</TooltipContent>
    </Tooltip>
  )
}

export interface AppHeaderProps {
  /** lg 以上なら左右ペインの開閉、未満ならドロワーを開く */
  isDesktop: boolean
  settingsOpen: boolean
  inspectorOpen: boolean
  onToggleSettings: () => void
  onToggleInspector: () => void
}

export function AppHeader({
  isDesktop,
  settingsOpen,
  inspectorOpen,
  onToggleSettings,
  onToggleInspector,
}: AppHeaderProps) {
  const { settings, update } = useSettings()

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background px-3 py-2 lg:flex-nowrap">
      <div className="flex min-w-0 items-center gap-2">
        <FlaskConicalIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h1 className="truncate text-sm font-semibold">AI SDK API Tester</h1>
      </div>

      {/* 狭い画面ではタブだけ 2 行目に回して全幅で使う */}
      <Tabs
        value={settings.mode}
        onValueChange={(value) => {
          if (isMode(value)) update({ mode: value })
        }}
        className="order-last w-full lg:order-none lg:w-auto"
      >
        <TabsList aria-label="接続モード" className="w-full lg:w-auto">
          {MODES.map((mode) => (
            <TabsTrigger
              key={mode}
              value={mode}
              // App 側の tabpanel と対応づける（Radix 既定の aria-controls は描画されないパネルを指すため上書きする）
              id={`mode-tab-${mode}`}
              aria-controls={`mode-panel-${mode}`}
              className="px-1.5 max-sm:text-xs lg:px-2.5"
            >
              <span className="hidden xl:inline">{MODE_LABELS[mode]}</span>
              <span className="xl:hidden">{SHORT_MODE_LABELS[mode]}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="ml-auto flex items-center gap-1">
        <ProxyStatusBadge />
        <ThemeToggle />
        <Separator orientation="vertical" className="mx-1 h-5 data-vertical:self-center" />
        <PaneToggle
          label="設定パネル"
          Icon={PanelLeftIcon}
          open={settingsOpen}
          isDesktop={isDesktop}
          onClick={onToggleSettings}
        />
        <PaneToggle
          label="インスペクタ"
          Icon={PanelRightIcon}
          open={inspectorOpen}
          isDesktop={isDesktop}
          onClick={onToggleInspector}
        />
      </div>
    </header>
  )
}
