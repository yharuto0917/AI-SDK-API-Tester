import type { ChatStatus, ReasoningUIPart, TextUIPart, UIMessage } from 'ai'
import {
  BookIcon,
  ChevronDownIcon,
  DatabaseIcon,
  FileTextIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
} from '@/components/ai-elements/attachments'
import type { AttachmentData } from '@/components/ai-elements/attachments'
import { MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { useChatActions } from '@/components/chat/chat-context'
import { isPartStreaming, safeExternalHref, safeJson } from '@/components/chat/chat-utils'
import type { FilePart, RenderItem, SourcePart } from '@/components/chat/chat-utils'
import { JsonBlock } from '@/components/chat/json-block'
import { STREAMDOWN_TRANSLATIONS } from '@/components/chat/streamdown-translations'
import { ToolPartView } from '@/components/chat/tool-part-view'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

export interface MessagePartViewProps {
  item: RenderItem
  /** React key / Attachment ID 用の、メッセージ内で一意な接頭辞付きキー */
  itemKey: string
  role: UIMessage['role']
  isLastMessage: boolean
  /** 最後のメッセージに対してだけ渡す */
  chatStatus: ChatStatus | undefined
}

function TextPartView({
  part,
  role,
  streaming,
}: {
  part: TextUIPart
  role: UIMessage['role']
  streaming: boolean
}) {
  const { markdown } = useChatActions()
  // ユーザーの入力は常にそのまま。Markdown OFF のときはアシスタントの本文も生で見せる（ストリームの検証用）
  if (role === 'user') {
    return <div className="whitespace-pre-wrap break-words">{part.text}</div>
  }
  if (!markdown) {
    return (
      <div className="whitespace-pre-wrap break-words font-mono text-[13px]" data-raw-text="">
        {part.text}
      </div>
    )
  }
  return (
    <MessageResponse isAnimating={streaming} translations={STREAMDOWN_TRANSLATIONS}>
      {part.text}
    </MessageResponse>
  )
}

function thinkingMessage(isStreaming: boolean, duration?: number): ReactNode {
  if (isStreaming) return <Shimmer duration={1}>思考中...</Shimmer>
  if (duration === undefined || duration === 0) return <p>思考過程</p>
  return <p>{duration} 秒間考えました</p>
}

function ReasoningPartView({ part, streaming }: { part: ReasoningUIPart; streaming: boolean }) {
  return (
    <Reasoning isStreaming={streaming}>
      <ReasoningTrigger getThinkingMessage={thinkingMessage} />
      <ReasoningContent>{part.text}</ReasoningContent>
    </Reasoning>
  )
}

function UrlSource({ part }: { part: Extract<SourcePart, { type: 'source-url' }> }) {
  const href = safeExternalHref(part.url)
  const title = part.title !== undefined && part.title !== '' ? part.title : part.url
  if (href === undefined) {
    // javascript: などはリンクにせず、URL をそのまま見せる
    return (
      <div className="flex items-center gap-2">
        <BookIcon className="size-4 shrink-0" aria-hidden />
        <span className="font-medium">{title}</span>
        <span className="break-all text-muted-foreground">{part.url}（リンクなし）</span>
      </div>
    )
  }
  return (
    <Source href={href} title={title}>
      <BookIcon className="size-4 shrink-0" aria-hidden />
      <span className="block font-medium">{title}</span>
    </Source>
  )
}

function SourcesPartView({ parts }: { parts: SourcePart[] }) {
  return (
    <Sources>
      <SourcesTrigger count={parts.length}>
        <BookIcon className="size-4" aria-hidden />
        <p className="font-medium">{parts.length} 件のソースを参照</p>
        <ChevronDownIcon className="size-4" aria-hidden />
      </SourcesTrigger>
      <SourcesContent>
        {parts.map((part, index) =>
          part.type === 'source-url' ? (
            <UrlSource key={`${part.sourceId}-${index}`} part={part} />
          ) : (
            <div key={`${part.sourceId}-${index}`} className="flex items-center gap-2">
              <FileTextIcon className="size-4 shrink-0" aria-hidden />
              <span className="font-medium">{part.title}</span>
              <span className="text-muted-foreground">{part.filename ?? part.mediaType}</span>
            </div>
          ),
        )}
      </SourcesContent>
    </Sources>
  )
}

function FilePartView({
  part,
  itemKey,
  role,
}: {
  part: FilePart
  itemKey: string
  role: UIMessage['role']
}) {
  const isImage = part.mediaType.startsWith('image/')
  // ファイル名が無いと AI Elements は英語の既定ラベル（Image / Attachment）を出すので、日本語で補う
  const filename =
    (part.type === 'file' ? part.filename : undefined) || (isImage ? '画像' : 'ファイル')
  const data: AttachmentData = {
    type: 'file',
    mediaType: part.mediaType,
    url: part.url,
    filename,
    id: itemKey,
  }
  return (
    <div className="space-y-1">
      {part.type === 'reasoning-file' ? (
        <p className="text-muted-foreground text-xs">思考中に生成されたファイル</p>
      ) : null}
      {isImage ? (
        <Attachments variant="grid" className={cn(role !== 'user' && 'ml-0')}>
          <Attachment data={data} className="size-48">
            <AttachmentPreview />
          </Attachment>
        </Attachments>
      ) : (
        <Attachments variant="list">
          <Attachment data={data}>
            <AttachmentPreview />
            <AttachmentInfo showMediaType />
          </Attachment>
        </Attachments>
      )}
    </div>
  )
}

function StepDivider({ stepNumber }: { stepNumber: number }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span>ステップ {stepNumber}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  )
}

