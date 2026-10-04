import { useId } from 'react'
import { SlidersHorizontalIcon } from 'lucide-react'
import { Hint, SettingsSection } from '@/components/settings/settings-section'
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useSettings } from '@/hooks/use-settings'
import { PROXY_NAME } from '@/lib/proxy'
import { parseExtraBody } from '@/lib/settings'
import { MODE_LABELS } from '@/types'
import type { CompletionProtocol, CredentialsMode } from '@/types'

const CREDENTIALS_OPTIONS: readonly CredentialsMode[] = ['omit', 'same-origin', 'include']

/** 選択肢の横に出す短い説明。選択中の詳しい説明は下の Hint に出す。 */
const CREDENTIALS_SHORT: Record<CredentialsMode, string> = {
  omit: 'Cookie を送らない',
  'same-origin': '同一オリジンにだけ送る（既定）',
  include: 'クロスオリジンでも送る',
}

const CREDENTIALS_HINTS: Record<CredentialsMode, string> = {
  omit: 'Cookie などの認証情報を一切送りません。',
  'same-origin': '同じオリジンへのリクエストにだけ Cookie を送ります（fetch の既定）。',
  include:
    'クロスオリジンでも Cookie を送ります。接続先が Access-Control-Allow-Credentials: true を返す必要があります。',
}

const COMPLETION_PROTOCOL_OPTIONS: readonly CompletionProtocol[] = ['data', 'text']

const COMPLETION_PROTOCOL_SHORT: Record<CompletionProtocol, string> = {
  data: 'SSE 形式（既定）',
  text: 'プレーンテキスト',
}

const COMPLETION_PROTOCOL_HINTS: Record<CompletionProtocol, string> = {
  data: 'SSE（data: …）形式のストリームとして解釈します。useCompletion の既定です。',
  text: 'プレーンテキストのストリームとして解釈します。',
}

function isCredentials(value: string): value is CredentialsMode {
  return (CREDENTIALS_OPTIONS as readonly string[]).includes(value)
}

function isCompletionProtocol(value: string): value is CompletionProtocol {
  return (COMPLETION_PROTOCOL_OPTIONS as readonly string[]).includes(value)
}

/** Select の選択肢。名前の下に短い説明を添える。 */
function OptionLabel({ name, description }: { name: string; description: string }) {
  return (
    <span className="flex flex-col gap-0.5 py-0.5">
      <span>{name}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </span>
  )
}

export function RequestSection() {
  const { settings, update } = useSettings()
  const credentialsId = useId()
  const extraBodyId = useId()
  const extraBodyErrorId = useId()
  const lastOnlyId = useId()
  const autoSendId = useId()
  const protocolId = useId()

  const { mode } = settings
  const isChat = mode === 'chat-ui' || mode === 'chat-text'
  const extraBody = parseExtraBody(settings.extraBody)

  return (
    <SettingsSection
      title="リクエスト設定"
      icon={SlidersHorizontalIcon}
      description={`${MODE_LABELS[mode]} に関係する項目だけを表示しています。`}
    >
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={credentialsId}>credentials</FieldLabel>
          <Select
            value={settings.credentials}
            onValueChange={(value) => {
              if (isCredentials(value)) update({ credentials: value })
            }}
          >
            <SelectTrigger id={credentialsId} className="w-full">
              {/* 選択肢には説明を含めるので、閉じているときは値だけを表示する */}
              <SelectValue>{settings.credentials}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CREDENTIALS_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  <OptionLabel name={option} description={CREDENTIALS_SHORT[option]} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Hint>{CREDENTIALS_HINTS[settings.credentials]}</Hint>
          {settings.useDevProxy && (
            <Hint className="text-amber-700 dark:text-amber-300">
              {PROXY_NAME}利用中は、この設定に関係なく omit で送信されます。
            </Hint>
          )}
        </Field>

        {mode !== 'raw' && (
          <Field data-invalid={!extraBody.ok}>
            <FieldLabel htmlFor={extraBodyId}>追加ボディ（JSON）</FieldLabel>
            <Textarea
              id={extraBodyId}
              value={settings.extraBody}
              onChange={(e) => update({ extraBody: e.target.value })}
              placeholder={'{\n  "temperature": 0.2\n}'}
              rows={4}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!extraBody.ok}
              aria-describedby={!extraBody.ok ? extraBodyErrorId : undefined}
              className="max-h-56 font-mono md:text-xs"
            />
            {!extraBody.ok && <FieldError id={extraBodyErrorId}>{extraBody.error}</FieldError>}
            <Hint>
              送信する JSON
              ボディにマージします（同じキーは追加ボディが優先）。空欄なら何もしません。
            </Hint>
          </Field>
        )}

        {isChat && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={lastOnlyId}>最後のメッセージのみ送信</FieldLabel>
              <Hint>
                messages を最後の 1
                件に絞って送ります。サーバー側で会話履歴を持つバックエンド向けです。
              </Hint>
            </FieldContent>
            <Switch
              id={lastOnlyId}
              checked={settings.sendLastMessageOnly}
              onCheckedChange={(checked) => update({ sendLastMessageOnly: checked })}
              className="mt-0.5"
            />
          </Field>
        )}

        {mode === 'chat-ui' && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={autoSendId}>ツール出力・承認が揃ったら自動再送</FieldLabel>
              <Hint>
                ツールの出力や承認応答がすべて揃った時点で、自動的に次のリクエストを送ります。
              </Hint>
            </FieldContent>
            <Switch
              id={autoSendId}
              checked={settings.autoSendAfterToolOutput}
              onCheckedChange={(checked) => update({ autoSendAfterToolOutput: checked })}
              className="mt-0.5"
            />
          </Field>
        )}

        {mode === 'completion' && (
          <Field>
            <FieldLabel htmlFor={protocolId}>Completion のプロトコル</FieldLabel>
            <Select
              value={settings.completionProtocol}
              onValueChange={(value) => {
                if (isCompletionProtocol(value)) update({ completionProtocol: value })
              }}
            >
              <SelectTrigger id={protocolId} className="w-full">
                <SelectValue>{settings.completionProtocol}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {COMPLETION_PROTOCOL_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    <OptionLabel name={option} description={COMPLETION_PROTOCOL_SHORT[option]} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Hint>{COMPLETION_PROTOCOL_HINTS[settings.completionProtocol]}</Hint>
          </Field>
        )}
      </FieldGroup>
    </SettingsSection>
  )
}
