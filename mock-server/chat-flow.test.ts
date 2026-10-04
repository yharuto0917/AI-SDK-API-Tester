/**
 * useChat の中身（AbstractChat）をそのまま使い、複数リクエストにまたがるフローをモックに対して通す。
 * チャンク単位の検証は app.test.ts が担当し、ここでは「メッセージが二重にならない」「自動再送が回る」
 * といったクライアント状態機械との噛み合わせを確かめる。
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Chat } from '@ai-sdk/react'
import {
  DefaultChatTransport,
  isTextUIPart,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockServer, type MockLogEntry } from './app.ts'

interface Started {
  url: string
  logs: MockLogEntry[]
  close: () => Promise<void>
}

const started: Started[] = []

async function startServer(delayScale: number): Promise<Started> {
  const logs: MockLogEntry[] = []
  const server: Server = createMockServer({ delayScale, onLog: (entry) => logs.push(entry) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const instance: Started = {
    url: `http://127.0.0.1:${port}`,
    logs,
    close: () => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
  started.push(instance)
  return instance
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.close()))
})

function newChat(
  url: string,
  sendAutomaticallyWhen?: (options: { messages: UIMessage[] }) => boolean | PromiseLike<boolean>,
) {
  return new Chat<UIMessage>({
    transport: new DefaultChatTransport({ api: `${url}/api/chat` }),
    ...(sendAutomaticallyWhen === undefined ? {} : { sendAutomaticallyWhen }),
  })
}

const textOf = (message: UIMessage | undefined) =>
  (message?.parts ?? [])
    .filter(isTextUIPart)
    .map((p) => p.text)
    .join('')

describe('useChat 相当（Chat）とのフロー', () => {
  it('text: ユーザー発言と assistant 応答が 1 件ずつ並ぶ', async () => {
    const { url } = await startServer(0)
    const chat = newChat(url)
    await chat.sendMessage({ text: 'こんにちは' })
    expect(chat.status).toBe('ready')
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(textOf(chat.messages[1])).toContain('「こんにちは」')

    // 2 往復目でも履歴が全部送られ、応答が 1 件ずつ増える
    await chat.sendMessage({ text: '#echo' })
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(textOf(chat.messages[3])).toContain('**messages**: 3 件')
  })

  it('client-tool: addToolOutput で自動再送され、assistant メッセージが二重にならない', async () => {
    const { url } = await startServer(0)
    const chat = newChat(url, lastAssistantMessageIsCompleteWithToolCalls)

    await chat.sendMessage({ text: '#client-tool' })
    expect(chat.messages).toHaveLength(2)
    const assistantId = chat.messages[1]?.id
    const tool = chat.messages[1]?.parts.filter(isToolUIPart)[0]
    expect(tool?.state).toBe('input-available')

    await chat.addToolOutput({
      tool: 'askForConfirmation',
      toolCallId: tool?.toolCallId ?? '',
      output: { confirmed: true },
    })
    await vi.waitFor(() => expect(textOf(chat.messages.at(-1))).toContain('confirmed'), {
      timeout: 3000,
    })
    await vi.waitFor(() => expect(chat.status).toBe('ready'))

    // 継続は同じ assistant メッセージに追記される（新しい messageId で別メッセージにならない）
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[1]?.id).toBe(assistantId)
    expect(chat.messages[1]?.parts.filter(isToolUIPart)[0]?.state).toBe('output-available')
  })

  it('approval: 承認すると自動再送され、同じメッセージにツール出力と本文が続く', async () => {
    const { url } = await startServer(0)
    const chat = newChat(url, lastAssistantMessageIsCompleteWithApprovalResponses)

    await chat.sendMessage({ text: '#approval' })
    expect(chat.messages).toHaveLength(2)
    const assistantId = chat.messages[1]?.id
    const tool = chat.messages[1]?.parts.filter(isToolUIPart)[0]
    expect(tool?.state).toBe('approval-requested')

    await chat.addToolApprovalResponse({ id: tool?.approval?.id ?? '', approved: true })
    await vi.waitFor(() => expect(textOf(chat.messages.at(-1))).toContain('削除しました'), {
      timeout: 3000,
    })
    await vi.waitFor(() => expect(chat.status).toBe('ready'))

    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[1]?.id).toBe(assistantId)
    const finalTool = chat.messages[1]?.parts.filter(isToolUIPart)[0]
    expect(finalTool?.state).toBe('output-available')
    expect(finalTool?.output).toMatchObject({ deleted: true })
  })

  it('approval: 拒否すると output-denied になり、本文が続く', async () => {
    const { url } = await startServer(0)
    const chat = newChat(url, lastAssistantMessageIsCompleteWithApprovalResponses)

    await chat.sendMessage({ text: '#approval' })
    const tool = chat.messages[1]?.parts.filter(isToolUIPart)[0]
    await chat.addToolApprovalResponse({
      id: tool?.approval?.id ?? '',
      approved: false,
      reason: 'テスト',
    })
    await vi.waitFor(() => expect(textOf(chat.messages.at(-1))).toContain('拒否'), {
      timeout: 3000,
    })
    await vi.waitFor(() => expect(chat.status).toBe('ready'))
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[1]?.parts.filter(isToolUIPart)[0]?.state).toBe('output-denied')
  })

  it('error: 途中まで本文が残り、status は error になる', async () => {
    const { url } = await startServer(0)
    const errors: Error[] = []
    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({ api: `${url}/api/chat` }),
      onError: (error) => errors.push(error),
    })
    await chat.sendMessage({ text: '#error' })
    expect(chat.status).toBe('error')
    expect(errors[0]?.message).toContain('ストリームの途中で失敗しました')
    expect(textOf(chat.messages.at(-1))).toContain('ここまでは')
  })

  it('http-500 / http-401: status は error になり、サーバーのエラー本文がメッセージに入る', async () => {
    const { url } = await startServer(0)
    for (const [scenario, expected] of [
      ['#http-500', 'internal_server_error'],
      ['#http-401', 'unauthorized'],
    ] as const) {
      const chat = newChat(url)
      await chat.sendMessage({ text: scenario })
      expect(chat.status, scenario).toBe('error')
      expect(chat.error?.message, scenario).toContain(expected)
    }
  })

  it('slow: stop() で止めると本文は途中まで残り、サーバーも停止を検知する', async () => {
    const mock = await startServer(1)
    const chat = newChat(mock.url)

    const sending = chat.sendMessage({ text: '#slow' })
    await vi.waitFor(() => expect(textOf(chat.messages.at(-1))).toContain('トークン1'), {
      timeout: 3000,
    })
    await chat.stop()
    await sending

    expect(chat.status).toBe('ready')
    const text = textOf(chat.messages.at(-1))
    expect(text).toContain('トークン1')
    expect(text).not.toContain('トークン20')
    await vi.waitFor(
      () => expect(mock.logs[0]).toMatchObject({ scenario: 'slow', outcome: 'client-closed' }),
      {
        timeout: 2000,
      },
    )
  })

  it('bad-json: クライアントはパースエラーで失敗する', async () => {
    const { url } = await startServer(0)
    const chat = newChat(url)
    await chat.sendMessage({ text: '#bad-json' })
    expect(chat.status).toBe('error')
  })

  it('abort: 途中切断でも status が error で確定する', async () => {
    const { url } = await startServer(0)
    const chat = newChat(url)
    await chat.sendMessage({ text: '#abort' })
    expect(chat.status).toBe('error')
  })
})
