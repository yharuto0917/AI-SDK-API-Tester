import { isForbiddenRequestHeader } from '@/lib/forbidden-headers'

/**
 * 追加ヘッダー行の入力チェック。結果は 2 種類に分けて扱う。
 * - エラー（validateHeader*）: そのままでは送信が失敗する入力。aria-invalid と role="alert" で知らせる。
 * - 警告（warnHeaderName）: 入力は有効だが、ブラウザが黙って捨てる。入力は妨げず、aria-invalid も付けない。
 */

/** RFC 7230 の token。ヘッダー名に使える文字（request-shaper と同じ基準）。 */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** 空欄は「まだ入力していない行」なのでエラーにしない。OK なら null。 */
export function validateHeaderName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return null
  return TOKEN_RE.test(trimmed)
    ? null
    : "ヘッダー名に使えない文字が含まれています（英数字と ! # $ % & ' * + - . ^ _ ` | ~ のみ）"
}

/** fetch は ISO-8859-1 外の文字と CR / LF / NUL を含む値を拒否するため、入力時点で知らせる。OK なら null。 */
export function validateHeaderValue(value: string): string | null {
  // 送信時に前後の空白は取り除かれるので、中身だけを検査する
  const trimmed = value.trim()
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code === 0 || code === 0x0a || code === 0x0d || code > 0xff) {
      return '値に使えない文字（日本語など ISO-8859-1 以外の文字、改行）が含まれています'
    }
  }
  return null
}

/** 認証情報を載せるヘッダーかどうか。インスペクタ・cURL でマスクされる側の代表的な名前。 */
export function isAuthorizationHeader(name: string): boolean {
  return name.trim().toLowerCase() === 'authorization'
}

/** ブラウザが捨てるヘッダーの警告文。インスペクタ側の「送信されなかったヘッダー」の表示と対応させる。 */
export const FORBIDDEN_HEADER_WARNING =
  'ブラウザの仕様でこのヘッダーは送信されません（Cookie / Origin など）。インスペクタには「送信されなかったヘッダー」として表示されます。'

/**
 * 警告（非ブロッキング）。fetch が黙って捨てるヘッダー名なら警告文、そうでなければ null。
 * X-HTTP-Method-Override などは値次第で捨てられるので、値も受け取る。
 */
export function warnHeaderName(name: string, value: string): string | null {
  // 空欄は未入力、不正な名前はエラーが先に出るので、警告は重ねない
  if (name.trim() === '' || validateHeaderName(name) !== null) return null
  return isForbiddenRequestHeader(name, value) ? FORBIDDEN_HEADER_WARNING : null
}
