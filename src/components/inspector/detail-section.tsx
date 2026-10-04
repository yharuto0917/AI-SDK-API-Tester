import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface DetailSectionProps {
  title: ReactNode
  /** 見出しの右に置く操作（コピーなど） */
  actions?: ReactNode
  children: ReactNode
  className?: string
}

/** タブ内の「見出し + 中身」のまとまり。 */
export function DetailSection({ title, actions, children, className }: DetailSectionProps) {
  return (
    <section className={cn('min-w-0 space-y-1.5', className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        {actions !== undefined ? (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  )
}
