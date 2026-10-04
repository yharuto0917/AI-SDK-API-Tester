import { useRef, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { AppHeader } from '@/components/app-header'
import { InspectorPanel } from '@/components/inspector/inspector-panel'
import { SettingsPanel } from '@/components/settings/settings-panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Toaster } from '@/components/ui/sonner'
import { useSettings } from '@/hooks/use-settings'
import { cn } from '@/lib/utils'
import { MODES } from '@/types'
import type { Mode } from '@/types'
import { ChatView } from '@/views/chat-view'
import { CompletionView } from '@/views/completion-view'
import { RawView } from '@/views/raw-view'

/** Tailwind の lg。これ以上なら 3 カラム、未満なら中央だけ表示して設定・インスペクタはドロワーで開く。 */
const DESKTOP_QUERY = '(min-width: 1024px)'

function subscribeDesktop(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function getDesktopSnapshot(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches
}

function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, getDesktopSnapshot, () => true)
}

type PaneKind = 'settings' | 'inspector'

/**
 * Panel の内側 div は既定で overflow: auto なので、はみ出した内容でペイン自体がスクロールしてしまう。
 * スクロールは各パネルの内部だけに任せるため hidden にする（Panel の style は内側 div に当たる）。
 */
const PANE_STYLE = { overflow: 'hidden' } as const

function ModeView({ mode }: { mode: Mode }): ReactNode {
  switch (mode) {
    case 'chat-ui':
    case 'chat-text':
      return <ChatView mode={mode} />
    case 'completion':
      return <CompletionView />
    case 'raw':
      return <RawView />
  }
}

interface DrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  side: 'left' | 'right'
  title: string
  description: string
  className?: string
  /** 閉じた直後のフォーカス移動。preventDefault した場合は Radix 既定の処理を行わない */
  onCloseAutoFocus: (event: Event) => void
  children: ReactNode
}

/** lg 未満で設定・インスペクタを出すドロワー。 */
function Drawer({
  open,
  onOpenChange,
  side,
  title,
  description,
  className,
  onCloseAutoFocus,
  children,
}: DrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={cn('gap-0 outline-hidden', className)}
        // 先頭の入力欄へ自動フォーカスすると、スマホでキーボードが勝手に出てしまう。
        // フォーカスはドロワー自体に置き、トラップと Escape は Radix 既定のままにする
        // （preventDefault すると Radix はフォーカス移動を一切しないので、自分で移す）
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <SheetHeader className="border-b py-3 pr-12">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1">{children}</div>
      </SheetContent>
    </Sheet>
  )
}

