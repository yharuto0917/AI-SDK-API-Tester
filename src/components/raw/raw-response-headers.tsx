import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { RawResponseHeader } from '@/hooks/use-raw-request'
import { cn } from '@/lib/utils'

export interface RawResponseHeadersProps {
  headers: readonly RawResponseHeader[]
}

/** レスポンスヘッダーの一覧。普段は畳んでおき、開いたときだけ表を出す。 */
export function RawResponseHeaders({ headers }: RawResponseHeadersProps) {
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2 gap-1 text-muted-foreground">
          <ChevronRight className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
          レスポンスヘッダー（{headers.length}）
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 max-h-48 overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 w-1/3">名前</TableHead>
                <TableHead className="h-8">値</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {headers.map((header, index) => (
                <TableRow key={`${header.name}-${index}`}>
                  <TableCell className="py-1.5 align-top font-mono text-xs whitespace-normal break-all">
                    {header.name}
                  </TableCell>
                  <TableCell className="py-1.5 font-mono text-xs whitespace-normal break-all">
                    {header.value}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
