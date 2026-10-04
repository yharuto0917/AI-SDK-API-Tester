import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  CHAT_STATUS_META,
  CHAT_TEXT_SCENARIOS,
  CHAT_UI_SCENARIOS,
  TONE_BADGE_CLASS,
  buildRenderItems,
  classifyPart,
  describeChatError,
  describeParsedOutput,
  hasPendingContinuation,
  hasStaleApprovalResponse,
  isChatBusy,
  isPartStreaming,
  isToolPartStreaming,
  messageText,
  messagesToDisplayJson,
  needsManualOutput,
  parseToolOutputText,
  safeExternalHref,
  safeJson,
  scenarioPrompt,
  scenariosFor,
  toolDisplayName,
  toolStateMeta,
  unknownPartType,
} from '@/components/chat/chat-utils'
import type { ToolPart } from '@/components/chat/chat-utils'

function toolPart(over: Record<string, unknown>): ToolPart {
  return {
    type: 'tool-getWeather',
    toolCallId: 'call_1',
    state: 'input-available',
    input: { city: 'Tokyo' },
    ...over,
  } as ToolPart
}

describe('toolStateMeta', () => {
  it('すべての状態に日本語ラベルと色を割り当てる', () => {
    expect(toolStateMeta('input-streaming')).toEqual({ label: '入力受信中', tone: 'info' })
    expect(toolStateMeta('input-available')).toEqual({ label: '出力待ち', tone: 'warning' })
    expect(toolStateMeta('approval-requested')).toEqual({ label: '承認待ち', tone: 'warning' })
    expect(toolStateMeta('output-available')).toEqual({ label: '完了', tone: 'success' })
    expect(toolStateMeta('output-error')).toEqual({ label: 'エラー', tone: 'danger' })
    expect(toolStateMeta('output-denied')).toEqual({ label: '実行拒否', tone: 'muted' })
  })

  it('approval-responded は承認 / 拒否で表示が変わる', () => {
    expect(toolStateMeta('approval-responded', true).label).toBe('承認済み')
    expect(toolStateMeta('approval-responded', false).label).toBe('拒否済み')
    expect(toolStateMeta('approval-responded').label).toBe('応答済み')
  })

  it('未知の状態でも落とさず、状態名をそのまま見せる', () => {
    expect(toolStateMeta('something-new')).toEqual({ label: 'something-new', tone: 'muted' })
    expect(toolStateMeta('').label).toBe('(状態なし)')
  })

  it('色クラスはライト / ダークの両方を持つ（emerald / amber / sky は dark: 付き）', () => {
    for (const tone of ['success', 'warning', 'info'] as const) {
      expect(TONE_BADGE_CLASS[tone]).toMatch(/dark:/)
    }
    expect(TONE_BADGE_CLASS.danger).toContain('text-destructive')
  })
})

describe('CHAT_STATUS_META / isChatBusy', () => {
  it('4 つの状態に日本語ラベルがある', () => {
    expect(CHAT_STATUS_META.ready.label).toBe('待機中')
    expect(CHAT_STATUS_META.submitted.label).toBe('送信中')
    expect(CHAT_STATUS_META.streaming.label).toBe('受信中')
    expect(CHAT_STATUS_META.error.label).toBe('エラー')
  })

  it('submitted / streaming だけが生成中', () => {
    expect(isChatBusy('submitted')).toBe(true)
    expect(isChatBusy('streaming')).toBe(true)
    expect(isChatBusy('ready')).toBe(false)
    expect(isChatBusy('error')).toBe(false)
  })
})

describe('needsManualOutput', () => {
  it('入力確定済みでプロバイダー実行ではないツールだけが対象', () => {
    expect(needsManualOutput(toolPart({}))).toBe(true)
    expect(needsManualOutput(toolPart({ providerExecuted: true }))).toBe(false)
    expect(needsManualOutput(toolPart({ state: 'input-streaming' }))).toBe(false)
    expect(needsManualOutput(toolPart({ state: 'output-available', output: 1 }))).toBe(false)
    expect(needsManualOutput(toolPart({ state: 'approval-requested' }))).toBe(false)
  })

  it('dynamic-tool も同じ判定になる', () => {
    expect(
      needsManualOutput({
        type: 'dynamic-tool',
        toolName: 'x',
        toolCallId: 'c',
        state: 'input-available',
        input: {},
      }),
    ).toBe(true)
  })
})

