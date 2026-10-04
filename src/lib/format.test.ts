import { describe, expect, it } from 'vitest'
import { formatBytes, formatClock, formatDuration, truncate } from '@/lib/format'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [999, '999 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [Math.round(2.3 * 1024 * 1024), '2.3 MB'],
    [1024 ** 3, '1.0 GB'],
    [1024 ** 4, '1.0 TB'],
    [5 * 1024 ** 4, '5.0 TB'],
    [1024 ** 5, '1024.0 TB'],
  ])('%d -> %s', (n, expected) => {
    expect(formatBytes(n)).toBe(expected)
  })

  it('丸めて 1024 になる境界は次の単位に繰り上げる', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 - 50)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 - 100)).toBe('1023.9 KB')
    expect(formatBytes(1024 * 1024 - 1000)).toBe('1023.0 KB')
  })

  it.each([-1, NaN, Infinity, -Infinity])('不正値 (%d) は 0 B', (n) => {
    expect(formatBytes(n)).toBe('0 B')
  })

  it('小数のバイト数は切り捨てる', () => {
    expect(formatBytes(1.9)).toBe('1 B')
    expect(formatBytes(0.5)).toBe('0 B')
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0 ms'],
    [123, '123 ms'],
    [999, '999 ms'],
    [1000, '1.00 s'],
    [1230, '1.23 s'],
    [59_000, '59.00 s'],
    [60_000, '1 m 0 s'],
    [125_000, '2 m 5 s'],
    [3_600_000, '60 m 0 s'],
  ])('%d ms -> %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  it('丸め境界を繰り上げる', () => {
    expect(formatDuration(999.6)).toBe('1.00 s')
    expect(formatDuration(59_999)).toBe('1 m 0 s')
    expect(formatDuration(59_994)).toBe('59.99 s')
  })

  it('分表記の秒は四捨五入して 60 にならない', () => {
    expect(formatDuration(119_600)).toBe('2 m 0 s')
    expect(formatDuration(119_400)).toBe('1 m 59 s')
  })

  it.each([-1, NaN, Infinity])('不正値 (%d) は 0 ms', (ms) => {
    expect(formatDuration(ms)).toBe('0 ms')
  })
})

describe('formatClock', () => {
  it('ローカル時刻を HH:MM:SS.mmm で返す', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 6)
    expect(formatClock(d.getTime())).toBe('03:04:05.006')
  })

  it('桁あふれしない値はゼロ埋めしない', () => {
    const d = new Date(2026, 5, 15, 23, 59, 59, 999)
    expect(formatClock(d.getTime())).toBe('23:59:59.999')
  })

  it('0 時ちょうど', () => {
    const d = new Date(2026, 5, 15, 0, 0, 0, 0)
    expect(formatClock(d.getTime())).toBe('00:00:00.000')
  })

  it('不正な日時はプレースホルダー', () => {
    expect(formatClock(NaN)).toBe('--:--:--.---')
    expect(formatClock(Infinity)).toBe('--:--:--.---')
  })
})

describe('truncate', () => {
  it('max 以内ならそのまま', () => {
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('abc', 10)).toBe('abc')
    expect(truncate('', 0)).toBe('')
  })

  it('超過したら先頭 max 文字 + … にする', () => {
    expect(truncate('abcdef', 3)).toBe('abc…')
    expect(truncate('abcd', 3)).toBe('abc…')
  })

  it('max が 0 以下なら … だけ', () => {
    expect(truncate('abc', 0)).toBe('…')
    expect(truncate('abc', -5)).toBe('…')
  })

  it('小数の max は切り捨てる', () => {
    expect(truncate('abcdef', 2.9)).toBe('ab…')
  })

  it('サロゲートペアを途中で切らない', () => {
    // '😀' は 2 コードユニット
    expect(truncate('a😀b', 2)).toBe('a…')
    expect(truncate('a😀b', 3)).toBe('a😀…')
  })

  it('max が Infinity ならそのまま', () => {
    expect(truncate('abc', Infinity)).toBe('abc')
  })
})
