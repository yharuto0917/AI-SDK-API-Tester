import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { PROXY_NAME, checkProxyAvailable } from '@/lib/proxy'
import { settingsStore } from '@/lib/settings-store'

export type ProxyStatus = 'checking' | 'available' | 'unavailable'

export const PROXY_STATUS_LABELS: Record<ProxyStatus, string> = {
  checking: '確認中',
  available: '利用可能',
  unavailable: '利用不可',
}

/** 「devプロキシ: 利用可能」のような状態表示。ヘッダーのバッジと設定パネルで文言を揃える。 */
export function proxyStatusText(status: ProxyStatus): string {
  return `${PROXY_NAME}: ${PROXY_STATUS_LABELS[status]}`
}

// ヘッダーのバッジと設定パネルが同じ状態を見せられるよう、状態はモジュールで 1 つだけ持つ。
// （フックごとに別々に持つと、片方で「再確認」しても他方が古いままになり、リクエストも重複する）
let status: ProxyStatus = 'checking'
let subscriberCount = 0
let controller: AbortController | null = null
const listeners = new Set<() => void>()

function emit(next: ProxyStatus): void {
  if (status === next) return
  status = next
  for (const listener of [...listeners]) listener()
}

/**
 * プロキシの生存確認を 1 回走らせる。直前の確認が残っていれば中断して置き換える。
 * showChecking=false のときは結果が出るまで前回の表示を保つ（focus のたびに「確認中」が点滅しないように）。
 */
function check(showChecking: boolean): void {
  controller?.abort()
  const current = new AbortController()
  controller = current
  if (showChecking) emit('checking')
  void checkProxyAvailable(undefined, current.signal).then((ok) => {
    // 中断された確認は常に false で返ってくるため、結果を採用せず捨てる
    // （アンマウント後や、後から始めた確認に置き換えられた後の古い結果で上書きしない）
    if (current.signal.aborted) return
    emit(ok ? 'available' : 'unavailable')
  })
}

function handleWindowFocus(): void {
  check(false)
}

function recheck(): void {
  check(true)
}

/** 最初の購読者が現れたときに確認と focus 監視を始め、最後の購読者が消えたら中断する。 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  subscriberCount += 1
  if (subscriberCount === 1) {
    window.addEventListener('focus', handleWindowFocus)
    check(false)
  }
  return () => {
    listeners.delete(listener)
    subscriberCount -= 1
    if (subscriberCount === 0) {
      window.removeEventListener('focus', handleWindowFocus)
      controller?.abort()
      controller = null
      // 次に使われるときは再び「確認中」から始める
      status = 'checking'
    }
  }
}

function getSnapshot(): ProxyStatus {
  return status
}

function getUseDevProxy(): boolean {
  return settingsStore.getSettings().useDevProxy
}

/**
 * Vite の dev プロキシ（/__proxy）が使えるかを返す。
 * マウント時・ウィンドウ focus 時・settings.useDevProxy の変更時に確認し、アンマウントで中断する。
 */
export function useProxyStatus(): { status: ProxyStatus; recheck: () => void } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // settings 全体ではなく useDevProxy だけを購読する（他の設定変更で再確認や再描画を起こさない）
  const useDevProxy = useSyncExternalStore(settingsStore.subscribe, getUseDevProxy, getUseDevProxy)

  const previous = useRef(useDevProxy)
  useEffect(() => {
    // マウント直後（値が変わっていない）は subscribe 側の確認で足りる
    if (previous.current === useDevProxy) return
    previous.current = useDevProxy
    check(false)
  }, [useDevProxy])

  return useMemo(() => ({ status: current, recheck }), [current])
}