describe('toolDisplayName', () => {
  it('静的ツールは type から、dynamic-tool は toolName から、title があれば title を使う', () => {
    expect(toolDisplayName(toolPart({}))).toBe('getWeather')
    expect(toolDisplayName(toolPart({ type: 'tool-my-tool-2' }))).toBe('my-tool-2')
    expect(
      toolDisplayName({
        type: 'dynamic-tool',
        toolName: 'search',
        toolCallId: 'c',
        state: 'input-available',
        input: {},
      }),
    ).toBe('search')
    expect(toolDisplayName(toolPart({ title: '天気' }))).toBe('天気')
  })
})

describe('parseToolOutputText', () => {
  it('JSON として解釈できれば JSON 値、できなければ文字列', () => {
    expect(parseToolOutputText('{"ok": true}')).toEqual({
      kind: 'json',
      value: { ok: true },
      jsonType: 'object',
    })
    expect(parseToolOutputText('[1,2]')).toMatchObject({ kind: 'json', jsonType: 'array' })
    expect(parseToolOutputText('42')).toMatchObject({ kind: 'json', value: 42, jsonType: 'number' })
    expect(parseToolOutputText('true')).toMatchObject({ kind: 'json', jsonType: 'boolean' })
    expect(parseToolOutputText('null')).toMatchObject({
      kind: 'json',
      value: null,
      jsonType: 'null',
    })
    expect(parseToolOutputText('"abc"')).toMatchObject({
      kind: 'json',
      value: 'abc',
      jsonType: 'string',
    })
    expect(parseToolOutputText('はい、実行します')).toEqual({
      kind: 'text',
      value: 'はい、実行します',
    })
    expect(parseToolOutputText('{broken')).toEqual({ kind: 'text', value: '{broken' })
  })

  it('空白だけの入力は empty', () => {
    expect(parseToolOutputText('')).toEqual({ kind: 'empty' })
    expect(parseToolOutputText('  \n ')).toEqual({ kind: 'empty' })
  })

  it('解釈結果を日本語で説明する', () => {
    expect(describeParsedOutput(parseToolOutputText(''))).toBe('出力を入力してください')
    expect(describeParsedOutput(parseToolOutputText('{}'))).toBe('JSON（object）として送信します')
    expect(describeParsedOutput(parseToolOutputText('はい'))).toBe('文字列として送信します')
  })
})

describe('classifyPart', () => {
  it('既知のパート型を分類する', () => {
    expect(classifyPart({ type: 'text', text: 'a' })).toBe('text')
    expect(classifyPart({ type: 'reasoning', text: 'a' })).toBe('reasoning')
    expect(classifyPart({ type: 'tool-foo', toolCallId: 'c', state: 'input-available' })).toBe(
      'tool',
    )
    expect(
      classifyPart({ type: 'dynamic-tool', toolName: 'x', toolCallId: 'c', state: 'output-error' }),
    ).toBe('tool')
    expect(classifyPart({ type: 'source-url', sourceId: 's', url: 'https://a' })).toBe('source-url')
    expect(classifyPart({ type: 'source-document', sourceId: 's', title: 't' })).toBe(
      'source-document',
    )
    expect(classifyPart({ type: 'file', url: 'data:,', mediaType: 'text/plain' })).toBe('file')
    expect(classifyPart({ type: 'reasoning-file', url: 'data:,', mediaType: 'text/plain' })).toBe(
      'reasoning-file',
    )
    expect(classifyPart({ type: 'step-start' })).toBe('step-start')
    expect(classifyPart({ type: 'data-weather', data: {} })).toBe('data')
  })

  it('壊れた / 未知のパートは unknown になり、例外を投げない', () => {
    expect(classifyPart(null)).toBe('unknown')
    expect(classifyPart(undefined)).toBe('unknown')
    expect(classifyPart('text')).toBe('unknown')
    expect(classifyPart({})).toBe('unknown')
    expect(classifyPart({ type: 42 })).toBe('unknown')
    expect(classifyPart({ type: 'text' })).toBe('unknown')
    expect(classifyPart({ type: 'tool-foo' })).toBe('unknown')
    expect(classifyPart({ type: 'custom', kind: 'x.y' })).toBe('unknown')
    expect(classifyPart({ type: 'future-part' })).toBe('unknown')
  })

  it('unknownPartType は type が無くても文字列を返す', () => {
    expect(unknownPartType({ type: 'future-part' })).toBe('future-part')
    expect(unknownPartType(null)).toBe('(type なし)')
    expect(unknownPartType({ type: '' })).toBe('(type なし)')
  })
})

