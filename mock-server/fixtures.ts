/**
 * モック応答に使う固定データ。
 * 画像は外部ファイルに依存しないよう、実行時に PNG をその場で組み立てる。
 */
import { crc32, deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, checksum])
}

/** 斜めのグラデーションの小さな PNG（8bit RGB）を作る。 */
export function createGradientPng(width = 96, height = 64): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // ビット深度
  header[9] = 2 // カラータイプ: RGB
  // 圧縮 / フィルター / インターレースは 0（既定）のまま

  // 各行の先頭にフィルタータイプ 0 を付ける
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      const offset = rowStart + 1 + x * 3
      raw[offset] = Math.round((x / (width - 1)) * 255)
      raw[offset + 1] = Math.round((y / (height - 1)) * 255)
      raw[offset + 2] = 200
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

export function createGradientPngDataUrl(): string {
  return `data:image/png;base64,${createGradientPng().toString('base64')}`
}

/** markdown シナリオの本文。見出し・リスト・コード・表・引用など、描画側が崩れやすい記法を一通り含める。 */
export const MARKDOWN_SAMPLE = `# モックバックエンドの Markdown 応答

これは **Markdown のストリーミング描画** を確かめるための *長めの* 応答です。\`inline code\` や [リンク](https://sdk.vercel.ai) も含みます。

## 箇条書き

- 順序なしリスト 1
- 順序なしリスト 2
  - ネストした項目
  - もう一つのネスト
- 順序なしリスト 3

1. 番号つきリスト 1
2. 番号つきリスト 2
3. 番号つきリスト 3

- [x] 完了したタスク
- [ ] 未完了のタスク

## コードブロック

\`\`\`ts
import { streamText } from 'ai'

export async function POST(req: Request) {
  const { messages } = await req.json()
  const result = streamText({ model, messages })
  return result.toUIMessageStreamResponse()
}
\`\`\`

\`\`\`bash
pnpm mock
curl -N -X POST http://localhost:28787/api/chat -d '{"scenario":"slow"}'
\`\`\`

## 表

| シナリオ | 用途 | 特徴 |
| --- | --- | --- |
| text | 基本確認 | 単語ごとに流れる |
| tool | ツール表示 | 2 ステップ構成 |
| error | エラー処理 | 途中で error チャンク |

## 引用と区切り

> ストリーミング中でも、未完成の Markdown が崩れずに描画されるかを見ます。

---

### 数式っぽい文字列

インライン: $E = mc^2$

おしまいです。長い応答の末尾でもスクロールが追従するか確認してください。
`
