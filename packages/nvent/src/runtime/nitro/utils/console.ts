/**
 * iii Console Process Manager — runtime util
 *
 * Manages the lifecycle of the iii-console process.
 * Lives in src/runtime/nitro/utils/ so it is bundled into the Nitro output.
 * Binary installation is handled separately by ensureIiiConsole in src/iii/console.ts.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { consola } from 'consola'

const logger = consola.withTag('nvent:console')

type LogLevel = 'info' | 'warn' | 'error'

function parseConsoleLineLevel(line: string): LogLevel | null {
  if (line.includes(' ERROR ') || line.includes('[ERROR]')) return 'error'
  if (line.includes(' WARN ') || line.includes('[WARN]')) return 'warn'
  if (line.includes(' INFO ') || line.includes('[INFO]')) return 'info'
  return null
}

const LOG_LEVEL_RANK: Record<string, number> = { none: 0, error: 1, warn: 2, info: 3 }

function shouldShow(lineLevel: LogLevel, minLevel: string): boolean {
  return LOG_LEVEL_RANK[lineLevel] <= LOG_LEVEL_RANK[minLevel]
}

export interface ConsoleManagerOptions {
  binaryPath: string
  /** Port for the console web UI. Default: 3113 */
  port?: number
  /** Engine HTTP API host. Default: 127.0.0.1 */
  engineHost?: string
  /** Engine HTTP port. Default: 3111 */
  enginePort?: number
  /** Engine WebSocket port. Default: 3112 */
  wsPort?: number
  /** SDK bridge port. Default: 49134 */
  bridgePort?: number
  /** Enable the Flow visualization page. Default: true */
  flow?: boolean
  /** Minimum log level for console process output. Default: 'warn' */
  logLevel?: 'none' | 'error' | 'warn' | 'info'
}

export class ConsoleManager {
  private process: ChildProcess | null = null
  private readonly opts: Required<ConsoleManagerOptions>

  constructor(opts: ConsoleManagerOptions) {
    this.opts = {
      port: 3113,
      engineHost: '127.0.0.1',
      enginePort: 3111,
      wsPort: 3112,
      bridgePort: 49134,
      flow: true,
      logLevel: 'warn',
      ...opts,
    }
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      logger.warn('iii-console is already running')
      return
    }

    const { binaryPath, port, engineHost, enginePort, wsPort, bridgePort, flow, logLevel } = this.opts

    const args = [
      '--port', String(port),
      '--engine-host', engineHost,
      '--engine-port', String(enginePort),
      '--ws-port', String(wsPort),
      '--bridge-port', String(bridgePort),
    ]
    if (flow) args.push('--enable-flow')

    if (logLevel === 'info') logger.info(`Starting iii-console on http://localhost:${port}`)

    this.process = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    this.process.stdout?.on('data', (chunk: Buffer) => {
      if (logLevel === 'none') return
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const level = parseConsoleLineLevel(line) ?? 'info'
        if (!shouldShow(level, logLevel)) continue
        if (level === 'error') logger.error(`[console] ${line}`)
        else if (level === 'warn') logger.warn(`[console] ${line}`)
        else logger.info(`[console] ${line}`)
      }
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      if (logLevel === 'none') return
      for (const line of chunk.toString().split('\n').filter(Boolean))
        logger.warn(`[console] ${line}`)
    })

    this.process.on('exit', (code, signal) => {
      if (logLevel === 'info') logger.info(`iii-console exited (code=${code}, signal=${signal})`)
      this.process = null
    })

    this.process.on('error', (err) => {
      logger.error(`iii-console process error: ${err.message}`)
      this.process = null
    })
  }

  async stop(): Promise<void> {
    if (!this.isRunning() || !this.process) return
    const { logLevel } = this.opts
    return new Promise((resolve) => {
      this.process!.once('exit', () => { this.process = null; if (logLevel === 'info') logger.info('iii-console stopped'); resolve() })
      this.process!.kill('SIGTERM')
      setTimeout(() => { if (this.process) this.process.kill('SIGKILL') }, 5000)
    })
  }
}