describe('buildRenderItems', () => {
  it('source-url / source-document を最初の出現位置の 1 ブロックにまとめる', () => {
    const items = buildRenderItems([
      { type: 'text', text: '参考' },
      { type: 'source-url', sourceId: 'a', url: 'https://a.example' },
      { type: 'text', text: 'つづき' },
      { type: 'source-document', sourceId: 'b', title: '資料' },
      { type: 'source-url', sourceId: 'c', url: 'https://c.example' },
    ])
    expect(items.map((item) => item.kind)).toEqual(['text', 'sources', 'text'])
    const sources = items[1]
    expect(sources?.kind === 'sources' && sources.parts.map((p) => p.sourceId)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('最初のステップより前の step-start は出さず、以降に「ステップ N」を振る', () => {
    const items = buildRenderItems([
      { type: 'step-start' },
      { type: 'text', text: '1' },
      { type: 'step-start' },
      { type: 'text', text: '2' },
      { type: 'step-start' },
      { type: 'text', text: '3' },
    ])
    expect(items.map((item) => item.kind)).toEqual(['text', 'step', 'text', 'step', 'text'])
    const steps = items.flatMap((item) => (item.kind === 'step' ? [item.stepNumber] : []))
    expect(steps).toEqual([2, 3])
  })

  it('先頭に step-start が無いメッセージ（継続）でも最初の区切りは「ステップ 2」', () => {
    const items = buildRenderItems([{ type: 'text', text: 'a' }, { type: 'step-start' }])
    expect(items[1]).toMatchObject({ kind: 'step', stepNumber: 2 })
  })

  it('空のテキストパートは出さない', () => {
    expect(buildRenderItems([{ type: 'text', text: '', state: 'streaming' }])).toEqual([])
  })

  it('未知のパートは unknown アイテムとして残す（落とさない）', () => {
    const items = buildRenderItems([{ type: 'custom', kind: 'x.y' }, { type: 'future-part' }, null])
    expect(items.map((item) => item.kind)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(items.map((item) => (item.kind === 'unknown' ? item.type : ''))).toEqual([
      'custom',
      'future-part',
      '(type なし)',
    ])
  })

  it('key は parts の添字', () => {
    const items = buildRenderItems([
      { type: 'step-start' },
      { type: 'text', text: 'a' },
      { type: 'data-x', data: 1 },
    ])
    expect(items.map((item) => item.key)).toEqual(['1', '2'])
  })
})

describe('isPartStreaming', () => {
  it('最後のメッセージで status が streaming かつ part が streaming のときだけ true', () => {
    const part = { state: 'streaming' }
    expect(isPartStreaming(part, { chatStatus: 'streaming', isLastMessage: true })).toBe(true)
    expect(isPartStreaming(part, { chatStatus: 'ready', isLastMessage: true })).toBe(false)
    expect(isPartStreaming(part, { chatStatus: 'streaming', isLastMessage: false })).toBe(false)
    expect(
      isPartStreaming({ state: 'done' }, { chatStatus: 'streaming', isLastMessage: true }),
    ).toBe(false)
    expect(isPartStreaming({}, { chatStatus: 'streaming', isLastMessage: true })).toBe(false)
  })
})

describe('isToolPartStreaming', () => {
  const streaming = { chatStatus: 'streaming', isLastMessage: true } as const

  it('最後のメッセージの受信中に、入力受信中または暫定出力のツールだけ true', () => {
    expect(isToolPartStreaming({ state: 'input-streaming' }, streaming)).toBe(true)
    expect(isToolPartStreaming({ state: 'output-available', preliminary: true }, streaming)).toBe(
      true,
    )
    expect(isToolPartStreaming({ state: 'input-available' }, streaming)).toBe(false)
    expect(isToolPartStreaming({ state: 'output-available' }, streaming)).toBe(false)
    expect(isToolPartStreaming({ state: 'output-available', preliminary: false }, streaming)).toBe(
      false,
    )
  })

  it('中断後に残った input-streaming や、過去のメッセージは対象にしない', () => {
    const part = { state: 'input-streaming' }
    expect(isToolPartStreaming(part, { chatStatus: 'ready', isLastMessage: true })).toBe(false)
    expect(isToolPartStreaming(part, { chatStatus: 'streaming', isLastMessage: false })).toBe(false)
    expect(isToolPartStreaming(part, { chatStatus: undefined, isLastMessage: false })).toBe(false)
  })
})

describe('messageText', () => {
  it('テキストパートだけを連結する', () => {
    const message: UIMessage = {
      id: 'm',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'こん' },
        { type: 'reasoning', text: '思考' },
        { type: 'text', text: 'にちは' },
      ],
    }
    expect(messageText(message)).toBe('こんにちは')
  })
})

describe('safeJson', () => {
  it('通常の値は整形 JSON にする', () => {
    expect(safeJson({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('undefined / 関数 / BigInt でも例外を投げない', () => {
    expect(safeJson(undefined)).toBe('undefined')
    expect(safeJson(() => 1)).toBe('() => 1')
    expect(safeJson({ n: 10n })).toContain('"10n"')
  })

  it('循環参照でも例外を投げない', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(safeJson(a)).toContain('[Circular]')
  })
})

describe('messagesToDisplayJson', () => {
  it('長い data URL だけを省略する', () => {
    const long = `data:image/png;base64,${'A'.repeat(1000)}`
    const json = messagesToDisplayJson([
      {
        id: '1',
        parts: [
          { type: 'file', url: long },
          { type: 'text', text: 'hi' },
        ],
      },
    ])
    expect(json).toContain('data URL')
    expect(json).toContain('省略')
    expect(json).not.toContain('A'.repeat(300))
    expect(json).toContain('"hi"')
  })

  it('短い data URL はそのまま', () => {
    expect(messagesToDisplayJson([{ url: 'data:text/plain,hi' }])).toContain('data:text/plain,hi')
  })
})

describe('safeExternalHref', () => {
  it('http(s) だけをリンクにする', () => {
    expect(safeExternalHref('https://ai-sdk.dev/docs')).toBe('https://ai-sdk.dev/docs')
    expect(safeExternalHref('http://localhost:3000')).toBe('http://localhost:3000')
    expect(safeExternalHref('javascript:alert(1)')).toBeUndefined()
    expect(safeExternalHref('data:text/html,<b>x</b>')).toBeUndefined()
    expect(safeExternalHref('not a url')).toBeUndefined()
    expect(safeExternalHref('')).toBeUndefined()
  })
})

describe('hasPendingContinuation', () => {
  const clientToolDone: UIMessage[] = [
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        {
          type: 'tool-ask',
          toolCallId: 'c1',
          state: 'output-available',
          input: {},
          output: 'ok',
        } as UIMessage['parts'][number],
      ],
    },
  ]

  it('ツール出力が揃った最後のアシスタントメッセージは再送待ち', () => {
    expect(hasPendingContinuation(clientToolDone)).toBe(true)
  })

  it('出力待ち / テキストだけ / 空 は再送待ちではない', () => {
    const waiting: UIMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        parts: [
          { type: 'tool-ask', toolCallId: 'c1', state: 'input-available', input: {} },
        ] as UIMessage['parts'],
      },
    ]
    expect(hasPendingContinuation(waiting)).toBe(false)
    expect(
      hasPendingContinuation([
        { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'x' }] },
      ]),
    ).toBe(false)
    expect(hasPendingContinuation([])).toBe(false)
  })

  it('承認応答が揃った状態も再送待ち', () => {
    const approved: UIMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        parts: [
          {
            type: 'tool-deleteFile',
            toolCallId: 'c1',
            state: 'approval-responded',
            input: {},
            approval: { id: 'ap1', approved: true },
          },
        ] as UIMessage['parts'],
      },
    ]
    expect(hasPendingContinuation(approved)).toBe(true)
  })
})

