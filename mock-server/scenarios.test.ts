import { describe, expect, it } from 'vitest'
import {
  CHAT_SCENARIOS,
  SIMPLE_SCENARIOS,
  buildEchoMarkdown,
  readMessages,
  readUserText,
  selectScenario,
  simpleOutcomeToPlan,
  splitWords,
  type ScenarioContext,
} from './scenarios.ts'

function context(overrides: Partial<ScenarioContext> = {}): ScenarioContext {
  return {
    method: 'POST',
    path: '/api/chat',
    url: '/api/chat',
    query: new URLSearchParams(),
    headers: {},
    rawBody: '',
    body: undefined,
    messages: [],
    userText: '',
    ...overrides,
  }
}

describe('splitWords', () => {
  it.each([
    '日本語の文章を単語ごとに分けます。',
    'English words are split by spaces.',
    'こんにちは Hello  世界\n\n# 見出し\n\n- 項目 1\n- 項目 2\n\n```ts\n  const x = 1\n```\n',
    '',
  ])('連結すると元の文字列に戻る: %j', (text) => {
    expect(splitWords(text).join('')).toBe(text)
  })

  it('空白は直前の単語に付き、空白だけのチャンクは作らない', () => {
    const words = splitWords('Hello world  again')
    expect(words).toEqual(['Hello ', 'world  ', 'again'])
    expect(words.every((w) => w.trim() !== '')).toBe(true)
  })
})

describe('readMessages / readUserText', () => {
  it('parts 形式のメッセージを読む', () => {
    const messages = readMessages({
      messages: [
        {
          id: 'a',
          role: 'user',
          parts: [
            { type: 'text', text: '前半' },
            { type: 'text', text: '後半' },
          ],
        },
        { id: 'b', role: 'assistant', parts: [{ type: 'text', text: '返答' }] },
      ],
    })
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(readUserText(undefined, messages)).toBe('前半後半')
  })

  it('旧形式（content 文字列）も読める', () => {
    const messages = readMessages({ messages: [{ role: 'user', content: '旧形式' }] })
    expect(readUserText(undefined, messages)).toBe('旧形式')
  })

  it('壊れた入力は無視する', () => {
    expect(readMessages(undefined)).toEqual([])
    expect(readMessages({ messages: 'x' })).toEqual([])
    expect(readMessages({ messages: [null, 1, { role: 1 }, { role: 'user' }] })).toHaveLength(1)
  })

  it('メッセージがなければ prompt を使う', () => {
    expect(readUserText({ prompt: 'プロンプト' }, [])).toBe('プロンプト')
    expect(readUserText({}, [])).toBe('')
  })
})

describe('selectScenario', () => {
  const scenarios = [{ name: 'text' }, { name: 'slow' }, { name: 'echo' }]
  const base = {
    scenarios,
    defaultName: 'text',
    body: undefined,
    query: new URLSearchParams(),
    userText: '',
  }

  it('何も指定がなければ既定', () => {
    expect(selectScenario(base)).toMatchObject({
      ok: true,
      source: 'default',
      scenario: { name: 'text' },
    })
  })

  it('body.scenario が最優先', () => {
    const result = selectScenario({
      ...base,
      body: { scenario: 'echo' },
      query: new URLSearchParams('scenario=slow'),
      userText: '#text hi',
    })
    expect(result).toMatchObject({ ok: true, source: 'body', scenario: { name: 'echo' } })
  })

  it('次に ?scenario=、最後に #名前', () => {
    expect(
      selectScenario({
        ...base,
        query: new URLSearchParams('scenario=slow'),
        userText: '#echo hi',
      }),
    ).toMatchObject({ source: 'query', scenario: { name: 'slow' } })
    expect(selectScenario({ ...base, userText: '#echo hi there' })).toMatchObject({
      source: 'token',
      scenario: { name: 'echo' },
      userText: 'hi there',
    })
  })

  it('#名前 だけの本文でも選べる（残りの本文は空）', () => {
    expect(selectScenario({ ...base, userText: '#slow' })).toMatchObject({
      source: 'token',
      scenario: { name: 'slow' },
      userText: '',
    })
  })

  it('# が先頭でなければトークンとして扱わない', () => {
    expect(selectScenario({ ...base, userText: 'これは #echo ではない' })).toMatchObject({
      source: 'default',
    })
  })

  it('明示した未知の名前はエラー、未知の #トークンは既定にフォールバック', () => {
    expect(selectScenario({ ...base, body: { scenario: 'nope' } })).toEqual({
      ok: false,
      requested: 'nope',
      source: 'body',
    })
    expect(selectScenario({ ...base, query: new URLSearchParams('scenario=nope') })).toEqual({
      ok: false,
      requested: 'nope',
      source: 'query',
    })
    expect(selectScenario({ ...base, userText: '#nope hi' })).toMatchObject({
      ok: true,
      source: 'default',
      userText: '#nope hi',
    })
  })

  it('body.scenario が空文字や文字列以外なら無視する', () => {
    expect(selectScenario({ ...base, body: { scenario: '' } })).toMatchObject({ source: 'default' })
    expect(selectScenario({ ...base, body: { scenario: 1 } })).toMatchObject({ source: 'default' })
  })
})

