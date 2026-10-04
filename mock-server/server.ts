/**
 * モックバックエンドの CLI 入口: `pnpm mock`（= `node mock-server/server.ts`）。
 *
 * 環境変数:
 * - MOCK_PORT: 待ち受けポート（既定 28787。0 で空きポートを自動割り当て）
 * - MOCK_HOST: 待ち受けアドレス（既定 127.0.0.1。LAN に公開したいときだけ変える）
 * - MOCK_CORS: 0 で CORS ヘッダーを一切付けない（ブラウザの CORS エラーを再現する）
 */
import { realpathSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { createMockServer, type MockLogEntry } from './app.ts'
import { CHAT_SCENARIOS, SIMPLE_SCENARIOS } from './scenarios.ts'

const DEFAULT_PORT = 28787

/** このファイルが `node mock-server/server.ts` として直接実行されたか（import されただけなら listen しない）。 */
function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

function formatLog(entry: MockLogEntry): string {
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false })
  const scenario = entry.scenario === undefined ? '' : ` [${entry.scenario}]`
  const outcome =
    entry.outcome === 'completed'
      ? ''
      : entry.outcome === 'client-closed'
        ? ' (クライアントが切断)'
        : ' (サーバーが切断)'
  return `${time} ${entry.method} ${entry.path}${scenario} -> ${entry.status} ${entry.durationMs}ms${outcome}`
}

function banner(origin: string, cors: boolean): string {
  const names = (list: readonly { name: string }[]) => list.map((s) => s.name).join(', ')
  return [
    '',
    'AI SDK モックバックエンド',
    `  ${origin}`,
    `  CORS: ${cors ? '有効（任意の Origin を許可）' : '無効（MOCK_CORS=0。ブラウザからはクロスオリジンで失敗します）'}`,
    '',
    'エンドポイント',
    '  GET  /health                          生存確認',
    '  GET  /api/scenarios                   シナリオ一覧（JSON）',
    '  POST /api/chat                        UI Message Stream（SSE）  … Chat (UI Message Stream)',
    '  POST /api/text                        プレーンテキストのストリーム … Chat (Text Stream)',
    '  POST /api/completion[?protocol=text]  data（既定）/ text プロトコル … Completion',
    '  ANY  /api/json[?delay=ms&status=418]  リクエストの JSON エコー     … Raw HTTP',
    '',
    'シナリオの選び方: body.scenario → ?scenario= → 本文先頭の "#名前" → text',
    `  /api/chat      ${names(CHAT_SCENARIOS)}`,
    `  /api/text, /api/completion  ${names(SIMPLE_SCENARIOS)}`,
    '  認証の確認は scenario=auth（Authorization: Bearer test-token が必要）',
    '',
    '例: curl -N -X POST "' +
      origin +
      '/api/chat?scenario=slow" -H "content-type: application/json" -d \'{"messages":[]}\'',
    '',
    'Ctrl+C で終了します。',
    '',
  ].join('\n')
}

function main(): void {
  const portEnv = process.env.MOCK_PORT
  const port = portEnv === undefined || portEnv === '' ? DEFAULT_PORT : Number(portEnv)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`MOCK_PORT が不正です: ${portEnv}`)
    process.exit(1)
  }
  const host =
    process.env.MOCK_HOST === undefined || process.env.MOCK_HOST === ''
      ? '127.0.0.1'
      : process.env.MOCK_HOST
  const cors = process.env.MOCK_CORS !== '0'

  const server = createMockServer({ cors, onLog: (entry) => console.log(formatLog(entry)) })

  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `ポート ${port} は使用中です。MOCK_PORT=<別のポート> pnpm mock で変更できます。`,
      )
    } else {
      console.error(err)
    }
    process.exit(1)
  })

  server.listen(port, host, () => {
    const address = server.address() as AddressInfo
    console.log(
      banner(
        `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`,
        cors,
      ),
    )
  })

  const shutdown = () => {
    // SSE の接続が残っていると close が終わらないため、残りの接続も切る
    server.close(() => process.exit(0))
    server.closeAllConnections()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (isMainModule()) main()
