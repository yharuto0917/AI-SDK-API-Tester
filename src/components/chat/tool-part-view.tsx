import type { ChatStatus } from 'ai'
import { getToolName } from 'ai'
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  ClockIcon,
  Loader2Icon,
  ShieldQuestionIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation'
import { Tool, ToolContent } from '@/components/ai-elements/tool'
import { useChatActions } from '@/components/chat/chat-context'
import {
  TONE_BADGE_CLASS,
  isChatBusy,
  isToolPartStreaming,
  needsManualOutput,
  safeJson,
  toolDisplayName,
  toolStateMeta,
} from '@/components/chat/chat-utils'
import type { ToolPart } from '@/components/chat/chat-utils'
import { JsonBlock } from '@/components/chat/json-block'
import { ToolOutputForm } from '@/components/chat/tool-output-form'
import { Badge } from '@/components/ui/badge'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface ToolPartViewProps {
  part: ToolPart
  /** 最後のメッセージのツールだけが、出力を返せる（addToolOutput は最後のメッセージを更新する） */
  isLastMessage: boolean
  /** 最後のメッセージに対してだけ渡す */
  chatStatus: ChatStatus | undefined
}

function StateIcon({ state }: { state: string }) {
  switch (state) {
    case 'input-streaming':
      return <Loader2Icon className="size-3 animate-spin" aria-hidden />
    case 'input-available':
      return <ClockIcon className="size-3" aria-hidden />
    case 'approval-requested':
      return <ShieldQuestionIcon className="size-3" aria-hidden />
    case 'approval-responded':
      return <CheckCircleIcon className="size-3" aria-hidden />
    case 'output-available':
      return <CheckCircleIcon className="size-3" aria-hidden />
    case 'output-error':
    case 'output-denied':
      return <XCircleIcon className="size-3" aria-hidden />
    default:
      return <CircleDashedIcon className="size-3" aria-hidden />
  }
}

function ToolSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 overflow-hidden">
      <h4 className="font-medium text-muted-foreground text-xs">{title}</h4>
      {children}
    </div>
  )
}

/** ツールの入出力 JSON。受信中に更新されている間は、更新のたびにハイライトしないよう素のテキストで見せる。 */
function ToolJson({ value, streaming }: { value: unknown; streaming: boolean }) {
  return (
    <div className="rounded-md bg-muted/50">
      <JsonBlock code={safeJson(value)} plain={streaming} />
    </div>
  )
}

function TextBlock({ text, destructive = false }: { text: string; destructive?: boolean }) {
  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md p-3 font-mono text-xs',
        destructive ? 'bg-destructive/10 text-destructive' : 'bg-muted/50 text-foreground',
      )}
    >
      {text}
    </pre>
  )
}

