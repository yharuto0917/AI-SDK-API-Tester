import type { NetworkLogEntry } from '@/types'

const MASK = '••••'

/**
 * 値を隠すヘッダー名の目印（部分一致・大文字小文字を区別しない）。
 * 認証ヘッダーは x-authorization / ocp-apim-subscription-key / x-functions-key / x-vercel-protection-bypass
 * のように名前が自由なので、固定の名簿では必ず取りこぼす。誤って隠した値は「表示」の切り替えで見られるため、
 * 広めに取る（idempotency-key のような認証ではない名前も隠れる）。
 */
const SENSITIVE_NAME_RE =
  /auth|key|token|secret|pass(?:word|wd)|credential|signature|session|cookie|bypass|jwt/i
const AUTH_SCHEME_RE = /^(Bearer|Basic)\s+(\S.*)$/i

/** 値が認証情報として隠される（インスペクタ・cURL でマスクされる）ヘッダー名か。 */
export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_NAME_RE.test(name)
}

/** 末尾を残すのに必要な長さ。短い値は末尾 4 文字でも全体の大きな割合になる（12 文字なら 3 分の 1）。 */
const MIN_LENGTH_TO_SHOW_TAIL = 20

/** 十分長い値だけ末尾 4 文字を残して隠す。それ未満は末尾も推測材料になるので全部隠す。 */
function maskSecret(secret: string): string {
  return secret.length < MIN_LENGTH_TO_SHOW_TAIL ? MASK : `${MASK}${secret.slice(-4)}`
}

/**
 * 秘匿と分かっている値 1 つを、ヘッダーと同じ規則で隠す。
 * - 空文字はそのまま（隠すものが無い）
 * - `Bearer xxx` / `Basic xxx` は認証方式を残し、資格情報の部分だけを隠す（方式の大文字小文字は元のまま）
 * - 資格情報が 20 文字（MIN_LENGTH_TO_SHOW_TAIL）未満なら `••••` だけ、それ以上なら `••••` + 末尾 4 文字
 * 名前でヘッダーを選ぶ必要が無い場面（URL のクエリ値・本文の値）が、この規則を借りるための入口。
 */
export function maskSecretValue(value: string): string {
  if (value === '') return value
  const scheme = AUTH_SCHEME_RE.exec(value)
  if (scheme !== null) return `${scheme[1]} ${maskSecret(scheme[2] ?? '')}`
  return maskSecret(value)
}

/** 認証情報を含むヘッダーの値をマスクした新しいオブジェクトを返す（キーはそのまま）。 */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    result[name] = isSensitiveHeaderName(name) ? maskSecretValue(value) : value
  }
  return result
}

const TRUNCATED_BODY_NOTE =
  '# 注意: リクエスト body はログの保持上限で途中までしか残っていないため、この cURL は実際に送った内容を再現しません。'

/** シェルのシングルクォートで囲む。中のシングルクォートは '\'' に置き換える。 */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * ログのエントリから、同じリクエストを再現する cURL コマンドを作る。
 *
 * maskSecrets（既定 true）が隠すのは「ヘッダーの値」だけ。URL のクエリ・user:pass と本文の秘匿キーの値は
 * このモジュールでは判定しないので、必要なら呼び出し側が隠したものを targetUrl / requestBody に渡すこと
 * （インスペクタは secret-mask の maskRequest で隠してから渡している）。
 *
 * requestBody がログの保持上限で切り詰められている（requestBodyTruncated）と、実際に送った内容は再現できない。
 * その場合は先頭に注記のコメント行を付ける（コメント行は貼り付けてもシェルが無視する）。
 */
export function toCurl(
  entry: Pick<
    NetworkLogEntry,
    'method' | 'targetUrl' | 'requestHeaders' | 'requestBody' | 'requestBodyTruncated'
  >,
  opts?: { maskSecrets?: boolean },
): string {
  const maskSecrets = opts?.maskSecrets ?? true
  const method = entry.method.toUpperCase()
  const headers = maskSecrets ? maskHeaders(entry.requestHeaders) : entry.requestHeaders
  const hasBody = entry.requestBody !== undefined && entry.requestBody !== ''

  // targetUrl を使うので、プロキシ経由で送ったリクエストでも実際の宛先を叩く curl になる
  const first = ['curl', '-N']
  if (method === 'HEAD') {
    // -X HEAD だと curl がボディを待ち続けるため -I を使う
    first.push('-I')
  } else if (method !== 'GET' || hasBody) {
    // GET に --data-raw を付けると curl が POST に変えるため、body があるときは明示する
    first.push('-X', /^[A-Z0-9_-]+$/.test(method) ? method : shellQuote(method))
  }
  first.push(shellQuote(entry.targetUrl))

  const lines = [first.join(' ')]
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`-H ${shellQuote(`${name}: ${value}`)}`)
  }
  if (hasBody) lines.push(`--data-raw ${shellQuote(entry.requestBody ?? '')}`)

  const command = lines.join(' \\\n  ')
  // 行末の \ でつなぐコマンドの途中にコメントは置けないので、コマンドの前に別の行として置く
  return entry.requestBodyTruncated === true ? `${TRUNCATED_BODY_NOTE}\n${command}` : command
}
