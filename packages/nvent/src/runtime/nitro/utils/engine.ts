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

/**
 * Strip the redundant timestamp and level tag the engine embeds in each line.
 * Consola adds its own, so showing both is noisy.
 * "[01:06:00.947 PM] [WARN] iii::services Bad format"  →  "iii::services Bad format"
 */
function cleanEngineLine(line: string): string {
  return line
    .replace(/\[\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:\s*[AP]M)?\]\s*/gi, '')
    .replace(/\[(ERROR|WARN|INFO)\]\s*/g, '')
    .trim()
}


export class EngineManager {
  private process: ChildProcess | null = null
  private readonly opts: Required<EngineManagerOptions>

  // Counts of non-error lines seen since the last summary was printed.
  private startupCounts: Record<string, number> = {}
  private runtimeCounts: Record<string, number> = {}
  private startupComplete = false

  // Pending continuation-line group (debounced 60 ms so └ lines attach to parent).
  private pendingGroup: { level: LogLevel; lines: string[] } | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: EngineManagerOptions) {
    this.opts = { httpPort: 3111, wsPort: 49134, logLevel: 'warn', ...opts }
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private handleGroup(level: LogLevel, lines: string[]): void {
    const { logLevel } = this.opts
    if (logLevel === 'none') return

    const text = lines.join('\n  ')

    // Errors always surface immediately regardless of mode.
    if (level === 'error') {
      logger.error(`[iii] ${text}`)
      return
    }

    // In verbose mode stream everything cleaned.
    if (logLevel === 'info') {
      if (level === 'warn') logger.warn(`[iii] ${text}`)
      else logger.info(`[iii] ${text}`)
      return
    }

    // Silent mode: just count.
    const bucket = this.startupComplete ? this.runtimeCounts : this.startupCounts
    bucket[level] = (bucket[level] ?? 0) + 1
  }

  private flushPendingGroup(): void {
    if (!this.pendingGroup) return
    const { level, lines } = this.pendingGroup
    this.pendingGroup = null
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
    this.handleGroup(level, lines)
  }

  private bufferRawLine(level: LogLevel | null, rawLine: string): void {
    const cleaned = cleanEngineLine(rawLine)
    if (level !== null) {
      this.flushPendingGroup()
      this.pendingGroup = { level, lines: [cleaned] }
    }
    else if (this.pendingGroup) {
      this.pendingGroup.lines.push(cleaned)
    }
    else {
      this.pendingGroup = { level: 'warn', lines: [cleaned] }
    }
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = setTimeout(() => this.flushPendingGroup(), 60)
  }

  private summaryCounts(counts: Record<string, number>): string | null {
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    if (total === 0) return null
    const parts = Object.entries(counts).map(([l, n]) => `${n} ${l}`)
    return parts.join(', ')
  }

  private flushStartupSummary(): void {
    this.startupComplete = true
    const summary = this.summaryCounts(this.startupCounts)
    this.startupCounts = {}
    if (!summary) return
    logger.warn(`[iii] ${summary} message(s) suppressed during startup — set nvent.iii.logLevel:'info' to see all`)
  }

  private flushRuntimeSummary(): void {
    const summary = this.summaryCounts(this.runtimeCounts)
    this.runtimeCounts = {}
    if (!summary) return
    logger.warn(`[iii] ${summary} message(s) suppressed — set nvent.iii.logLevel:'info' to see all`)
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      logger.warn('iii engine is already running')
      return
    }

    const { binaryPath, configPath, httpPort, wsPort, logLevel } = this.opts
    if (logLevel === 'info') logger.info(`Starting iii engine — config: ${configPath}`)

    this.startupCounts = {}
    this.runtimeCounts = {}
    this.startupComplete = false

    this.process = spawn(binaryPath, ['--config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    this.process.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean))
        this.bufferRawLine(parseEngineLineLevel(line), line)
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean))
        this.bufferRawLine('warn', line)
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

    this.flushPendingGroup()
    this.flushStartupSummary()

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

    logger.info(`[iii] engine ready`)
  }

  async stop(): Promise<void> {
    if (!this.isRunning() || !this.process) return

    const { logLevel } = this.opts
    this.flushPendingGroup()
    this.flushRuntimeSummary()

    if (logLevel === 'info') logger.info('Stopping iii engine...')
    return new Promise((resolve) => {
      this.process!.once('exit', () => {
        this.process = null
        if (logLevel === 'info') logger.info('iii engine stopped')
        resolve()
      })
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
