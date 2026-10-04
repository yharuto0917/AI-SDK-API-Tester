const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** 1024 進で '0 B' / '1.5 KB' / '2.3 MB' の形にする。不正値・負数は 0 扱い。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.floor(n)} B`

  let value = n
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  let text = value.toFixed(1)
  // 1023.96 KB のように丸めた結果が 1024 になるときは次の単位に繰り上げる
  if (Number(text) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
    text = value.toFixed(1)
  }
  return `${text} ${BYTE_UNITS[unit]}`
}

/** '123 ms' / '1.23 s' / '2 m 5 s'。不正値・負数は 0 扱い。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms'

  const rounded = Math.round(ms)
  if (rounded < 1000) return `${rounded} ms`

  const seconds = (ms / 1000).toFixed(2)
  // 59.999 s が '60.00 s' に丸まる場合は分表記に回す
  if (Number(seconds) < 60) return `${seconds} s`

  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)} m ${total % 60} s`
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** ローカル時刻の HH:MM:SS.mmm。 */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return '--:--:--.---'
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`
}

/** 先頭 max 文字を残し、超過したときだけ末尾に '…' を付ける（結果は最大 max + 1 文字）。 */
export function truncate(text: string, max: number): string {
  let end = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : text.length
  if (text.length <= end) return text
  // サロゲートペアを途中で切って文字化けさせない
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}
