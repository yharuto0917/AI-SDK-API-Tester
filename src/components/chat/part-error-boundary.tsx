import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

export interface PartErrorBoundaryProps {
  /** 描画に失敗したときの代替表示 */
  fallback: (error: unknown) => ReactNode
  /** これが変わったら再描画を試みる（ストリーミングで part が更新されたとき用） */
  resetKey?: unknown
  children: ReactNode
}

interface PartErrorBoundaryState {
  hasError: boolean
  error: unknown
  /** 直近の resetKey。props 側が変わったかを getDerivedStateFromProps で判定する */
  resetKey: unknown
}

/**
 * パート 1 つの描画失敗が会話全体を落とさないようにする。
 * サーバーが想定外の形のデータを返したとき、そのパートだけをフォールバック表示にする。
 */
export class PartErrorBoundary extends Component<PartErrorBoundaryProps, PartErrorBoundaryState> {
  state: PartErrorBoundaryState = {
    hasError: false,
    error: undefined,
    resetKey: this.props.resetKey,
  }

  static getDerivedStateFromError(error: unknown): Partial<PartErrorBoundaryState> {
    return { hasError: true, error }
  }

  static getDerivedStateFromProps(
    props: PartErrorBoundaryProps,
    state: PartErrorBoundaryState,
  ): Partial<PartErrorBoundaryState> | null {
    // resetKey が変わったら（ストリーミングで part が更新されたら）もう一度描画を試みる
    if (props.resetKey === state.resetKey) return null
    return { resetKey: props.resetKey, hasError: false, error: undefined }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[chat] パートの描画に失敗しました', error, info.componentStack)
  }

  render(): ReactNode {
    return this.state.hasError ? this.props.fallback(this.state.error) : this.props.children
  }
}