function DataPartView({
  part,
  streaming,
}: {
  part: Extract<RenderItem, { kind: 'data' }>['part']
  streaming: boolean
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
        <DatabaseIcon className="size-3.5" aria-hidden />
        <code className="font-mono">{part.type}</code>
        {part.id !== undefined ? <span>id: {part.id}</span> : null}
      </div>
      <JsonBlock code={safeJson(part.data)} plain={streaming} />
    </div>
  )
}

function UnknownPartView({
  type,
  part,
  streaming,
}: {
  type: string
  part: unknown
  streaming: boolean
}) {
  return (
    <Alert role="status">
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>未対応のパート: {type}</AlertTitle>
      <AlertDescription className="col-start-2">
        <JsonBlock code={safeJson(part)} plain={streaming} />
      </AlertDescription>
    </Alert>
  )
}

/** 描画アイテム 1 つ。どの種類でも例外にせず、未知のものは JSON のフォールバックで見せる。 */
export function MessagePartView({
  item,
  itemKey,
  role,
  isLastMessage,
  chatStatus,
}: MessagePartViewProps) {
  // data / unknown のパートは更新の単位が分からないので、最後のメッセージが受信中の間はハイライトを止める
  const streamingMessage = isLastMessage && chatStatus === 'streaming'
  switch (item.kind) {
    case 'text':
      return (
        <TextPartView
          part={item.part}
          role={role}
          streaming={isPartStreaming(item.part, { chatStatus, isLastMessage })}
        />
      )
    case 'reasoning':
      return (
        <ReasoningPartView
          part={item.part}
          streaming={isPartStreaming(item.part, { chatStatus, isLastMessage })}
        />
      )
    case 'tool':
      return <ToolPartView part={item.part} isLastMessage={isLastMessage} chatStatus={chatStatus} />
    case 'sources':
      return <SourcesPartView parts={item.parts} />
    case 'file':
      return <FilePartView part={item.part} itemKey={itemKey} role={role} />
    case 'step':
      return <StepDivider stepNumber={item.stepNumber} />
    case 'data':
      return <DataPartView part={item.part} streaming={streamingMessage} />
    case 'unknown':
      return <UnknownPartView type={item.type} part={item.part} streaming={streamingMessage} />
  }
}
