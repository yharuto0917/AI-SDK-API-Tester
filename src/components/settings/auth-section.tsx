import { useId, useState } from 'react'
import { EyeIcon, EyeOffIcon, KeyRoundIcon } from 'lucide-react'
import { isAuthorizationHeader } from '@/components/settings/header-validation'
import { Hint, SettingsSection } from '@/components/settings/settings-section'
import { Field, FieldLabel } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { useSettings } from '@/hooks/use-settings'

export function AuthSection() {
  const { settings, update } = useSettings()
  const [visible, setVisible] = useState(false)
  const tokenId = useId()

  // 明示的な Authorization ヘッダーがあるとトークンは使われない（request-shaper の仕様）
  const overridden =
    settings.bearerToken.trim() !== '' &&
    settings.headers.some((h) => h.enabled && h.name.trim() !== '' && isAuthorizationHeader(h.name))

  return (
    <SettingsSection title="認証" icon={KeyRoundIcon}>
      <Field>
        <FieldLabel htmlFor={tokenId}>Bearer トークン</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id={tokenId}
            type={visible ? 'text' : 'password'}
            value={settings.bearerToken}
            onChange={(e) => update({ bearerToken: e.target.value })}
            placeholder="トークンを入力"
            // パスワードマネージャーにトークンを保存・自動入力させない
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            className="font-mono"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="トークンを表示"
              aria-pressed={visible}
              title={visible ? 'トークンを隠す' : 'トークンを表示'}
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <Hint>
          Authorization: Bearer として送信します。sessionStorage
          にのみ保存され、タブを閉じると消えます。
        </Hint>
        {overridden ? (
          <Hint className="text-amber-700 dark:text-amber-300">
            有効な Authorization ヘッダーが指定されているため、このトークンは使われません。
          </Hint>
        ) : (
          <Hint>追加ヘッダーに Authorization がある場合は、そちらが優先されます。</Hint>
        )}
      </Field>
    </SettingsSection>
  )
}
