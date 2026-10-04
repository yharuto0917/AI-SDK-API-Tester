import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

interface Running {
  child: ChildProcess
  origin: string
  output: () => string
}

/** `node mock-server/server.ts` を実際に起動し、バナーから待ち受けアドレスを読み取る。 */
function launch(env: Record<string, string>): Promise<Running> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['mock-server/server.ts'], {
      cwd: projectRoot,
      env: { ...process.env, MOCK_PORT: '0', ...env },
    })
    let output = ''
    const timer = setTimeout(
      () => reject(new Error(`起動がタイムアウトしました:\n${output}`)),
      10_000,
    )
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolve({ child, origin: match[1], output: () => output })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`起動直後に終了しました (code ${code}):\n${output}`))
    })
  })
}

function stop(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode)
      return
    }
    child.once('exit', (code) => resolve(code))
    child.kill('SIGINT')
  })
}

describe('node mock-server/server.ts（CLI）', () => {
  let running: Running | undefined

  afterEach(async () => {
    if (running !== undefined) await stop(running.child)
    running = undefined
  })

  it('型ストリップで直接実行でき、バナーに全エンドポイントとシナリオを出し、SIGINT で終了する', async () => {
    running = await launch({})
    const banner = running.output()
    for (const text of [
      '/health',
      '/api/scenarios',
      '/api/chat',
      '/api/text',
      '/api/completion',
      '/api/json',
    ]) {
      expect(banner).toContain(text)
    }
    for (const name of [
      'markdown',
      'client-tool',
      'approval',
      'echo',
      'bad-json',
      'http-401',
      'auth',
    ]) {
      expect(banner).toContain(name)
    }
    expect(banner).toContain('CORS: 有効')

    const res = await fetch(`${running.origin}/health`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    expect(await stop(running.child)).toBe(0)
    running = undefined
  })

  it('MOCK_CORS=0 で CORS ヘッダーを付けない', async () => {
    running = await launch({ MOCK_CORS: '0' })
    expect(running.output()).toContain('CORS: 無効')
    const res = await fetch(`${running.origin}/health`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('不正な MOCK_PORT はエラー終了する', async () => {
    await expect(launch({ MOCK_PORT: 'abc' })).rejects.toThrow(/MOCK_PORT が不正/)
  })

  it('import しただけでは listen しない（プロセスが自分で終了する）', async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "await import('./mock-server/server.ts'); console.log('imported')",
      ],
      { cwd: projectRoot, env: { ...process.env, MOCK_PORT: '0' } },
    )
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(null)
      }, 8000)
      child.once('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
    })
    // listen していればイベントループが残って終了しない（タイムアウトで null になる）
    expect(code).toBe(0)
    expect(output).toContain('imported')
    expect(output).not.toContain('エンドポイント')
  })
})
