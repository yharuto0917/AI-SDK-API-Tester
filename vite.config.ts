import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { devProxy } from './vite-plugins/dev-proxy.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), devProxy()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // 他プロジェクトの開発サーバー(5173/5174 など)と衝突しにくい固定ポート。.claude/launch.json と揃える
    port: 5199,
  },
  test: {
    environment: 'node',
    passWithNoTests: true,
    // 乱択テスト・実HTTPテストがあり、CI/多重起動でマシンが重いと既定の 5 秒を超えることがある
    testTimeout: 30_000,
    include: ['src/**/*.test.{ts,tsx}', 'vite-plugins/**/*.test.ts', 'mock-server/**/*.test.ts'],
    // コンポーネントテストは先頭に `// @vitest-environment jsdom` を付けて切り替える
    setupFiles: ['./src/test-setup.ts'],
  },
})