describe('hasStaleApprovalResponse', () => {
  const user = (id: string): UIMessage => ({
    id,
    role: 'user',
    parts: [{ type: 'text', text: id }],
  })
  const assistant = (id: string, state: string): UIMessage => ({
    id,
    role: 'assistant',
    parts: [
      { type: 'step-start' },
      { type: 'tool-x', toolCallId: `${id}-c`, state, input: {} },
    ] as UIMessage['parts'],
  })

  it('古いメッセージにだけ approval-responded が残っていると true（SDK が継続先を取り違える）', () => {
    expect(
      hasStaleApprovalResponse([
        user('u1'),
        assistant('a', 'approval-responded'),
        user('u2'),
        assistant('c', 'output-available'),
      ]),
    ).toBe(true)
  })

  it('最後のメッセージ自身が approval-responded を持つなら、継続先は最後なので false', () => {
    expect(
      hasStaleApprovalResponse([
        user('u1'),
        assistant('a', 'approval-responded'),
        user('u2'),
        assistant('c', 'approval-responded'),
      ]),
    ).toBe(false)
    expect(hasStaleApprovalResponse([user('u'), assistant('a', 'approval-responded')])).toBe(false)
  })

  it('approval-responded が無い / 会話が空 / 承認済みでもユーザー発言だけなら false', () => {
    expect(hasStaleApprovalResponse([])).toBe(false)
    expect(hasStaleApprovalResponse([user('u'), assistant('a', 'output-available')])).toBe(false)
    expect(
      hasStaleApprovalResponse([
        assistant('a', 'approval-requested'),
        user('u'),
        assistant('c', 'input-available'),
      ]),
    ).toBe(false)
  })

  it('壊れたパートがあっても例外にしない', () => {
    const broken = {
      id: 'b',
      role: 'assistant',
      parts: [null, { type: 7 }, { type: 'tool-x', state: 'approval-responded' }],
    } as unknown as UIMessage
    expect(hasStaleApprovalResponse([broken, user('u'), assistant('c', 'output-available')])).toBe(
      false,
    )
  })
})