function ApprovalSection({
  part,
  onRespond,
}: {
  part: ToolPart
  onRespond: (approved: boolean, reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const approval = part.approval
  if (approval === undefined) return null
  const requested = part.state === 'approval-requested'
  const requestReason = approval.requestReason
  const responseReason = approval.reason

  return (
    <Confirmation
      approval={approval}
      state={part.state}
      role="group"
      aria-label="ツール実行の承認"
      className="bg-background"
    >
      <ConfirmationTitle className="space-y-1">
        <ConfirmationRequest>
          <span className="block">このツールの実行を承認しますか？</span>
          {typeof requestReason === 'string' && requestReason !== '' ? (
            <span className="block text-muted-foreground text-xs">
              サーバーの理由: {requestReason}
            </span>
          ) : null}
        </ConfirmationRequest>
        <ConfirmationAccepted>
          <span className="flex items-center gap-1.5">
            <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            承認しました
          </span>
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <span className="flex items-center gap-1.5">
            <XIcon className="size-4 text-destructive" aria-hidden />
            拒否しました
          </span>
        </ConfirmationRejected>
        {!requested && typeof responseReason === 'string' && responseReason !== '' ? (
          <span className="block text-muted-foreground text-xs">理由: {responseReason}</span>
        ) : null}
      </ConfirmationTitle>
      {requested ? (
        <Input
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
          placeholder="理由（任意）"
          aria-label="承認 / 拒否の理由（任意）"
          className="h-8 text-xs md:text-xs"
        />
      ) : null}
      <ConfirmationActions>
        <ConfirmationAction variant="outline" onClick={() => onRespond(false, reason)}>
          拒否
        </ConfirmationAction>
        <ConfirmationAction variant="default" onClick={() => onRespond(true, reason)}>
          承認
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  )
}

/** ツール呼び出し 1 件（静的ツール / dynamic-tool 共通）。入力・承認・出力・手動出力フォームをまとめて見せる。 */
export function ToolPartView({ part, isLastMessage, chatStatus }: ToolPartViewProps) {
  const actions = useChatActions()
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined)
  const [autoOpened, setAutoOpened] = useState(false)

  const title = toolDisplayName(part)
  const toolName = getToolName(part)
  const meta = toolStateMeta(part.state, part.approval?.approved)
  const idle = !isChatBusy(chatStatus ?? 'ready')
  const streaming = isToolPartStreaming(part, { chatStatus, isLastMessage })

  const waitingForOutput = needsManualOutput(part)
  const showOutputForm = waitingForOutput && isLastMessage && idle
  const awaitingApproval = part.state === 'approval-requested'
  // 対応が必要になったら開き、応答後も（結果を見られるよう）開いたままにする。ユーザーが開閉したらそちらを優先する
  const needsAttention = showOutputForm || awaitingApproval
  if (needsAttention && !autoOpened) setAutoOpened(true)
  const open = manualOpen ?? (needsAttention || autoOpened)

  const rawInput =
    part.state === 'input-streaming' &&
    part.input === undefined &&
    typeof part.rawInput === 'string'
      ? part.rawInput
      : undefined

  return (
    <Tool open={open} onOpenChange={setManualOpen} data-tool-state={part.state}>
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3 text-left">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <WrenchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium text-sm">{title}</span>
          <Badge variant="secondary" className={cn('rounded-full', TONE_BADGE_CLASS[meta.tone])}>
            <StateIcon state={part.state} />
            {meta.label}
          </Badge>
          {part.providerExecuted === true ? (
            <Badge variant="outline" title="providerExecuted: プロバイダー側で実行されたツール">
              プロバイダー実行
            </Badge>
          ) : null}
          {part.type === 'dynamic-tool' ? (
            <Badge variant="outline" className="font-mono">
              dynamic
            </Badge>
          ) : null}
          {part.state === 'output-available' && part.preliminary === true ? (
            <Badge variant="outline">暫定出力</Badge>
          ) : null}
        </div>
        <ChevronDownIcon
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <ToolContent>
        {part.input !== undefined ? (
          <ToolSection title="入力">
            <ToolJson value={part.input} streaming={streaming} />
          </ToolSection>
        ) : null}
        {rawInput !== undefined ? (
          <ToolSection title="入力（受信中）">
            <TextBlock text={rawInput} />
          </ToolSection>
        ) : null}

        <ApprovalSection
          part={part}
          onRespond={(approved, reason) =>
            actions.respondToApproval({
              id: part.approval?.id ?? '',
              approved,
              ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
            })
          }
        />

        {part.state === 'output-available' ? (
          <ToolSection title="出力">
            {part.output === undefined ? (
              <p className="text-muted-foreground text-xs">（出力なし）</p>
            ) : typeof part.output === 'string' ? (
              <TextBlock text={part.output} />
            ) : (
              <ToolJson value={part.output} streaming={streaming} />
            )}
          </ToolSection>
        ) : null}
        {part.state === 'output-error' ? (
          <ToolSection title="エラー">
            <TextBlock text={part.errorText} destructive />
          </ToolSection>
        ) : null}

        {showOutputForm ? (
          <ToolOutputForm
            toolName={title}
            onOutput={(output) =>
              actions.addToolOutput({ tool: toolName, toolCallId: part.toolCallId, output })
            }
            onError={(errorText) =>
              actions.addToolError({ tool: toolName, toolCallId: part.toolCallId, errorText })
            }
          />
        ) : null}
        {waitingForOutput && !isLastMessage ? (
          <p className="text-muted-foreground text-xs">
            出力が返されないまま残っています（最後のメッセージ以外には出力を返せません）。
          </p>
        ) : null}
      </ToolContent>
    </Tool>
  )
}
