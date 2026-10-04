import type { StatusTone } from '@/components/inspector/entry-utils'
import type { EventFamily, EventNoteTone } from '@/components/inspector/stream-utils'
import type { DiagnosticLevel } from '@/types'

/**
 * 状態の色分けに使う Tailwind クラス。成功 / 警告 / 情報だけは emerald / amber / sky を使い、
 * ライト・ダークの両方で読めるよう必ず dark: とセットにする。
 * tool 系（violet）だけは、種別を見分けやすくするために別色にしている。
 */

/** Alert（診断）の枠・背景・文字色。error は Alert の variant="destructive" と組み合わせる。 */
export const LEVEL_ALERT_CLASSES: Readonly<Record<DiagnosticLevel, string>> = {
  error: 'border-destructive/30 bg-destructive/5 dark:bg-destructive/10',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200',
  info: 'border-sky-500/40 bg-sky-500/10 text-sky-900 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-200',
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-200',
}

/** 小さなバッジ（Tab の件数表示など）。 */
export const LEVEL_BADGE_CLASSES: Readonly<Record<DiagnosticLevel, string>> = {
  error: 'border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20',
  warn: 'border-transparent bg-amber-500/15 text-amber-800 dark:bg-amber-400/20 dark:text-amber-200',
  info: 'border-transparent bg-sky-500/15 text-sky-800 dark:bg-sky-400/20 dark:text-sky-200',
  ok: 'border-transparent bg-emerald-500/15 text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-200',
}

/** HTTP ステータスコードのバッジ。 */
export const STATUS_BADGE_CLASSES: Readonly<Record<StatusTone, string>> = {
  success:
    'border-transparent bg-emerald-500/15 text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-200',
  info: 'border-transparent bg-sky-500/15 text-sky-800 dark:bg-sky-400/20 dark:text-sky-200',
  error: 'border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20',
  none: 'border-border bg-transparent text-muted-foreground',
}

/** ストリームイベントの種別バッジ。 */
export const FAMILY_BADGE_CLASSES: Readonly<Record<EventFamily, string>> = {
  text: 'border-transparent bg-sky-500/15 text-sky-800 dark:bg-sky-400/20 dark:text-sky-200',
  tool: 'border-transparent bg-violet-500/15 text-violet-800 dark:bg-violet-400/20 dark:text-violet-200',
  data: 'border-transparent bg-muted text-muted-foreground',
  error: 'border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20',
  lifecycle:
    'border-transparent bg-emerald-500/15 text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-200',
  control: 'border-border bg-transparent text-muted-foreground/70',
  chunk: 'border-transparent bg-secondary text-secondary-foreground',
  other: 'border-border bg-transparent text-foreground',
}

/** ストリームイベントの注記バッジ（未完了・切り詰め・スキーマ不一致など）。種別バッジより控えめにする。 */
export const NOTE_BADGE_CLASSES: Readonly<Record<EventNoteTone, string>> = {
  muted: 'border-border bg-transparent text-muted-foreground',
  warn: LEVEL_BADGE_CLASSES.warn,
}