describe('describeChatError', () => {
  it('Error のメッセージを返し、JSON なら整形する', () => {
    expect(describeChatError(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' })
    const info = describeChatError(new Error('{"error":"x","message":"y"}'))
    expect(info.message).toBe('{\n  "error": "x",\n  "message": "y"\n}')
  })

  it('statusCode を持つエラーはステータスも返す', () => {
    const error = Object.assign(new Error('Internal'), { name: 'AI_APICallError', statusCode: 500 })
    expect(describeChatError(error)).toEqual({
      name: 'AI_APICallError',
      message: 'Internal',
      statusCode: 500,
    })
  })

  it('Error 以外・空メッセージでも落とさない', () => {
    expect(describeChatError('文字列').message).toBe('文字列')
    expect(describeChatError(new Error('')).message).toBe('(メッセージなし)')
    expect(describeChatError(undefined).message).toBe('undefined')
  })
})

describe('サジェスト', () => {
  it('chat-ui のシナリオが仕様どおりそろっている', () => {
    expect(CHAT_UI_SCENARIOS.map((s) => s.name)).toEqual([
      'text',
      'markdown',
      'reasoning',
      'tool',
      'tool-error',
      'client-tool',
      'approval',
      'sources',
      'file',
      'data',
      'metadata',
      'echo',
      'slow',
      'error',
    ])
    expect(CHAT_TEXT_SCENARIOS.map((s) => s.name)).toEqual(['text', 'slow', 'echo'])
  })

  it('本文先頭に #name を付けて送る', () => {
    const tool = CHAT_UI_SCENARIOS.find((s) => s.name === 'tool')
    expect(tool).toBeDefined()
    if (tool === undefined) return
    expect(scenarioPrompt(tool)).toBe('#tool 東京の天気を教えて')
  })

  it('モードごとに一覧を切り替える', () => {
    expect(scenariosFor('chat-ui')).toBe(CHAT_UI_SCENARIOS)
    expect(scenariosFor('chat-text')).toBe(CHAT_TEXT_SCENARIOS)
  })
})
