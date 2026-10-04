import { useId } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { FieldDescription } from '@/components/ui/field'
import { cn } from '@/lib/utils'

interface SettingsSectionProps {
  title: string
  description?: string
  icon: LucideIcon
  children: ReactNode
}

/** 設定パネルの 1 セクション。見出しと本文を section として関連づける。 */
export function SettingsSection({
  title,
  description,
  icon: Icon,
  children,
}: SettingsSectionProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          {title}
        </h2>
        {description !== undefined && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  )
}

/** 入力欄の下に置く補足文。幅の狭いパネルに合わせて小さめにする。 */
export function Hint({ className, ...props }: ComponentProps<typeof FieldDescription>) {
  return <FieldDescription className={cn('text-xs leading-relaxed', className)} {...props} />
}
