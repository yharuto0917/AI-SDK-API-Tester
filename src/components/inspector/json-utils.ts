/** JSON の判定・整形とテキストの切り詰めに関する純粋関数。 */
import { prettyPrintJson } from '@/components/raw/raw-utils'

/** これより長いテキストは shiki でハイライトせず、素の pre で描画する（非同期ハイライトが重くなるため）。 */
export const HIGHLIGHT_MAX_CHARS = 20_000

/** これより長いテキストは JSON.parse / 整形を試みない（巨大なレスポンスで UI が固まらないように）。 */
export const MAX_JSON_FORMAT_CHARS = 1_000_000

export type FormattedBody = { kind: 'json'; text: string } | { kind: 'text'; text: string }

/**
 * 本文全体が JSON のオブジェクト / 配列として解釈できれば 2 スペースで整形して返す。
 * それ以外（SSE・プレーンテキスト・途中で切れた JSON・巨大な本文）は元のテキストをそのまま返す。
 * 数値だけ・文字列だけの本文は整形しても変わらないので text 扱いにする。
 * サーバーが返した値を確かめる道具なので、JSON.parse → stringify は使わず空白だけを組み替える
 * （大きな整数の桁落ち・重複キーの脱落・1.0 → 1 の書き換えを起こさない）。
 */
export function formatBody(text: string, maxChars: number = MAX_JSON_FORMAT_CHARS): FormattedBody {
  if (text.length === 0 || text.length > maxChars) return { kind: 'text', text }
  const head = /\S/.exec(text)
  // SSE（data: ...）などは先頭で弾き、無駄に JSON.parse しない
  if (head === null || (head[0] !== '{' && head[0] !== '[')) return { kind: 'text', text }
  const pretty = prettyPrintJson(text)
  return pretty === null ? { kind: 'text', text } : { kind: 'json', text: pretty }
}

/** 任意の値を整形 JSON にする。undefined など JSON にできない値は String() に落とす。 */
export function formatJsonValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export interface ClippedText {
  text: string
  clipped: boolean
  /** 切り詰め前の文字数 */
  total: number
}

/** 先頭 max 文字だけ残す。サロゲートペアの途中では切らない。 */
export function clipText(text: string, max: number): ClippedText {
  const total = text.length
  if (total <= max) return { text, clipped: false, total }
  let end = Math.max(0, Math.floor(max))
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
  return { text: text.slice(0, end), clipped: true, total }
}

/** 改行で区切った行数（空文字でも 1）。 */
export function countLines(text: string): number {
  let lines = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++
  }
  return lines
}
