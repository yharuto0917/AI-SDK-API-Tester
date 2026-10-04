import { useEffect, useId, useRef } from 'react'
import { ListPlusIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react'
import {
  validateHeaderName,
  validateHeaderValue,
  warnHeaderName,
} from '@/components/settings/header-validation'
import { Hint, SettingsSection } from '@/components/settings/settings-section'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useSettings } from '@/hooks/use-settings'
import { newHeaderEntry } from '@/lib/settings'
import type { HeaderEntry } from '@/types'

interface HeaderRowProps {
  entry: HeaderEntry
  index: number
  onChange: (id: string, patch: Partial<Omit<HeaderEntry, 'id'>>) => void
  onRemove: (id: string) => void
}

function HeaderRow({ entry, index, onChange, onRemove }: HeaderRowProps) {
  const errorId = useId()
  const warningId = useId()
  const position = index + 1
  // 無効な行は送信されず検証もされないので、有効なときだけエラーを出す
  const nameError = entry.enabled ? validateHeaderName(entry.name) : null
  const valueError = entry.enabled ? validateHeaderValue(entry.value) : null
  const hasError = nameError !== null || valueError !== null
  // 警告はエラーとは別枠（入力は妨げない）。無効な行は送信されないので、有効なときだけ出す
  const nameWarning = entry.enabled ? warnHeaderName(entry.name, entry.value) : null
  const nameDescribedBy =
    [hasError ? errorId : null, nameWarning !== null ? warningId : null]
      .filter((id) => id !== null)
      .join(' ') || undefined

  return (
    <li
      data-header-id={entry.id}
      className="flex flex-col gap-1.5 rounded-lg border bg-card p-2 text-card-foreground"
    >
      <div className="flex items-center gap-2">
        <Switch
          size="sm"
          checked={entry.enabled}
          onCheckedChange={(enabled) => onChange(entry.id, { enabled })}
          aria-label={`ヘッダー ${position} を有効にする`}
        />
        <Input
          data-header-name
          value={entry.name}
          onChange={(e) => onChange(entry.id, { name: e.target.value })}
          placeholder="ヘッダー名"
          aria-label={`ヘッダー ${position} の名前`}
          aria-invalid={nameError !== null}
          aria-describedby={nameDescribedBy}
          autoComplete="off"
          spellCheck={false}
          className="h-7 font-mono"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`ヘッダー ${position} を削除`}
          onClick={() => onRemove(entry.id)}
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </div>
      <Input
        value={entry.value}
        onChange={(e) => onChange(entry.id, { value: e.target.value })}
        placeholder="値"
        aria-label={`ヘッダー ${position} の値`}
        aria-invalid={valueError !== null}
        aria-describedby={hasError ? errorId : undefined}
        autoComplete="off"
        spellCheck={false}
        className="h-7 font-mono"
      />
      {hasError && (
        <FieldError id={errorId} className="text-xs">
          {nameError ?? valueError}
        </FieldError>
      )}
      {nameWarning !== null && (
        // role を付けない（alert はエラー専用）。名前欄の aria-describedby から読み上げられる
        <p
          id={warningId}
          className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="sr-only">警告: </span>
            {nameWarning}
          </span>
        </p>
      )}
    </li>
  )
}

export function HeadersSection() {
  const { settings, update } = useSettings()
  const { headers } = settings
  const listRef = useRef<HTMLUListElement>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  // 追加した行の名前欄へフォーカスを移すための ID。描画に影響しないので state ではなく ref で持つ
  const pendingFocusId = useRef<string | null>(null)

  useEffect(() => {
    const id = pendingFocusId.current
    if (id === null) return
    pendingFocusId.current = null
    const row = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('[data-header-id]') ?? []),
    ].find((el) => el.dataset.headerId === id)
    row?.querySelector<HTMLInputElement>('[data-header-name]')?.focus()
  }, [headers])

  function addHeader(): void {
    const entry = newHeaderEntry()
    // 再描画より先に控えておく（外部ストア経由の更新が同期的に描画されても取りこぼさない）
    pendingFocusId.current = entry.id
    update((prev) => ({ ...prev, headers: [...prev.headers, entry] }))
  }

  function changeHeader(id: string, patch: Partial<Omit<HeaderEntry, 'id'>>): void {
    update((prev) => ({
      ...prev,
      headers: prev.headers.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    }))
  }

  function removeHeader(id: string): void {
    update((prev) => ({ ...prev, headers: prev.headers.filter((h) => h.id !== id) }))
    // 削除した行にフォーカスがあったので、行き先を失わないよう「追加」ボタンへ戻す
    addButtonRef.current?.focus()
  }

  return (
    <SettingsSection
      title="追加ヘッダー"
      icon={ListPlusIcon}
      description="有効にした行だけ送信します。"
    >
      {headers.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          追加ヘッダーはありません
        </p>
      ) : (
        <ul ref={listRef} aria-label="追加ヘッダー" className="flex flex-col gap-2">
          {headers.map((entry, index) => (
            <HeaderRow
              key={entry.id}
              entry={entry}
              index={index}
              onChange={changeHeader}
              onRemove={removeHeader}
            />
          ))}
        </ul>
      )}
      <Button ref={addButtonRef} type="button" variant="outline" size="sm" onClick={addHeader}>
        <PlusIcon aria-hidden="true" />
        追加
      </Button>
      <Hint>
        Authorization や x-api-key など認証情報を含むヘッダーは、インスペクタと cURL
        ではマスクして表示されます（送信される値はそのままです）。
      </Hint>
    </SettingsSection>
  )
}
