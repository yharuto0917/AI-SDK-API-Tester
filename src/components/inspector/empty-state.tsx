import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  /** ボタンなどの操作 */
  children?: ReactNode
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: EmptyStateProps) {
  return (
    <Empty className={cn('h-full min-h-0', className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description !== undefined ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {children !== undefined ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  )
}
