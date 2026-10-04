import { describe, expect, it } from 'vitest'
import { validateUiChunk } from '@/lib/chunk-schema'
import { KNOWN_UI_CHUNK_TYPES } from '@/lib/stream-analyzer'

type Chunk = Record<string, unknown>

/** SDK のスキーマに合う chunk の見本（type ごとに 1 つ。data-* を含む）。 */
const VALID_CHUNKS: Chunk[] = [
  { type: 'start', messageId: 'm1' },
  { type: 'start-step' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'hi' },
  { type: 'text-end', id: 't1' },
  { type: 'reasoning-start', id: 'r1' },
  { type: 'reasoning-delta', id: 'r1', delta: 'hm' },
  { type: 'reasoning-end', id: 'r1' },
  { type: 'reasoning-file', url: 'data:text/plain;base64,aGk=', mediaType: 'text/plain' },
  { type: 'file', url: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
  { type: 'source-url', sourceId: 's1', url: 'https://example.com' },
  { type: 'source-document', sourceId: 's2', mediaType: 'application/pdf', title: '資料' },
  { type: 'custom', kind: 'vendor.thing' },
  { type: 'error', errorText: 'boom' },
  { type: 'tool-input-start', toolCallId: 'c1', toolName: 'w' },
  { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{' },
  { type: 'tool-input-available', toolCallId: 'c1', toolName: 'w', input: { a: 1 } },
  { type: 'tool-input-error', toolCallId: 'c1', toolName: 'w', input: 1, errorText: 'bad' },
  { type: 'tool-approval-request', toolCallId: 'c1', approvalId: 'a1' },
  { type: 'tool-approval-response', approvalId: 'a1', approved: true },
  { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } },
  { type: 'tool-output-error', toolCallId: 'c1', errorText: 'e' },
  { type: 'tool-output-denied', toolCallId: 'c1' },
  { type: 'data-weather', id: 'd1', data: { temp: 20 } },
  { type: 'finish-step' },
  { type: 'reset-step' },
  { type: 'finish', finishReason: 'tool-calls' },
  { type: 'abort', reason: 'user' },
  { type: 'message-metadata', messageMetadata: { a: 1 } },
]

describe('validateUiChunk', () => {
  it.each(VALID_CHUNKS.map((chunk) => [String(chunk.type), chunk] as const))(
    'SDK のスキーマに合う %s は undefined',
    async (_type, chunk) => {
      expect(await validateUiChunk(chunk)).toBeUndefined()
    },
  )

  it('見本は、既知 type（KNOWN_UI_CHUNK_TYPES）と data-* をすべて網羅している', () => {
    const types = new Set(VALID_CHUNKS.map((chunk) => chunk.type))
    for (const known of KNOWN_UI_CHUNK_TYPES) expect(types.has(known), known).toBe(true)
    expect([...types].some((type) => String(type).startsWith('data-'))).toBe(true)
  })

  it('既知 type は、フィールドが足りなくても「未知の type」とは言わない', async () => {
    for (const type of KNOWN_UI_CHUNK_TYPES) {
      const reason = await validateUiChunk({ type })
      expect(reason ?? '', type).not.toContain('UIMessageChunk にありません')
    }
  })

  describe('合わない chunk は、何が違うかを日本語で返す', () => {
    it('v4 の textDelta（delta が無い）', async () => {
      const reason = await validateUiChunk({ type: 'text-delta', id: 't1', textDelta: 'hi' })
      expect(reason).toBe('「delta」がありません（string が必要）')
    })

    it('id の抜け', async () => {
      expect(await validateUiChunk({ type: 'text-delta', delta: 'hi' })).toContain(
        '「id」がありません',
      )
    })

    it('型違い（実際の値の種類を添える）', async () => {
      expect(await validateUiChunk({ type: 'text-delta', id: 5, delta: 'x' })).toBe(
        '「id」が数値 5 です（string が必要）',
      )
      expect(await validateUiChunk({ type: 'text-delta', id: 't', delta: null })).toContain(
        '「delta」が null です',
      )
      expect(await validateUiChunk({ type: 'text-delta', id: 't', delta: ['a'] })).toContain(
        '「delta」が配列です',
      )
      expect(await validateUiChunk({ type: 'text-delta', id: 't', delta: { a: 1 } })).toContain(
        '「delta」がオブジェクトです',
      )
    })

    it('長い文字列の値は短く切って示す', async () => {
      const reason = await validateUiChunk({ type: 'text-delta', id: 'x'.repeat(100), delta: 1 })
      expect(reason).toContain('「delta」が数値 1 です')
      // 値が長い id は問題ではないが、問題のあるフィールドの値が長い場合も 1 行に収まる
      const long = await validateUiChunk({
        type: 'tool-output-error',
        toolCallId: 'c',
        errorText: 'e'.repeat(500),
        dynamic: 'y'.repeat(500),
      })
      expect(long).toContain('「dynamic」が文字列 "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy…" です')
      expect(long?.length).toBeLessThan(200)
    })

    it('finishReason の値違い（使える値を示す）', async () => {
      const reason = await validateUiChunk({ type: 'finish', finishReason: 'tool_calls' })
      expect(reason).toContain('「finishReason」が "tool_calls"')
      expect(reason).toContain('"tool-calls"')
      expect(reason).toContain('"content-filter"')
    })

    it('toolName の抜け', async () => {
      expect(
        await validateUiChunk({ type: 'tool-input-available', toolCallId: 'c1', input: {} }),
      ).toBe('「toolName」がありません（string が必要）')
    })

    it('入れ子のフィールドはパスで示す（providerMetadata の値の型違い）', async () => {
      const reason = await validateUiChunk({
        type: 'text-delta',
        id: 't',
        delta: 'x',
        providerMetadata: { openai: 'not-an-object' },
      })
      expect(reason).toContain('「providerMetadata.openai」')
    })

    it('data-* の id が文字列でない', async () => {
      expect(await validateUiChunk({ type: 'data-weather', id: 3, data: 1 })).toContain(
        '「id」が数値 3 です',
      )
    })

    it('問題が多いときは先頭 3 件だけ示して、残りは件数にする', async () => {
      const reason = await validateUiChunk({
        type: 'tool-input-error',
        input: 1,
        providerExecuted: 'yes',
        dynamic: 'no',
      })
      // toolCallId / toolName / errorText の抜けと、providerExecuted / dynamic の型違いで 5 件
      expect(reason?.split(' / ')).toHaveLength(4)
      expect(reason).toContain('…ほか 2 件')
    })

    it('unknown 型のフィールド（input など）も SDK は必須として扱う。型名ではなく「必須です」と示す', async () => {
      // zod 4 は z.unknown() の項目が無いと expected が 'nonoptional' になる。JSON.stringify は undefined を落とすので、
      // 引数の無いツールの input: undefined がこの形で届きうる
      const reason = await validateUiChunk({
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'w',
      })
      expect(reason).toBe('「input」がありません（必須です）')
    })
  })

  describe('スキーマ以前の問題', () => {
    it('未知の type', async () => {
      expect(await validateUiChunk({ type: 'text-chunk', id: 't1' })).toBe(
        'type「text-chunk」は UIMessageChunk にありません',
      )
    })

    it('data- で始まらない近い名前も未知の type', async () => {
      expect(await validateUiChunk({ type: 'data', data: 1 })).toContain(
        'UIMessageChunk にありません',
      )
    })

    it('type が文字列ではない', async () => {
      expect(await validateUiChunk({ type: 1 })).toBe('「type」が文字列ではありません')
      expect(await validateUiChunk({ id: 't1' })).toBe('「type」が文字列ではありません')
    })

    it.each([[[1, 2]], ['hello'], [42], [null], [true]])(
      'JSON オブジェクトではない値 %j',
      async (value) => {
        expect(await validateUiChunk(value)).toBe(
          'JSON オブジェクトではないため、UIMessageChunk として解釈できません',
        )
      },
    )
  })

  describe('SDK（DefaultChatTransport）の実際の判定と一致する', () => {
    /** 本物のトランスポートに chunk 1 つを SSE で流し、SDK がスキーマ検証で打ち切るか。 */
    async function sdkRejects(chunk: unknown): Promise<boolean> {
      const { DefaultChatTransport } = await import('ai')
      const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
      const transport = new DefaultChatTransport({
        api: 'http://localhost/api/chat',
        fetch: async () =>
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      })
      const stream = await transport.sendMessages({
        chatId: 'c1',
        messages: [],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })
      const reader = stream.getReader()
      try {
        for (;;) {
          const { done } = await reader.read()
          if (done) return false
        }
      } catch (error) {
        return error instanceof Error && error.name === 'AI_TypeValidationError'
      }
    }

    it('決まった例（見本と、そこから 1 か所だけ壊したもの）', async () => {
      for (const chunk of VALID_CHUNKS) {
        expect(await sdkRejects(chunk), JSON.stringify(chunk)).toBe(false)
        const reason = await validateUiChunk(chunk)
        expect(reason, JSON.stringify(chunk)).toBeUndefined()
      }
      for (const bad of [
        { type: 'text-delta', id: 't1', textDelta: 'hi' },
        { type: 'finish', finishReason: 'tool_calls' },
        { type: 'tool-input-available', toolCallId: 'c1', input: {} },
        { type: 'mystery' },
        { type: 'data-x', id: 1 },
      ]) {
        expect(await sdkRejects(bad), JSON.stringify(bad)).toBe(true)
        expect(await validateUiChunk(bad), JSON.stringify(bad)).toBeDefined()
      }
    })

    it('乱択で壊した chunk（フィールドの削除・型違い・名前違い）でも、SDK が通す/落とすと一致する', async () => {
      let seed = 20260104
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296
        return seed / 4294967296
      }
      const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T
      const WRONG = [0, 1, null, true, 'x', ['x'], { x: 1 }, 'tool_calls', 'stop']
      let rejected = 0
      let accepted = 0
      const mismatches: string[] = []
      for (let n = 0; n < 500; n++) {
        const chunk: Chunk = { ...pick(VALID_CHUNKS) }
        const keys = Object.keys(chunk).filter((key) => key !== 'type')
        const mutation = pick(['none', 'delete', 'wrong', 'rename', 'extra', 'type'] as const)
        const key = keys.length > 0 ? pick(keys) : undefined
        if (mutation === 'delete' && key !== undefined) delete chunk[key]
        else if (mutation === 'wrong' && key !== undefined) chunk[key] = pick(WRONG)
        else if (mutation === 'rename' && key !== undefined) {
          chunk[`${key}X`] = chunk[key]
          delete chunk[key]
        } else if (mutation === 'extra') chunk.unexpectedField = pick(WRONG)
        else if (mutation === 'type') chunk.type = pick(['data-', 'data-a', 'dat', 'Start', '', 7])

        const sdk = await sdkRejects(chunk)
        const ours = (await validateUiChunk(chunk)) !== undefined
        if (sdk) rejected++
        else accepted++
        if (sdk !== ours) mismatches.push(`sdk=${sdk} ours=${ours}: ${JSON.stringify(chunk)}`)
      }
      // どちらか一方しか確かめていない、という状態を防ぐ
      expect(rejected).toBeGreaterThan(100)
      expect(accepted).toBeGreaterThan(100)
      expect(mismatches).toEqual([])
    })
  })
})
