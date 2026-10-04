import type { ChatStatus, FileUIPart } from 'ai'
import { PaperclipIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { toast } from 'sonner'
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from '@/components/ai-elements/attachments'
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import { Spinner } from '@/components/ui/spinner'
import { isChatBusy } from '@/components/chat/chat-utils'
import type { ChatMode } from '@/components/chat/chat-utils'

/** data URL にして JSON で送るので、大きすぎる添付は弾く。 */
const MAX_FILE_SIZE = 8 * 1024 * 1024
const MAX_FILES = 8

const ATTACH_ERROR_MESSAGES = {
  max_files: `添付できるのは ${MAX_FILES} ファイルまでです`,
  max_file_size: `ファイルサイズが大きすぎます（上限 ${MAX_FILE_SIZE / 1024 / 1024} MB）`,
  accept: '対応していないファイル形式です',
} as const

export interface ChatComposerProps {
  mode: ChatMode
  status: ChatStatus
  onSend: (input: { text: string; files: FileUIPart[] }) => void
  onStop: () => void
}

function ComposerAttachments() {
  const attachments = usePromptInputAttachments()
  const { remove } = attachments
  if (attachments.files.length === 0) return null
  return (
    <Attachments variant="inline" aria-label="添付ファイル">
      {attachments.files.map((file) => (
        <Attachment key={file.id} data={file} onRemove={() => remove(file.id)}>
          <AttachmentPreview />
          <AttachmentInfo className="max-w-40" />
          <AttachmentRemove label="添付を削除" className="opacity-100" />
        </Attachment>
      ))}
    </Attachments>
  )
}

function AttachButton() {
  const { openFileDialog } = usePromptInputAttachments()
  return (
    <PromptInputButton
      aria-label="画像・ファイルを添付"
      title="画像・ファイルを添付"
      onClick={openFileDialog}
    >
      <PaperclipIcon className="size-4" aria-hidden />
    </PromptInputButton>
  )
}

function ComposerSubmit({
  status,
  hasText,
  onStop,
}: {
  status: ChatStatus
  hasText: boolean
  onStop: () => void
}) {
  const attachments = usePromptInputAttachments()
  const generating = isChatBusy(status)
  // 生成中は停止ボタンになるので無効にしない。それ以外は本文か添付があるときだけ押せる
  const disabled = !generating && !hasText && attachments.files.length === 0
  return (
    <PromptInputSubmit
      // error は X アイコンになり「取り消し」に見えてしまうので、送信アイコンのままにする
      status={generating ? status : 'ready'}
      onStop={onStop}
      disabled={disabled}
      aria-label={generating ? '停止' : '送信'}
      title={generating ? '生成を停止' : '送信（Enter）'}
    >
      {/* 同梱のスピナーは aria-label が英語（Loading）なので、送信中だけ差し替える */}
      {status === 'submitted' ? <Spinner aria-label="送信中" /> : undefined}
    </PromptInputSubmit>
  )
}

/**
 * メッセージ入力欄。Enter 送信 / Shift+Enter 改行。
 * IME の変換確定 Enter は PromptInputTextarea が compositionstart/end と isComposing で弾く。
 * Safari は compositionend が keydown より先に来て isComposing が false になるため、keyCode 229 で補う。
 */
export function ChatComposer({ mode, status, onSend, onStop }: ChatComposerProps) {
  const [text, setText] = useState('')
  const generating = isChatBusy(status)

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.currentTarget.value)
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter') return
      const native = event.nativeEvent
      if (!native.isComposing && native.keyCode === 229) {
        event.preventDefault()
        return
      }
      // 生成中の Enter は送信しない（送ると PromptInput が入力欄を空にしてしまい、入力が失われる）
      if (generating && !event.shiftKey && !native.isComposing) event.preventDefault()
    },
    [generating],
  )

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      if (generating) return
      if (message.text.trim() === '' && message.files.length === 0) return
      onSend({ text: message.text, files: message.files })
      setText('')
    },
    [generating, onSend],
  )

  const handleAttachError = useCallback((error: { code: keyof typeof ATTACH_ERROR_MESSAGES }) => {
    toast.error(ATTACH_ERROR_MESSAGES[error.code])
  }, [])

  return (
    <div className="shrink-0 border-t bg-background p-3">
      <PromptInput
        multiple
        maxFiles={MAX_FILES}
        maxFileSize={MAX_FILE_SIZE}
        onError={handleAttachError}
        onSubmit={handleSubmit}
        aria-label="メッセージ入力"
      >
        <PromptInputHeader>
          <ComposerAttachments />
        </PromptInputHeader>
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="メッセージを入力（Enter で送信 / Shift+Enter で改行）"
            aria-label="メッセージ"
            className="min-h-14 text-sm"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <AttachButton />
            {mode === 'chat-text' ? (
              <span className="truncate text-muted-foreground text-xs">
                Text Stream は応答をテキストとしてだけ解釈します（添付はリクエストに含まれます）
              </span>
            ) : null}
          </PromptInputTools>
          <ComposerSubmit status={status} hasText={text.trim() !== ''} onStop={onStop} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
