/**
 * iii Engine Process Manager — runtime util
 *
 * Manages the lifecycle of the local iii engine process.
 * Lives in src/runtime/nitro/utils/ so it is bundled into the Nitro output
 * and can be used from the lifecycle plugin in both dev and production.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { consola } from 'consola'

const logger = consola.withTag('nvent:iii-engine')

const READY_POLL_INTERVAL_MS = 200
const READY_TIMEOUT_MS = 15_000

async function pollReady(httpPort: number): Promise<void> {
  const url = `http://localhost:${httpPort}`
  const deadline = Date.now() + READY_TIMEOUT_MS

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) })
      if (res.status < 600) return
    }
    catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, READY_POLL_INTERVAL_MS))
  }

  throw new Error(`iii engine did not become ready within ${READY_TIMEOUT_MS}ms (HTTP port ${httpPort})`)
}

function isTcpPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    setTimeout(() => { socket.destroy(); resolve(false) }, 1000)
  })
}

export interface EngineManagerOptions {
  binaryPath: string
  configPath: string
  httpPort?: number
  wsPort?: number
  /** Minimum log level for engine output. Default: 'warn' */
  logLevel?: 'none' | 'error' | 'warn' | 'info'
}

type LogLevel = 'info' | 'warn' | 'error'

/** Parse the level tag from an iii engine log line. Returns null for continuation lines. */
function parseEngineLineLevel(line: string): LogLevel | null {
  if (line.includes('[ERROR]')) return 'error'
  if (line.includes('[WARN]')) return 'warn'
  if (line.includes('[INFO]')) return 'info'
  return null // continuation line (└, ├, indented)
}

const LOG_LEVEL_RANK: Record<string, number> = { none: 0, error: 1, warn: 2, info: 3 }

function shouldShow(lineLevel: LogLevel, minLevel: string): boolean {
  return LOG_LEVEL_RANK[lineLevel] <= LOG_LEVEL_RANK[minLevel]
}

export class EngineManager {
  private process: ChildProcess | null = null
  private readonly opts: Required<EngineManagerOptions>

  constructor(opts: EngineManagerOptions) {
    this.opts = { httpPort: 3111, wsPort: 49134, logLevel: 'warn', ...opts }
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      logger.warn('iii engine is already running')
      return
    }

    const { binaryPath, configPath, httpPort, wsPort, logLevel } = this.opts
    if (logLevel === 'info') logger.info(`Starting iii engine — config: ${configPath}`)

    this.process = spawn(binaryPath, ['--config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    let lastLevel: LogLevel = 'info'
    this.process.stdout?.on('data', (chunk: Buffer) => {
      if (logLevel === 'none') return
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const parsed = parseEngineLineLevel(line)
        if (parsed) lastLevel = parsed
        const effectiveLevel = parsed ?? lastLevel
        if (!shouldShow(effectiveLevel, logLevel)) continue
        if (effectiveLevel === 'error') logger.error(`[iii] ${line}`)
        else if (effectiveLevel === 'warn') logger.warn(`[iii] ${line}`)
        else logger.info(`[iii] ${line}`)
      }
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      if (logLevel === 'none') return
      for (const line of chunk.toString().split('\n').filter(Boolean))
        logger.warn(`[iii] ${line}`)
    })

    let earlyExitCode: number | null = null
    const earlyExitPromise = new Promise<void>((resolve) => {
      this.process!.once('exit', (code, signal) => {
        earlyExitCode = code
        if (!earlyExitCode && logLevel === 'info') logger.info(`iii engine exited (code=${code}, signal=${signal})`)
        this.process = null
        resolve()
      })
    })

    this.process.on('error', (err) => {
      logger.error(`iii engine process error: ${err.message}`)
      this.process = null
    })

    await Promise.race([pollReady(httpPort), earlyExitPromise])

    if (earlyExitCode !== null && earlyExitCode !== 0) {
      const [httpOk, wsOk] = await Promise.all([isTcpPortOpen(httpPort), isTcpPortOpen(wsPort)])
      if (httpOk && wsOk) {
        if (logLevel === 'info') logger.info(`iii engine already running on HTTP :${httpPort} / WS :${wsPort} — reusing`)
        return
      }
      throw new Error(
        `iii engine failed to start (exit code ${earlyExitCode}). `
        + `Ports ${httpPort} (HTTP) or ${wsPort} (WS) may be in use.`,
      )
    }

    if (logLevel === 'info') logger.info(`iii engine ready (WS :${wsPort}, HTTP :${httpPort})`)
  }

  async stop(): Promise<void> {
    if (!this.isRunning() || !this.process) return

    const { logLevel } = this.opts
    if (logLevel === 'info') logger.info('Stopping iii engine...')
    return new Promise((resolve) => {
      this.process!.once('exit', () => { this.process = null; if (logLevel === 'info') logger.info('iii engine stopped'); resolve() })
      this.process!.kill('SIGTERM')
      setTimeout(() => { if (this.process) this.process.kill('SIGKILL') }, 5000)
    })
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }
}

export function createEngineManager(opts: EngineManagerOptions): EngineManager {
  return new EngineManager(opts)
}
