# AI SDK API Tester

## 1. 概要

[Vercel AI SDK](https://ai-sdk.dev)（`ai@7` / `@ai-sdk/react@4`）で作ったバックエンド API に、一時的に接続して動作確認するための開発者向けテストサイトです。

- 自分のバックエンドのエンドポイント・認証ヘッダー・追加ボディを画面から指定して、`useChat` / `useCompletion` と同じ経路でリクエストを送れます
- 送受信の内容（ヘッダー・ボディ・SSE の 1 イベントごと）をインスペクタで観察できます。つまずきやすい点（CORS・ヘッダー不足・chunk の順序違反など）は日本語の診断として表示します
- API キー不要で動く AI SDK 互換のモックサーバー（`pnpm mock`）を同梱しています
- 画面は日本語です。UI は [AI Elements](https://elements.ai-sdk.dev) + [shadcn/ui](https://ui.shadcn.com) + Tailwind CSS v4、ビルドは Vite 8（React 19 / TypeScript 6）です

> **本番利用は想定していません。** ローカルの開発マシンで、動作確認のために一時的に使う道具です（[セキュリティと保存](#8-セキュリティと保存)を参照）。

## 目次

1. [概要](#1-概要)
2. [クイックスタート](#2-クイックスタート)
3. [自分のバックエンドに接続する](#3-自分のバックエンドに接続する)
4. [4つのモード](#4-4つのモード)
5. [インスペクタと診断](#5-インスペクタと診断)
6. [dev プロキシ](#6-dev-プロキシ)
7. [モックサーバーのシナリオ](#7-モックサーバーのシナリオ)
8. [セキュリティと保存](#8-セキュリティと保存)
9. [開発](#9-開発)
10. [トラブルシューティング](#10-トラブルシューティング)

## 2. クイックスタート

必要なもの: Node.js 22.18 以上と [pnpm](https://pnpm.io)。

- `ai@7` / `@ai-sdk/react@4` が Node.js 22 以上を要求します
- モックサーバーは `node mock-server/server.ts` で TypeScript を直接実行するため、型ストリップが標準で有効な 22.18 以上が必要です
- テストに使う jsdom 30 の `engines` は 22.22.2 以上 / 24.15 以上を宣言しています（pnpm は既定では強制しません。警告が出る場合や、jsdom 起因でテストが失敗する場合は Node.js を更新してください）

```bash
pnpm install
```

ターミナルを 2 つ開き、それぞれで起動します。

```bash
# ターミナル 1: モックバックエンド（既定 http://localhost:28787）
pnpm mock
```

```bash
# ターミナル 2: テストサイト（既定 http://localhost:5199）
pnpm dev
```

ブラウザで <http://localhost:5199> を開きます。初期状態のエンドポイントはすでにモックサーバー（`localhost:28787`）を向いているので、そのまま試せます。

1. ヘッダーのタブで **Chat (UI Message Stream)** を選びます
2. 空の会話に出るチップ（`#text`・`#tool`・`#approval` など）をクリックすると、そのシナリオで送信されます
3. 右のインスペクタで、リクエスト・レスポンス・SSE イベント・診断を確認します

エンドポイントを書き換えたあとで元に戻したいときは、設定パネルの「**モックサーバーに接続**」で全モードのエンドポイントをモック（`localhost:28787`）に向け直せます。

### ポートが他のプロジェクトと衝突するとき

| 対象           | 既定  | 変更方法                                                                                        |
| -------------- | ----- | ----------------------------------------------------------------------------------------------- |
| テストサイト   | 5199  | `pnpm dev --port 5200`（使用中なら Vite が次の空きポートを使うので、表示された URL を開く）     |
| モックサーバー | 28787 | `MOCK_PORT=28788 pnpm mock`（`0` で空きポートを自動割り当て。実際のポートは起動時の表示で確認） |

- モックのポートを変えたときは、設定パネルのエンドポイントを手で書き換えてください。「モックサーバーに接続」と初期値は `28787` 固定です
- 設定はオリジン（ポート込み）ごとにブラウザへ保存されるため、テストサイトのポートを変えると設定は引き継がれません
- Claude Code のプレビュー用に `.claude/launch.json` がポート（`app`: 5199 / `mock`: 28787）を定義しています。ポートを変えるときはあわせて更新してください

モックサーバーの環境変数は次の 3 つです。

| 環境変数    | 既定        | 内容                                                                                                                     |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MOCK_PORT` | `28787`     | 待ち受けポート                                                                                                           |
| `MOCK_HOST` | `127.0.0.1` | 待ち受けアドレス。エコー系シナリオは受信ヘッダー（Authorization を含む）をそのまま返すので、LAN への公開は避けてください |
| `MOCK_CORS` | 有効        | `MOCK_CORS=0` で CORS ヘッダーを一切付けません。ブラウザの CORS エラーを再現して、dev プロキシの効果を確かめられます     |

## 3. 自分のバックエンドに接続する

### 手順

1. ヘッダーのタブで[モード](#4-4つのモード)を選びます
2. 設定パネルの「接続」にエンドポイントを入力します（モードごとに別々に保持されます）
3. 必要なら認証・ヘッダー・追加ボディ・credentials を設定します（下の表）
4. ブラウザの CORS エラーで失敗するときは、「**devプロキシ経由で送信**」を ON にします（[dev プロキシ](#6-dev-プロキシ)）
5. 送信して、インスペクタの「診断」タブを見ます

設定は 1 文字入力するごとに反映され、会話を保ったまま**次の送信から**効きます（リクエストは送信のたびに設定から組み立て直します）。

### 設定項目

| 項目                               | 対象モード        | 内容                                                                                                                                                                      |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| エンドポイント                     | 全モード          | `http://` / `https://` で始まる絶対 URL、または `/` で始まるパス。dev プロキシ利用時は絶対 URL が必須です                                                                 |
| Bearer トークン                    | 全モード          | `Authorization: Bearer <token>` として送ります。追加ヘッダーに有効な Authorization があれば、そちらが優先されトークンは使われません                                       |
| 追加ヘッダー                       | 全モード          | 行ごとに有効 / 無効を切り替えられます。AI SDK が付けた同名ヘッダーより優先されます（大文字小文字は区別しません）                                                          |
| credentials                        | 全モード          | `omit` / `same-origin`（既定）/ `include`。`include` は接続先が `Access-Control-Allow-Credentials: true` を返す必要があります。dev プロキシ利用中は常に `omit` で送ります |
| 追加ボディ（JSON）                 | Chat / Completion | JSON オブジェクトを送信ボディにマージします。同じキーは追加ボディが優先されます                                                                                           |
| 最後のメッセージのみ送信           | Chat              | `messages` を最後の 1 件に絞ります。会話履歴をサーバー側に持つバックエンド向けです                                                                                        |
| ツール出力・承認が揃ったら自動再送 | Chat (UI)         | 既定 ON。OFF にすると、揃った時点で出る「結果を送信」ボタンを押すまで再送しません                                                                                         |
| Completion のプロトコル            | Completion        | `data`（既定）/ `text`                                                                                                                                                    |
| devプロキシ経由で送信              | 全モード          | 既定 OFF                                                                                                                                                                  |

### バックエンドが受け取るもの・返すもの

#### Chat (UI Message Stream)

`useChat` の既定どおり、JSON を `POST` します。

```json
{
  "id": "チャット ID",
  "messages": [{ "id": "…", "role": "user", "parts": [{ "type": "text", "text": "こんにちは" }] }],
  "trigger": "submit-message"
}
```

- `trigger` は `submit-message` か `regenerate-message` です。`messageId` は再生成・継続（ツール承認後の再送など）のときだけ、対象メッセージの ID が入ります
- 追加ボディのキーは、同じ階層にマージされます
- クライアントツールの出力や承認応答は、末尾が assistant メッセージ（ツールパートに出力・承認応答が付いた状態）の継続リクエストとして届きます

レスポンスは SSE（`text/event-stream`）の UI Message Stream です。AI SDK v7 では `toUIMessageStream` と `createUIMessageStreamResponse` で返します。

```ts
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from 'ai'

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json()

  const result = streamText({
    model: 'anthropic/claude-sonnet-5.5', // AI Gateway のモデル ID（プロバイダーパッケージのモデルでも可）
    instructions: 'You are a helpful assistant.',
    messages: await convertToModelMessages(messages),
  })

  // content-type: text/event-stream と x-vercel-ai-ui-message-stream: v1 は自動で付きます
  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  })
}
```

Node.js の `http` / Express などでは、`createUIMessageStreamResponse` の代わりに `pipeUIMessageStreamToResponse({ response, stream })` を使います。Python など別言語で実装する場合の最小の流れは次のとおりです。

```text
HTTP/1.1 200 OK
content-type: text/event-stream
x-vercel-ai-ui-message-stream: v1

data: {"type":"start"}

data: {"type":"start-step"}

data: {"type":"text-start","id":"text-1"}

data: {"type":"text-delta","id":"text-1","delta":"こんにちは"}

data: {"type":"text-end","id":"text-1"}

data: {"type":"finish-step"}

data: {"type":"finish"}

data: [DONE]
```

#### Chat (Text Stream)

リクエストは UI Message Stream モードと同じ JSON です。レスポンスはプレーンテキストを少しずつ流します。ツール呼び出し・usage・finishReason は扱えません。

```ts
import {
  convertToModelMessages,
  createTextStreamResponse,
  streamText,
  toTextStream,
  type UIMessage,
} from 'ai'

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json()

  const result = streamText({
    model: 'anthropic/claude-sonnet-5.5',
    messages: await convertToModelMessages(messages),
  })

  return createTextStreamResponse({ stream: toTextStream({ stream: result.stream }) })
}
```

#### Completion

`useCompletion` は `{ "prompt": "...", ...追加ボディ }` を `POST` します。レスポンスは設定した**プロトコル**に合わせます。

`data` プロトコル（既定）は UI Message Stream です。クライアントは `text-delta` と `error` だけを読みます。

```ts
import { createUIMessageStreamResponse, streamText, toUIMessageStream } from 'ai'

export async function POST(req: Request) {
  const { prompt }: { prompt: string } = await req.json()

  const result = streamText({ model: 'anthropic/claude-sonnet-5.5', prompt })

  return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })
}
```

`text` プロトコルは、プレーンテキストのストリームを返します。上の例の `return` を次に差し替えます。

```ts
import { createTextStreamResponse, toTextStream } from 'ai'

return createTextStreamResponse({ stream: toTextStream({ stream: result.stream }) })
```

#### Raw HTTP

形式の指定はありません。任意のメソッド・ボディで送り、返ってきたものをそのまま表示します。

## 4. 4つのモード

| モード                               | 使う SDK の API                       | 用途                                                                                                    |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Chat (UI Message Stream) — `chat-ui` | `useChat` + `DefaultChatTransport`    | `streamText` + UI Message Stream を返すバックエンドの確認。ツール・承認・ソース・ファイルまで描画します |
| Chat (Text Stream) — `chat-text`     | `useChat` + `TextStreamChatTransport` | プレーンテキストをストリームで返すバックエンドの確認                                                    |
| Completion — `completion`            | `useCompletion`                       | `prompt` を送って 1 回分の生成結果を受け取る API の確認（`data` / `text` プロトコル）                   |
| Raw HTTP — `raw`                     | `fetch`（SDK を通さない）             | 任意のメソッド・ボディで送り、ステータス・ヘッダー・ボディを観察する。AI SDK 以外の API にも使えます    |

### Chat (UI Message Stream)

- テキストはストリーミング表示され、「Markdown 表示」で整形表示とプレーン表示を切り替えられます
- reasoning（折りたたみ）、サーバー実行ツール、ソース（URL・ドキュメント）、`file` パート（画像）、`data-*` パート、`message.metadata` を描画します
- **クライアント実行ツール**は、画面のフォームから出力（JSON または文字列）かエラーを手で返せます。返すと、設定に応じて自動で、または「結果を送信」ボタンでサーバーへ再送します
- **ツール承認**は、承認 / 拒否（理由は任意）を画面から返せます
- 画像・ファイルを添付できます（最大 8 ファイル・各 8 MB。data URL として JSON ボディに含めて送ります）
- ツールバーから「メッセージ JSON」（`UIMessage[]` の確認）、「再生成」、「新しい会話」を使えます。送信中は停止ボタンで中断できます（インスペクタでは `aborted` として扱います）
- エラーはバナーに出て、「再試行」できます。原因はインスペクタの「診断」で確認します
- 空の会話に出るチップで、モックサーバーの[シナリオ](#7-モックサーバーのシナリオ)を試せます。先頭の `#名前` は**モックサーバー専用**の指定で、ほかのサーバーには普通のメッセージとして届きます

### Chat (Text Stream)

- 受信したテキストを assistant メッセージに追記して表示します。操作は Chat (UI Message Stream) と共通です
- SSE（`text/event-stream`）が返ってくると、`data: ...` の行がそのまま本文に出ます。その場合は診断が「Chat (UI Message Stream) を試してください」と案内します

### Completion

- プロンプトを入力して「生成」（`⌘` / `Ctrl` + `Enter`）で送信します。停止・クリア・Markdown 表示の切り替えができます
- 本文が空のまま完了したときは、プロトコル設定が合っていない可能性があることを表示します
- **text プロトコルでモックサーバーを試すとき**は、Completion のエンドポイントを `http://localhost:28787/api/completion?protocol=text`（または `http://localhost:28787/api/text`）にしてください。クエリのない `/api/completion` は data プロトコルで返します

### Raw HTTP

- メソッド（`GET` / `POST` / `PUT` / `PATCH` / `DELETE`）・エンドポイント・ボディを指定して送ります（`⌘` / `Ctrl` + `Enter` でも送信）
- ボディは入力した文字列のまま送ります。JSON として有効かを表示し、「整形」で整形できます。有効な JSON で `content-type` ヘッダーが無ければ `application/json` を付けます。`GET` ではボディは送りません
- ステータス・レスポンスヘッダー・ボディ（表示は 100 万文字まで）を受信しながら表示し、「中止」で中断できます
- 追加ボディは Raw には適用されません。追加ヘッダー・Bearer トークン・credentials・dev プロキシは適用されます

## 5. インスペクタと診断

どのモードの通信も、画面右のインスペクタに記録されます（1024px 未満の画面では、設定・インスペクタはヘッダーのボタンから開くドロワーになります）。

- **通信リスト**: 新しい順の一覧です。dev プロキシ経由かどうか、所要時間が分かります
- **診断**: 選択した通信の診断です。重大なものから（error → warn → info → ok の順に）並びます
- **リクエスト**: 宛先・ヘッダー・ボディ・cURL
- **レスポンス**: ステータス・ヘッダー（`content-type` と `x-vercel-ai-ui-message-stream` は強調表示）・本文
- **ストリーム**: SSE を 1 イベントずつ表示します（番号・経過ミリ秒・type バッジ・プレビュー、展開で詳細）。type や種別（SSE JSON / 非 JSON / `[DONE]` / コメント / テキストチャンク）で絞り込め、「最新を追う」と「全イベントを JSON でコピー」があります。経過ミリ秒を見ると、サーバーやプロキシがバッファしていないかが分かります

リクエスト・レスポンスの長い本文は、先頭 3 万文字だけを描画します。「全文を表示」（上限 200 万文字）と「全文をコピー」で全体を扱えます。

インスペクタ上部の「ログを JSON で保存」と「クリア」でログを書き出し・消去できます。ログはメモリ上にだけ保持します。上限は、200 件・1 通信あたり 5,000 イベント（1 イベントの原文は 10 万文字まで）・レスポンス本文 200 万文字・**リクエスト本文 20 万文字**（添付ファイルの data URL などで巨大になるため。切り詰めたときは画面に注意が出て、cURL にもコメントが付きます）・ストア全体で約 5,000 万文字です。選択中や受信中の通信は、全体の上限を超えても捨てません。

### 診断の一覧

診断はクライアント側のログからの推定です。たとえばブラウザは CORS 違反も接続失敗も同じ `Failed to fetch` として扱うので、原因は「可能性」として示します。

| ID                        | レベル            | 意味                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http-status`             | ok / info / error | HTTP ステータス。400 以上は error で、ステータスごとの対処（401/403 は認証、404 は URL、415 は Content-Type など）とサーバーのエラーメッセージを添えます                                                                                                                                                                                                                                          |
| `aborted`                 | info              | 停止ボタン・ページ遷移などで中断されました（エラーではありません）                                                                                                                                                                                                                                                                                                                                |
| `network-error`           | error             | 接続できない、CORS で拒否された可能性、プロキシ経由の失敗、ストリーム受信中の切断、設定の誤りによる送信前の中止                                                                                                                                                                                                                                                                                   |
| `proxy-unavailable`       | error / warn      | dev プロキシではなく別の応答（404 や HTML）が返りました。アプリ自身の `index.html` が返っていれば error                                                                                                                                                                                                                                                                                           |
| `proxy-error`             | error             | dev プロキシ自身が返したエラー（`x-proxy-error: 1`。400 / 403 / 405 / 502）                                                                                                                                                                                                                                                                                                                       |
| `content-type`            | warn              | Chat (UI) なのに `text/event-stream` でない、または Chat (Text) なのに SSE が返っています                                                                                                                                                                                                                                                                                                         |
| `ui-stream-header`        | ok / info / warn  | `x-vercel-ai-ui-message-stream: v1` の有無・値。クロスオリジンでは `Access-Control-Expose-Headers` に無いと見えないため info にします                                                                                                                                                                                                                                                             |
| `sse-invalid-json`        | error             | SSE の `data` が JSON として解釈できません（終端の `[DONE]` を除く）                                                                                                                                                                                                                                                                                                                              |
| `ui-chunk-unknown-type`   | warn              | AI SDK v7 の `UIMessageChunk` に無い type です（独自データは `data-` で始める）                                                                                                                                                                                                                                                                                                                   |
| `ui-chunk-order`          | error / warn      | chunk の順序違反。error は SDK が必ずエラーにするもの（`start` 前の delta / end、リクエスト本文の前のメッセージにも今回のストリームにも無いツール呼び出し・承認への参照など）。承認応答やクライアントツールの出力を返した後の続きのリクエストは、本文から前回のツール呼び出しを読み取って正常と判定します。リクエスト本文を読めない・切り詰められているときだけ、見つからない参照を warn にします |
| `ui-stream-error-chunk`   | error             | サーバーが `error` chunk を送りました                                                                                                                                                                                                                                                                                                                                                             |
| `ui-stream-truncated`     | error             | `finish` の前に接続が切れました                                                                                                                                                                                                                                                                                                                                                                   |
| `ui-stream-empty`         | warn              | ステータスは 2xx なのにイベントが 1 件もありません                                                                                                                                                                                                                                                                                                                                                |
| `ui-stream-no-finish`     | warn / info       | `finish` chunk がありません（`abort` chunk で終わっていれば info）                                                                                                                                                                                                                                                                                                                                |
| `ui-stream-no-done`       | info              | 終端の `data: [DONE]` がありません（SDK は無くても動作します）                                                                                                                                                                                                                                                                                                                                    |
| `ui-chunk-schema-invalid` | error             | chunk のフィールドが AI SDK の `uiMessageChunkSchema` に合いません（旧形式の `textDelta`、`id` や `toolName` の抜け、`finishReason` の値違いなど）。SDK はこの chunk でストリームを打ち切ります                                                                                                                                                                                                   |
| `sse-unterminated-event`  | warn              | 最後のイベントの後に空行がありません。クライアント SDK はこのイベントを受け取りません（画面には「未完了」として残します）                                                                                                                                                                                                                                                                         |
| `sse-event-too-large`     | info              | 1 イベントが保持の上限を超えたため、JSON の検証と chunk の診断を省略しました                                                                                                                                                                                                                                                                                                                      |
| `stream-cancelled`        | error             | クライアント（AI SDK）が、解釈できない chunk に当たってレスポンスの読み取りを自分から打ち切りました。サーバーやプロキシの切断ではありません                                                                                                                                                                                                                                                       |
| `request-headers-dropped` | warn              | 追加ヘッダーに、ブラウザの仕様で送れないもの（Cookie / Origin / Referer / Host など）があります。サーバーには届いておらず、リクエストタブと cURL にも含めません                                                                                                                                                                                                                                   |
| `summary`                 | ok                | エラーが無く、ストリームが正常に完了しました（チャンク数・TTFB・合計時間）                                                                                                                                                                                                                                                                                                                        |

`ui-*` と `sse-*` の診断は、Chat (UI Message Stream)、および SSE で返ってきた Completion が対象です。

### 秘匿情報のマスクと cURL

インスペクタの「**秘匿情報を表示**」スイッチが OFF（既定）の間は、次の場所の秘匿情報をマスクします。値は、20 文字以上なら末尾 4 文字だけ残して `••••` にし、20 文字未満なら `••••` だけにします（短いトークンは末尾 4 文字でも露出が大きいため。`Bearer` / `Basic` のスキーム名は残ります）。

| 場所                                         | マスクされるもの                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| リクエストヘッダー                           | 名前に `auth` / `key` / `token` / `secret` / `password` / `passwd` / `credential` / `signature` / `session` / `cookie` / `bypass` / `jwt` を含むヘッダーの値（広めに隠します。`authorization` / `x-api-key` / `cookie` などが該当。`idempotency-key` のように秘匿でないものも隠れますが、スイッチで見られます） |
| レスポンスヘッダー                           | `set-cookie` / `set-cookie2` / `authorization` / `proxy-authorization` / `x-api-key` / `api-key` / `x-auth-token` / `x-access-token` / `x-csrf-token` / `x-xsrf-token` の完全一致だけ（`access-control-allow-credentials` や `www-authenticate` など、診断に必要な値は隠しません）                              |
| URL（通信リスト・宛先・cURL）                | `user:pass@` のパスワード、クエリ・フラグメントのうち、秘匿らしい名前（`key` / `token` / `signature` など）の値                                                                                                                                                                                                 |
| 本文（リクエスト・レスポンス）、SSE イベント | JSON・フォーム形式（`a=1&b=2`）・SSE の `data:` 行の JSON のうち、秘匿らしいキー（`apiKey` / `password` / `secret` など）の値。ほかの形式の本文は、次の「既知の値」の置換だけです                                                                                                                               |
| 既知の値                                     | 秘匿ヘッダーの値（`Bearer` を除いたトークンや Cookie の値を含む）と、URL・本文で見つけた秘匿値は、同じ文字列が別の場所（エコー系のバックエンドが返すレスポンスなど）に現れても伏せます（6 文字以上のものだけ）                                                                                                  |
| 保存する JSON                                | 上のすべてに加えて、エラー文と診断の文。`secretsMasked` と、範囲と限界を書いた `maskingNote` を付けます                                                                                                                                                                                                         |

- スイッチを ON にすると、画面表示・コピー・cURL・JSON 保存のすべてでマスクを外します
- 本文と URL のマスクは、**キー名にもとづく推定（ヒューリスティクス）**です。キー名で判定できない場所に入った秘密は伏せられず、秘密が残らない保証はありません。ログを共有する前に内容を確認してください
- マスクは、インスペクタの表示・コピー・保存にだけ効きます。実際に送信される値や、メモリ上のログは元のままです。会話画面・メッセージ JSON・Raw ビューの本文にも適用されません（`#echo` のようなエコー系シナリオは、受信したヘッダーを会話にそのまま表示します）
- マスクしたままの cURL は、そのままでは認証が通りません。実行したいときは「秘匿情報を表示」を ON にしてからコピーしてください
- cURL は `curl -N -X <メソッド> '<URL>' -H '...' --data-raw '...'` の形式です。dev プロキシ経由で送った通信でも、宛先は実際の接続先 URL になります。本文が長いときは、画面には省略した形で表示し、コピーすると全文が入ります

## 6. dev プロキシ

ブラウザは、CORS を許可していないバックエンドのレスポンスを JavaScript に渡しません。dev プロキシは、Vite の開発サーバーが代理でリクエストを送ることでこれを回避します。バックエンド側の CORS 設定は不要です。

- 設定パネルの「**devプロキシ経由で送信**」を ON にすると、ブラウザは同一オリジンの `/__proxy` にリクエストし、実際の宛先は `x-proxy-target` ヘッダーで渡します（エンドポイントは絶対 URL が必要です）
- 状態はヘッダーのバッジと設定パネルに表示します（「利用可能」/「利用不可」）。バッジのクリックか「再確認」で再チェックでき、ウィンドウにフォーカスが戻ったときにも自動で確認します

### 仕様

- `vite-plugins/dev-proxy.ts` が、Vite の **dev サーバー（`pnpm dev`）と preview サーバー（`pnpm build && pnpm preview`、Vite 既定の 4173）** のミドルウェアとして動きます。ビルド成果物（`dist/`）には含まれないので、静的ホスティングでは使えません
- `GET /__proxy`（`x-proxy-target` なし）は生存確認で、`{"proxy":"ai-sdk-tester","version":1}` を返します
- それ以外は、`x-proxy-target` の `http(s)` の URL へ元のメソッド・パス・クエリ・ボディをそのまま転送し、ステータス・ヘッダー・ボディをそのまま返します。転送先の 4xx / 5xx はそのまま素通しです
- レスポンスはチャンクごとに書き出すので、SSE も途中経過がそのまま見えます。ブラウザが切断すると上流のリクエストも中断し、上流が途中で切れたときはブラウザにも途中切断として伝えます
- プロキシ自身の失敗には `x-proxy-error: 1` が付きます。転送先のエラーとはこれで区別できます

| ステータス | `error` コード                      | 原因                                                                                                  |
| ---------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 400        | `missing_target` / `invalid_target` | `x-proxy-target` が無い、`http(s)` の URL ではない、`user:pass@` を含む                               |
| 403        | `forbidden`                         | `Sec-Fetch-Site` が `same-origin` / `none` 以外、または `Origin` が開発サーバーの `Host` と一致しない |
| 405        | `method_not_allowed`                | `CONNECT` / `TRACE` / `TRACK`                                                                         |
| 502        | `proxy_error`                       | 転送先に接続できない、名前解決できない                                                                |
| 502        | `redirect_error`                    | リダイレクトを追従できない（20 回超、リダイレクト先が不正、本文を再送できない。後述）                 |

### 制約と注意

- **開発専用・ローカル専用です。** 任意の URL へ転送できる踏み台なので、`pnpm dev --host` や `server.host` で LAN に公開した状態で使わないでください。`Origin` / `Sec-Fetch-Site` の検査は、他のサイトのページから悪用されるのを防ぐだけです。同じネットワークの第三者が `curl` などで直接叩くのは防げません。開発マシンから届くあらゆる URL（社内ネットワークや localhost 上の別サービスを含む）が転送先になります
- **Cookie を転送しません。** `localhost` の Cookie は全ポートで共有されるため、開発サーバー自身の Cookie が外部へ漏れないよう、リクエストの `Cookie` / `Origin` / `Referer` / `sec-*` などを取り除きます。転送先の `Set-Cookie` も返しません。Cookie セッションで認証するバックエンドは、プロキシ経由では試せません（Bearer か Authorization ヘッダーを使うか、バックエンドの CORS を設定して直接接続してください）。プロキシ経由のとき credentials は常に `omit` です
- **リダイレクトはプロキシが 1 ホップずつ追従します**（最大 20 回。`fetch` と同じ規則で、301 / 302 の `POST` と 303 は `GET` に切り替えて本文を捨て、307 / 308 は本文を再送します。別オリジンへ移るときは `authorization` を送りません）。再送できるのは `Content-Length` 付きで 8 MiB 以下の本文だけで、それ以外（ストリームで送る本文）が 307 / 308 を受けると `502`（`redirect_error`）になります。その場合は、リダイレクト後の最終 URL をエンドポイントに指定してください
- `content-encoding` は展開済みのボディとして返し、`content-length` / `transfer-encoding` などは取り除きます
- 転送するのは HTTP のみです（WebSocket は扱いません）

## 7. モックサーバーのシナリオ

`pnpm mock`（`mock-server/`）は、API キー不要で AI SDK 互換のレスポンスを返します。

| エンドポイント                         | 内容                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /api/chat`                       | UI Message Stream（SSE）。Chat (UI Message Stream) 用                         |
| `POST /api/text`                       | プレーンテキストのストリーム。Chat (Text Stream) 用                           |
| `POST /api/completion[?protocol=text]` | `data`（既定）/ `text` プロトコル。Completion 用                              |
| `ANY /api/json[?delay=ms&status=418]`  | リクエストの JSON エコー。Raw 用（`delay` は 0〜30000、`status` は 200〜599） |
| `GET /api/scenarios`                   | シナリオ一覧（JSON）                                                          |
| `GET /api/chat/:id/stream`             | `useChat` の再接続用。再開すべきストリームは無いので 204                      |
| `GET /health`                          | 生存確認                                                                      |

```bash
curl http://localhost:28787/health
curl -N -X POST "http://localhost:28787/api/chat?scenario=slow" -H "content-type: application/json" -d '{"messages":[]}'
```

**シナリオの選び方**（優先順）: `body.scenario`（追加ボディに `{"scenario": "auth"}` など）→ クエリ `?scenario=` → 本文先頭の `#名前`（`#error エラーを起こして` のように、直後に空白か末尾）→ 既定の `text`。`body` / クエリで未知の名前を指定すると 400（`unknown_scenario`）、未知の `#名前` は普通の文字として扱います。

### `/api/chat`（UI Message Stream）

チャットの空状態に出るチップは、★ を付けたシナリオです。それ以外は、本文の先頭に `#名前` を書くと選べます。

| 名前            | 内容                                                                                        | 何の確認に使うか                                                        |
| --------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `text` ★        | 日本語 / 英語の短い応答を単語ずつ流す（既定）                                               | 基本の送受信・ストリーミング表示                                        |
| `markdown` ★    | 見出し・リスト・コードブロック・表を含む長めの Markdown                                     | Markdown の描画、長文のストリーム                                       |
| `reasoning` ★   | reasoning パートの後に本文                                                                  | 思考過程の折りたたみ表示                                                |
| `tool` ★        | サーバー実行ツール `getWeather`（入力ストリーム → 出力 → 2 ステップ目の本文）               | ツール呼び出しの入力・出力の描画                                        |
| `tool-error` ★  | ツール実行が失敗する（`tool-output-error`）→ 本文                                           | ツール失敗の表示                                                        |
| `client-tool` ★ | クライアント実行ツール `askForConfirmation`（入力で終了）。出力つきで再送すると最終テキスト | 手動の出力返却と、継続リクエストの再送（自動 / 手動）                   |
| `approval` ★    | ツール承認 `deleteFile`（承認要求で終了）。承認 / 拒否つきで再送すると結果 + 本文           | ツール承認フローと継続リクエスト                                        |
| `sources` ★     | `source-url` ×2 と `source-document` ×1                                                     | ソースの表示                                                            |
| `file` ★        | data URL の画像（PNG）を `file` パートで返す                                                | 画像・ファイルの表示                                                    |
| `data` ★        | `data-weather`（同じ id で更新）と transient な `data-notification`                         | `data-*` パートの更新と、transient が `onData` にだけ届くこと           |
| `metadata` ★    | `start` / `finish` に `messageMetadata` を含める                                            | `message.metadata`                                                      |
| `echo` ★        | 受信した method / ヘッダー / body をテキストで返す                                          | 追加ヘッダー・追加ボディ・「最後のみ送信」・Bearer が実際に届いているか |
| `slow` ★        | 約 400ms / トークンで 20 トークン（約 8 秒）。切断を検知して停止                            | 停止ボタン、`aborted` の診断                                            |
| `error` ★       | 本文を途中まで流してから `type:"error"` chunk を送る                                        | `ui-stream-error-chunk` とエラー表示                                    |
| `keepalive`     | 本文の合間に SSE コメント行（`: ping`）を挟む                                               | SSE コメント行の扱い（ストリームタブの「SSE コメント」）                |
| `abort`         | 本文を途中まで流してからソケットを切断                                                      | `ui-stream-truncated` と、受信中の切断                                  |
| `no-header`     | `x-vercel-ai-ui-message-stream` ヘッダーなしで正常なストリームを返す                        | `ui-stream-header` の警告（ヘッダー無しでも SDK は動く）                |
| `bad-json`      | 正常な chunk の間に壊れた JSON の行を混ぜる                                                 | `sse-invalid-json`                                                      |
| `no-done`       | 正常なストリームだが末尾の `data: [DONE]` を送らない                                        | `ui-stream-no-done`                                                     |
| `http-500`      | HTTP 500（JSON）                                                                            | `http-status` の error 表示                                             |
| `http-401`      | HTTP 401（JSON + `WWW-Authenticate`）                                                       | 認証エラーの診断                                                        |
| `auth`          | `Authorization: Bearer test-token` が無ければ 401、あれば正常なストリーム                   | Bearer トークン・Authorization ヘッダーの送信確認                       |

### `/api/text`・`/api/completion`（テキストのみ）

チップが出るのは Chat (Text Stream) の空状態だけで、`text` / `slow` / `echo` の 3 つです。Completion にシナリオのチップはありません。プロンプトの先頭に `#名前` を書くか、追加ボディやクエリで指定します。

| 名前       | 内容                                                             | 何の確認に使うか                                 |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| `text`     | 短い応答を単語ずつ流す（既定）                                   | 基本の送受信                                     |
| `slow`     | 約 400ms / トークンで 20 トークン                                | 停止ボタン                                       |
| `error`    | 途中まで流して失敗（`data` は `error` chunk、`text` は接続切断） | 途中失敗時の表示                                 |
| `empty`    | 本文が空のレスポンス                                             | 「出力が空」の表示（プロトコル不一致の見分け方） |
| `echo`     | 受信した method / ヘッダー / body をテキストで返す               | ヘッダー・追加ボディの到達確認                   |
| `http-500` | HTTP 500（JSON）                                                 | `http-status` の error 表示                      |
| `http-401` | HTTP 401（JSON + `WWW-Authenticate`）                            | 認証エラーの診断                                 |
| `auth`     | `Authorization: Bearer test-token` が無ければ 401、あれば正常    | Bearer トークンの送信確認                        |

## 8. セキュリティと保存

| 対象                                                                         | 保存先                                           | 寿命                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- |
| 接続設定（モード・エンドポイント・追加ヘッダー・追加ボディ・Raw の入力など） | `localStorage`（`ai-sdk-tester:settings:v1`）    | 残る（オリジンごと）                  |
| Bearer トークン                                                              | `sessionStorage`（`ai-sdk-tester:bearer-token`） | タブを閉じると消える                  |
| ネットワークログ・会話                                                       | メモリのみ                                       | リロードで消える（ログは最大 200 件） |
| テーマ（システム / ライト / ダーク）                                         | ブラウザのストレージ                             | 残る                                  |

- **追加ヘッダーに入れた `Authorization` や `x-api-key` の値は、`localStorage` に平文で保存されます。** Bearer トークンだけが `sessionStorage` です。保存を残したくない秘密は Bearer トークン欄に入れ、使い終わったら「設定をリセット」を押してください。追加ボディ・Raw のボディに入れた秘密も同じく `localStorage` に残ります
- 通信ログはメモリにだけ置き、外部へは送りません。ログを JSON で保存するときは、「秘匿情報を表示」が OFF ならヘッダー・URL・本文の秘匿情報をマスクします（キー名にもとづく推定なので、共有前に内容を確認してください。詳しくは[秘匿情報のマスクと cURL](#秘匿情報のマスクと-curl)）
- 接続先から返った内容（Markdown・画像・ソースの URL など）をそのまま描画します。信頼できないサーバーには接続しないでください
- このアプリ自身には認証がなく、dev プロキシは任意の URL への踏み台になります。**本番環境・共有環境・LAN への公開は想定していません。** `pnpm build` の成果物を静的に配信しても、dev プロキシは含まれません
- 共有 PC や画面共有では、「秘匿情報を表示」を OFF のままにしてください

## 9. 開発

### スクリプト

| コマンド            | 内容                                                           |
| ------------------- | -------------------------------------------------------------- |
| `pnpm dev`          | 開発サーバー（Vite。既定 5199。dev プロキシつき）              |
| `pnpm mock`         | モックバックエンド（`node mock-server/server.ts`。既定 28787） |
| `pnpm build`        | 型チェック（`tsc -b`）のあと `vite build`（出力は `dist/`）    |
| `pnpm preview`      | ビルド結果の確認（dev プロキシつき）                           |
| `pnpm typecheck`    | `tsc -b`                                                       |
| `pnpm lint`         | `oxlint`                                                       |
| `pnpm format`       | `prettier --write .`                                           |
| `pnpm format:check` | `prettier --check .`                                           |
| `pnpm test`         | `vitest run`（全テスト）                                       |
| `pnpm test:watch`   | `vitest`（監視モード）                                         |
| `pnpm check`        | `typecheck` → `lint` → `format:check` → `test` を順に実行      |

変更したら `pnpm check` が通ることを確認してください。個別のテストは `pnpm exec vitest run <パス>` で実行できます。

### 全体の流れ

`useChat` / `useCompletion` に渡す `fetch` は `src/lib/tester-fetch.ts` の `createTesterFetch` で、SDK が渡す URL やヘッダーは使いません。送信のたびに `request-shaper.ts` が設定（エンドポイント・ヘッダー・Bearer・追加ボディ・プロキシ）からリクエストを組み立て直し、レスポンスのボディを `tee()` で二分して、片方をネットワークログ（`network-log.ts`、SSE は `sse-parser.ts` で分解）に流します。ログから `stream-analyzer.ts` が診断を作ります。そのため、設定の変更は会話を保ったまま次の送信から反映されます。

### ディレクトリ構成

```text
.
├── mock-server/          AI SDK 互換のモックバックエンド（app.ts: HTTP / scenarios.ts: シナリオ / server.ts: CLI）
├── vite-plugins/         dev-proxy.ts（/__proxy。開発専用の CORS 回避プロキシ）
├── .claude/launch.json   Claude Code のプレビュー設定（app: 5199 / mock: 28787）
└── src/
    ├── types.ts          共有の型契約（設定・ネットワークログ・診断）
    ├── lib/              settings / settings-store、request-shaper、tester-fetch、network-log、
    │                     sse-parser、stream-analyzer（診断）、curl（マスク含む）、proxy、format
    ├── hooks/            use-settings、use-chat-session、use-completion-runner、use-raw-request、
    │                     use-network-log、use-proxy-status など
    ├── views/            chat-view / completion-view / raw-view（モードごとの画面）
    ├── components/
    │   ├── settings/ inspector/ chat/ completion/ raw/   各画面の部品
    │   ├── ui/           shadcn/ui（CLI 生成のベンダーコード）
    │   └── ai-elements/  AI Elements（CLI 生成のベンダーコード）
    └── App.tsx           3 カラムのレイアウト（設定 / モード画面 / インスペクタ）
```

### テスト

- テストは対象と同じ場所に `*.test.ts(x)` として置きます。`src/`・`vite-plugins/`・`mock-server/` が対象です
- 既定の環境は `node` です。コンポーネントのテストは、ファイルの先頭に `// @vitest-environment jsdom` を付けて切り替えます
- 実 HTTP のテストがあり、マシンが重いと遅くなるため、タイムアウトは 30 秒にしています

### ベンダーコードの更新

`src/components/ui/` と `src/components/ai-elements/` は CLI が生成したコードです。手で書き換えると、CLI で更新したときに上書きされます。リント・整形の対象からも外してあります（`.oxlintrc.json` の `ignorePatterns`、`.prettierignore`）。アプリ固有の見た目や挙動は `src/components/chat/` など、ベンダー以外のコンポーネントで包んでください。

```bash
# shadcn/ui のコンポーネントを追加・更新する（例: dialog）
pnpm dlx shadcn@latest add dialog

# AI Elements のコンポーネントを追加・更新する（例: message）
pnpm dlx ai-elements@latest add message
```

shadcn/ui の設定は `components.json`（スタイル `radix-nova`、エイリアス `@/components` など）にあります。AI Elements の使い方は <https://elements.ai-sdk.dev> を参照してください。

### コードの規約

- ファイル名は kebab-case（`test-case.tsx`）、コンポーネントは PascalCase、フックは `useXxx` です
- コメントは日本語で、コードを読んでも分からない「なぜ」だけを書きます

## 10. トラブルシューティング

### `Failed to fetch` / CORS エラーで失敗する

接続先がこのページと別オリジンのとき、診断の `network-error` に「CORS が許可されていない可能性があります」と出ます（接続先が停止している・URL やポートが違う場合も同じエラーになるので、あわせて確認してください）。次のどちらかで解消します。

1. 設定の「devプロキシ経由で送信」を ON にする（`pnpm dev` / `pnpm preview` で起動しているときだけ使えます）
2. バックエンドで CORS を許可する
   - `Access-Control-Allow-Origin`
   - プリフライト（`OPTIONS`）への応答
   - `Authorization` などの独自ヘッダーを送るなら `Access-Control-Allow-Headers`
   - `x-vercel-ai-ui-message-stream` を見せたいなら `Access-Control-Expose-Headers`
   - credentials が `include` のときは、`*` ではなく Origin を明示した `Access-Control-Allow-Origin` と `Access-Control-Allow-Credentials: true`

`MOCK_CORS=0 pnpm mock` で、CORS エラーとプロキシでの回避を再現できます。

### devプロキシが「利用不可」になる

- 静的ホスティングやビルド済みファイルの配信だけでは使えません。`pnpm dev` か `pnpm preview` で起動してください
- ブラウザで <http://localhost:5199/__proxy> を開いて `{"proxy":"ai-sdk-tester","version":1}` が返るか確認します。HTML が返るときは、別のサーバーが同じポートで動いているか、プロキシが無い環境です
- 診断の `proxy-unavailable` は、プロキシではなく別の応答（404 / HTML）が返ったことを示します。転送先のサーバー自身が 404 や HTML を返している場合も同じ表示になるので、転送先の URL とパスも確認してください

### プロキシ経由で `502` / `proxy_error` になる

- 転送先に接続できていません。ホスト名・ポート・サーバーの起動状態を確認してください。`localhost` が `::1`（IPv6）に解決されるのに、サーバーが `127.0.0.1` だけで待ち受けていると失敗することがあります。その場合は `http://127.0.0.1:<ポート>` を直接指定してください
- `proxy_error: fetch failed` だけでほかに手がかりが無いときは、ボディ付きリクエストがリダイレクトされている可能性があります（[制約と注意](#制約と注意)）。リダイレクト後の最終 URL を指定してください
- `403 forbidden` は、開発サーバーと別のホスト名・別のサイトからページを開いているときに出ます

### ポートが使用中

[ポートが他のプロジェクトと衝突するとき](#ポートが他のプロジェクトと衝突するとき)のとおり、`pnpm dev --port <ポート>` と `MOCK_PORT=<ポート> pnpm mock` で変更できます。`pnpm mock` は使用中のポートを指定されると、メッセージを出して終了します。

### `pnpm mock` が起動しない

`Unknown file extension ".ts"` のようなエラーは、Node.js が古い（22.18 未満）ためです。Node.js を更新してください。

### ストリームが流れてこない / 最後にまとめて表示される

- インスペクタのストリームタブで、各イベントの経過ミリ秒を確認してください。ほぼ同時刻に並んでいるなら、サーバーやリバースプロキシ・CDN がバッファしています（nginx なら `proxy_buffering off` や `X-Accel-Buffering: no`、圧縮の無効化を確認）
- Chat (UI Message Stream) では、`content-type` が `text/event-stream` であることを確認してください（診断の `content-type`）
- 何も表示されない Completion は、プロトコル（`data` / `text`）がバックエンドの返し方と合っているか確認してください
- プレーンテキストを返すバックエンドは、Chat (Text Stream) で試してください（Chat (UI Message Stream) では診断の `content-type` が警告します）

### `x-vercel-ai-ui-message-stream: v1 ヘッダーがありません` という警告

UI Message Stream は、このヘッダーを付けて返すのが仕様です（`createUIMessageStreamResponse` が自動で付けます）。ただしクライアント SDK はこのヘッダーを必須としておらず、無くても動作します。自前で SSE を組み立てているなら追加してください。

クロスオリジンで `info`（「確認できません」）になるときは、サーバーが送っていても `Access-Control-Expose-Headers` に含まれていないためブラウザから読めていない可能性があります。

### 401 / 403 で拒否される

Bearer トークンの値と有効期限を確認してください。追加ヘッダーに有効な `Authorization` があると、Bearer トークンは**使われません**（設定パネルにもその旨が出ます）。

### 設定が消えた / 引き継がれない

- Bearer トークンは `sessionStorage` だけに保存されるので、タブを閉じると消えます
- そのほかの設定は `localStorage` に保存されますが、オリジン（ポート込み）ごとです。テストサイトのポートを変えると、設定は別になります
- 設定パネルの「設定をリセット」を押すと、保存された設定とトークンを消して初期値に戻ります
