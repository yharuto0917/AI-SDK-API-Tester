import { isEmphasizedHeader } from '@/components/inspector/entry-utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

interface HeadersTableProps {
  /** 表示するヘッダー。マスクが必要なら呼び出し側で済ませてから渡す */
  headers: Record<string, string>
  /** true のとき x-vercel-ai-ui-message-stream と content-type の行を強調する */
  emphasize?: boolean
  /** スクリーンリーダー向けの表の名前 */
  label: string
  emptyText?: string
}

export function HeadersTable({
  headers,
  emphasize = false,
  label,
  emptyText = 'ヘッダーはありません',
}: HeadersTableProps) {
  const rows = Object.entries(headers)
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        {emptyText}
      </p>
    )
  }
  return (
    <div className="overflow-hidden rounded-md border">
      <Table className="table-fixed text-xs" aria-label={label}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-7 w-[36%] px-2 text-xs">名前</TableHead>
            <TableHead className="h-7 px-2 text-xs">値</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([name, value]) => {
            const emphasized = emphasize && isEmphasizedHeader(name)
            return (
              <TableRow
                key={name}
                data-emphasized={emphasized || undefined}
                className={cn(emphasized && 'bg-muted/60')}
              >
                <TableCell
                  className={cn(
                    'p-1.5 px-2 align-top font-mono break-all whitespace-normal',
                    emphasized ? 'font-semibold text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {name}
                </TableCell>
                <TableCell
                  className={cn(
                    'p-1.5 px-2 align-top font-mono break-all whitespace-pre-wrap',
                    emphasized && 'font-semibold',
                  )}
                >
                  {value}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
