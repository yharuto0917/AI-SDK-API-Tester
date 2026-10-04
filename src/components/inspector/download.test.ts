// @vitest-environment jsdom
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadTextFile } from '@/components/inspector/download'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function stubUrlApi(
  opts: { create?: (blob: Blob) => string; revoke?: (url: string) => void } = {},
) {
  const create = vi.fn(opts.create ?? (() => 'blob:mock-url'))
  const revoke = vi.fn(opts.revoke ?? (() => {}))
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: create,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revoke,
  })
  return { create, revoke }
}

/** createObjectURL に渡された最初の Blob。 */
function firstBlob(create: { mock: { calls: unknown[][] } }): Blob {
  const blob = create.mock.calls[0]?.[0]
  if (!(blob instanceof Blob)) throw new Error('createObjectURL に Blob が渡されていません')
  return blob
}

describe('downloadTextFile', () => {
  let anchors: { download: string; href: string; rel: string }[]

  beforeEach(() => {
    vi.useFakeTimers()
    anchors = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      anchors.push({ download: this.download, href: this.href, rel: this.rel })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(URL, 'createObjectURL')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  })

  it('Blob からダウンロード用のリンクを作ってクリックし、リンクは残さない', () => {
    const { create } = stubUrlApi()
    expect(downloadTextFile('log.json', '{"a":1}')).toBe(true)

    expect(create).toHaveBeenCalledTimes(1)
    const blob = firstBlob(create)
    expect(blob.type).toBe('application/json;charset=utf-8')
    expect(blob.size).toBe(7)
    expect(anchors).toEqual([{ download: 'log.json', href: 'blob:mock-url', rel: 'noopener' }])
    expect(document.querySelector('a[download]')).toBeNull()
  })

  it('保存成功のトーストに、補足（description）を添えられる', () => {
    stubUrlApi()
    downloadTextFile('a.json', '{}', 'application/json', '共有前に確認してください')
    expect(toast.success).toHaveBeenLastCalledWith('a.json を保存しました', {
      description: '共有前に確認してください',
    })
    downloadTextFile('b.json', '{}')
    expect(toast.success).toHaveBeenLastCalledWith('b.json を保存しました', {})
  })

  it('MIME タイプを指定できる', () => {
    const { create } = stubUrlApi()
    downloadTextFile('a.txt', 'x', 'text/plain')
    expect(firstBlob(create).type).toBe('text/plain;charset=utf-8')
  })

  it('URL は少し待ってから解放する（ダウンロード開始前に無効にしない）', () => {
    const { revoke } = stubUrlApi()
    downloadTextFile('log.json', '{}')
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(revoke).toHaveBeenCalledWith('blob:mock-url')
  })

  it('URL の解放に失敗しても未処理の例外にならない', () => {
    stubUrlApi({
      revoke: () => {
        throw new Error('already revoked')
      },
    })
    downloadTextFile('log.json', '{}')
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
  })

  it('解放の時点で API が無くなっていても例外にならない', () => {
    stubUrlApi()
    downloadTextFile('log.json', '{}')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
  })

  it('保存できないブラウザでは false を返し、例外は投げない', () => {
    stubUrlApi({
      create: () => {
        throw new Error('unsupported')
      },
    })
    expect(downloadTextFile('log.json', '{}')).toBe(false)
    expect(anchors).toHaveLength(0)
  })
})
