/** Vite 開発サーバーに実装される転送プロキシのパス。 */
export const PROXY_PATH = '/__proxy'
/** 転送先の絶対 URL を渡すリクエストヘッダー。 */
export const PROXY_TARGET_HEADER = 'x-proxy-target'
/** プロキシ自身の失敗（転送先エラーではない）を示すレスポンスヘッダー。 */
export const PROXY_ERROR_HEADER = 'x-proxy-error'

/**
 * 画面・診断・ヒントで使うプロキシの呼び名。表記ゆれ（開発プロキシ / dev プロキシ）で
 * 「どのトグルのことか」が分からなくならないよう、文言はここから組み立てる。
 */
export const PROXY_NAME = 'devプロキシ'
/**
 * 設定画面のトグルのラベル。CORS 診断などが「これを ON にする」と案内する名前と一致させる必要がある
 * （ラベルを変えるときは、この定数だけ変えれば案内も追随する）。
 */
export const PROXY_TOGGLE_LABEL = `${PROXY_NAME}経由で送信`

/**
 * devプロキシが生きているかを確認する。
 * 契約: GET /__proxy → 200 {"proxy":"ai-sdk-tester", ...}。
 * SPA フォールバックの index.html（200）や別サービスの 200 を誤検出しないよう、JSON の中身まで見る。
 * 例外・非 200・別形式はすべて false（throw しない）。
 */
export async function checkProxyAvailable(
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    // fetch を単体の変数として呼ぶと環境によって Illegal invocation になるため、都度 globalThis 経由で呼ぶ
    const doFetch: typeof fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    const res = await doFetch(PROXY_PATH, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    })
    if (res.status !== 200) return false
    const json: unknown = await res.json()
    return (
      typeof json === 'object' &&
      json !== null &&
      (json as { proxy?: unknown }).proxy === 'ai-sdk-tester'
    )
  } catch {
    return false
  }
}