describe('シナリオ定義', () => {
  it('名前は一意で、すべて説明がある', () => {
    for (const list of [CHAT_SCENARIOS, SIMPLE_SCENARIOS]) {
      const names = list.map((s) => s.name)
      expect(new Set(names).size).toBe(names.length)
      for (const scenario of list) expect(scenario.description, scenario.name).not.toBe('')
    }
  })

  it('チャットの全シナリオが空のコンテキストでもプランを作れる', () => {
    for (const scenario of CHAT_SCENARIOS) {
      const plan = scenario.build(context())
      expect(['sse', 'json'], scenario.name).toContain(plan.format)
    }
  })

  it('テキストのみの全シナリオが、text / sse の両方に変換できる', () => {
    for (const scenario of SIMPLE_SCENARIOS) {
      const outcome = scenario.build(context({ path: '/api/text', userText: 'hi' }))
      expect(simpleOutcomeToPlan(outcome, 'text').format, scenario.name).toBe(
        outcome.format === 'json' ? 'json' : 'text',
      )
      expect(simpleOutcomeToPlan(outcome, 'sse').format, scenario.name).toBe(
        outcome.format === 'json' ? 'json' : 'sse',
      )
    }
  })

  it('simpleOutcomeToPlan: 失敗シナリオは SSE ではエラーチャンク、テキストでは切断になる', () => {
    const outcome = SIMPLE_SCENARIOS.find((s) => s.name === 'error')?.build(context())
    expect(outcome?.format).toBe('pieces')
    if (outcome === undefined) return

    const sse = simpleOutcomeToPlan(outcome, 'sse')
    expect(sse.format === 'sse' && sse.steps.at(-1)).toMatchObject({ chunk: { type: 'error' } })

    const text = simpleOutcomeToPlan(outcome, 'text')
    expect(text.format === 'text' && text.steps.at(-1)).toMatchObject({ destroy: true })
  })

  it('各シナリオの重要な形（no-header / no-done / http-*）', () => {
    const build = (name: string) => CHAT_SCENARIOS.find((s) => s.name === name)?.build(context())
    expect(build('no-header')).toMatchObject({ format: 'sse', omitStreamHeader: true })
    expect(build('no-done')).toMatchObject({ format: 'sse', omitDone: true })
    expect(build('http-500')).toMatchObject({ format: 'json', status: 500 })
    expect(build('http-401')).toMatchObject({ format: 'json', status: 401 })
    expect(build('auth')).toMatchObject({ format: 'json', status: 401 })
  })
})

describe('buildEchoMarkdown', () => {
  it('メソッド・URL・ヘッダー・body を含み、hop-by-hop ヘッダーは含まない', () => {
    const text = buildEchoMarkdown(
      context({
        url: '/api/chat?x=1',
        headers: { authorization: 'Bearer abc', connection: 'keep-alive', 'x-foo': 'bar' },
        rawBody: '{"messages":[],"extra":1}',
        body: { messages: [], extra: 1, trigger: 'submit-message' },
      }),
    )
    expect(text).toContain('**メソッド**: POST')
    expect(text).toContain('/api/chat?x=1')
    expect(text).toContain('"authorization": "Bearer abc"')
    expect(text).toContain('"x-foo": "bar"')
    expect(text).not.toContain('keep-alive')
    expect(text).toContain('追加ボディキー**: extra')
  })

  it('body がなければその旨を示し、JSON でない body は生のまま出す', () => {
    expect(buildEchoMarkdown(context())).toContain('(なし)')
    expect(buildEchoMarkdown(context({ rawBody: 'not json' }))).toContain('not json')
  })

  it('巨大な body は省略する', () => {
    const big = 'x'.repeat(20_000)
    const text = buildEchoMarkdown(context({ rawBody: big }))
    expect(text.length).toBeLessThan(10_000)
    expect(text).toContain('文字省略')
  })
})
