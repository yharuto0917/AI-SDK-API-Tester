import { CopyIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { copyToClipboard } from '@/components/inspector/clipboard'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface CopyButtonProps {
  /** 文字列、または押した時点で作る関数（5000 件のイベントなど、重い文字列を毎回作らないため） */
  text: string | (() => string)
  /** トーストと aria-label に使う名前（「cURL」など）。「をコピー」は自動で付く */
  label: string
  /** 渡すとアイコン + 文字のボタンになる。無ければアイコンだけ */
  children?: ReactNode
  variant?: 'ghost' | 'outline'
  className?: string
}

export function CopyButton({
  text,
  label,
  children,
  variant = 'ghost',
  className,
}: CopyButtonProps) {
  const handleClick = () => {
    void copyToClipboard(typeof text === 'function' ? text() : text, label)
  }

  if (children !== undefined) {
    return (
      <Button
        type="button"
        variant={variant}
        size="xs"
        className={className}
        title={`${label}をコピー`}
        onClick={handleClick}
      >
        <CopyIcon aria-hidden />
        {children}
      </Button>
    )
  }
  return (
    <Button
      type="button"
      variant={variant}
      size="icon-xs"
      className={cn('shrink-0', className)}
      aria-label={`${label}をコピー`}
      title={`${label}をコピー`}
      onClick={handleClick}
    >
      <CopyIcon aria-hidden />
    </Button>
  )
}