export default function App() {
  const { settings } = useSettings()
  const { mode } = settings
  const isDesktop = useIsDesktop()

  // lg 以上のペイン開閉と、lg 未満のドロワー開閉は別々に持つ（画面幅をまたいでも互いに影響しない）
  const [panes, setPanes] = useState<Record<PaneKind, boolean>>({ settings: true, inspector: true })
  const [drawer, setDrawer] = useState<PaneKind | null>(null)

  // 一度でも開いたモードのビューはマウントしたままにして、タブを往復しても会話や出力を失わない。
  // 初回訪問まではマウントしない（描画中の setState は、React が即座に描き直す公式のパターン）
  const [visited, setVisited] = useState<readonly Mode[]>([mode])
  if (!visited.includes(mode)) setVisited([...visited, mode])

  // lg 以上に広げたらドロワーの開閉状態も捨てる（残すと、再び狭めたときに勝手に開き直してしまう）
  if (isDesktop && drawer !== null) setDrawer(null)

  const showSettingsPane = isDesktop && panes.settings
  const showInspectorPane = isDesktop && panes.inspector
  const openDrawer = isDesktop ? null : drawer

  // ドロワーを開いたヘッダーのボタン。Trigger を使わない構成では Radix が閉じたあとの戻り先を持たず、
  // フォーカスが body に落ちるので、自分で控えて戻す
  const openerRef = useRef<HTMLElement | null>(null)

  function rememberOpener(event: ReactMouseEvent): void {
    // Safari・タッチはクリックでボタンにフォーカスを移さず document.activeElement が頼れないので、
    // クリックの対象から取る。キーボード操作（Enter / Space）でもクリックは発生する
    openerRef.current = event.target instanceof Element ? event.target.closest('button') : null
  }

  function restoreOpenerFocus(event: Event): void {
    const opener = openerRef.current
    if (opener === null || !opener.isConnected) return
    // preventDefault しないと Radix 既定の処理（Trigger が無いので何にもフォーカスしない）が走る
    event.preventDefault()
    opener.focus()
  }

  function toggle(kind: PaneKind): void {
    if (isDesktop) setPanes((prev) => ({ ...prev, [kind]: !prev[kind] }))
    else setDrawer(kind)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      {/* contents なのでレイアウトには影響しない。ドロワー（Portal）側のクリックはここへ届かない */}
      <div className="contents" onClickCapture={rememberOpener}>
        <AppHeader
          isDesktop={isDesktop}
          settingsOpen={isDesktop ? panes.settings : openDrawer === 'settings'}
          inspectorOpen={isDesktop ? panes.inspector : openDrawer === 'inspector'}
          onToggleSettings={() => toggle('settings')}
          onToggleInspector={() => toggle('inspector')}
        />
      </div>

      <div className="min-h-0 flex-1">
        {/* 中央のペインは画面幅が変わっても同じ位置に置き続け、ビューが再マウントされないようにする */}
        <ResizablePanelGroup id="app-layout" orientation="horizontal">
          {showSettingsPane && (
            <>
              <ResizablePanel
                id="app-panel-settings"
                defaultSize="22%"
                minSize="16%"
                maxSize="35%"
                style={PANE_STYLE}
              >
                <aside aria-label="設定" className="h-full min-h-0">
                  <SettingsPanel />
                </aside>
              </ResizablePanel>
              <ResizableHandle withHandle aria-label="設定パネルの幅を変更" />
            </>
          )}

          <ResizablePanel id="app-panel-main" minSize="30%" style={PANE_STYLE}>
            <main className="h-full min-h-0">
              {MODES.map((m) =>
                visited.includes(m) ? (
                  // hidden は display: none なので、非表示のビューはフォーカスも読み上げの対象にもならない
                  <div
                    key={m}
                    role="tabpanel"
                    id={`mode-panel-${m}`}
                    aria-labelledby={`mode-tab-${m}`}
                    hidden={m !== mode}
                    className="h-full min-h-0"
                  >
                    <ModeView mode={m} />
                  </div>
                ) : null,
              )}
            </main>
          </ResizablePanel>

          {showInspectorPane && (
            <>
              <ResizableHandle withHandle aria-label="インスペクタの幅を変更" />
              <ResizablePanel
                id="app-panel-inspector"
                defaultSize="30%"
                minSize="22%"
                maxSize="55%"
                style={PANE_STYLE}
              >
                <aside aria-label="インスペクタ" className="h-full min-h-0">
                  <InspectorPanel />
                </aside>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

      <Drawer
        open={openDrawer === 'settings'}
        onOpenChange={(open) => setDrawer(open ? 'settings' : null)}
        side="left"
        title="設定"
        description="接続先・認証・リクエストの設定"
        onCloseAutoFocus={restoreOpenerFocus}
      >
        <SettingsPanel />
      </Drawer>
      <Drawer
        open={openDrawer === 'inspector'}
        onOpenChange={(open) => setDrawer(open ? 'inspector' : null)}
        side="right"
        title="インスペクタ"
        description="リクエストとレスポンスの詳細、診断結果"
        className="data-[side=right]:w-[92vw] data-[side=right]:sm:max-w-lg"
        onCloseAutoFocus={restoreOpenerFocus}
      >
        <InspectorPanel />
      </Drawer>

      <Toaster />
    </div>
  )
}
