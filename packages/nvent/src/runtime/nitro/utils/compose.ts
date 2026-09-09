import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'

export interface ComposeManagerOptions {
  binaryPath: string
  composeFilePath: string
  daemonNamespace: string
  /** Existing engine WebSocket endpoint (optional). */
  engineUrl?: string
  /** Run compose::up on daemon start. Default: true */
  upOnStart?: boolean
  /** Working directory for the compose daemon process. */
  workingDir?: string
  /** Optional compose state root directory (sets III_COMPOSE_STATE_DIR). */
  composeStateDir?: string
  /** Remove namespace project state before compose --up. Keeps package cache. */
  resetNamespaceStateOnStart?: boolean
  /** Minimum log level for daemon output. */
  logLevel?: 'none' | 'error' | 'warn' | 'info'
  /** Wait for compose --up completion before resolving start(). Default: true */
  waitForUp?: boolean
  /** Max time to wait for compose --up completion markers. Default: 120000 */
  upTimeoutMs?: number
  /** Compact startup logs: print only key lifecycle lines by default. */
  compactLogs?: boolean
}

type LogLevel = 'none' | 'error' | 'warn' | 'info'

interface UpProgress {
  completed: boolean
  failed: boolean
  failureLine?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function shouldLog(level: LogLevel, stream: 'stdout' | 'stderr'): boolean {
  if (level === 'none') return false
  if (level === 'error') return stream === 'stderr'
  if (level === 'warn') return stream === 'stderr'
  return true
}

function isComposeErrorLine(line: string): boolean {
  return /\berror(\[|:|\b)|\bfailed\b|\bexited unexpectedly\b|\bstartup timeout\b|\btimed out\b|\bcaused by\b|\baddress already in use\b/i.test(line)
}

function isComposeLifecycleLine(line: string): boolean {
  return /\bengine started\b|\bcompose serving\b|\bproject .* loaded\b|\bup:\s+(?:\d+\s+of\s+\d+\s+changed|nothing\s+to\s+do)\b|\bdown:\s+\d+\s+of\s+\d+\s+changed\b|\bstopping every project\b|\bstopping engine\b/i.test(line)
}

function normalizeComposeLine(line: string): string {
  return line
    .replace(/^\[compose(?::[^\]]+)?\]\s*/i, '')
    .replace(/^(stdout|stderr)\s+/i, '')
    .trim()
}

export class ComposeManager {
  private process: ChildProcess | null = null
  private readonly opts: Required<ComposeManagerOptions>

  constructor(opts: ComposeManagerOptions) {
    this.opts = {
      upOnStart: true,
      workingDir: process.cwd(),
      composeStateDir: '',
      resetNamespaceStateOnStart: false,
      logLevel: 'info',
      waitForUp: true,
      upTimeoutMs: 120_000,
      compactLogs: true,
      engineUrl: '',
      ...opts,
    }
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null
  }

  async start(): Promise<void> {
    if (this.isRunning()) return

    const {
      binaryPath,
      composeFilePath,
      daemonNamespace,
      engineUrl,
      upOnStart,
      composeStateDir,
      resetNamespaceStateOnStart,
      logLevel,
      waitForUp,
      upTimeoutMs,
      compactLogs,
      workingDir,
    } = this.opts

    if (composeStateDir) {
      mkdirSync(composeStateDir, { recursive: true })
      if (upOnStart && resetNamespaceStateOnStart) {
        // Clear prior resolved configs/logs for this daemon namespace while preserving packages cache.
        rmSync(`${composeStateDir}/${daemonNamespace}`, { recursive: true, force: true })
      }
    }

    const args = ['compose', '--namespace', daemonNamespace]
    // `iii compose --up` should use the engine section from worker-compose.yaml.
    // Passing `--engine` overrides that and disables managed engine startup.
    if (engineUrl && !upOnStart) args.push('--engine', engineUrl)
    if (upOnStart) {
      args.push('--up', '--file', composeFilePath)
    }

    if (shouldLog(logLevel, 'stdout')) {
      if (compactLogs) {
        console.log(`[nvent][compose] starting daemon (namespace=${daemonNamespace})`)
      }
      else {
        console.log(`[nvent][compose] exec ${binaryPath} ${args.join(' ')}`)
      }
    }

    const progress: UpProgress = { completed: false, failed: false }
    const processOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const normalizedLine = normalizeComposeLine(line)
        if (!normalizedLine) continue

        if (upOnStart && !progress.completed && !progress.failed) {
          if (/\bup:\s+(?:\d+\s+of\s+\d+\s+changed|nothing\s+to\s+do)\b/i.test(normalizedLine)) {
            progress.completed = true
          }
          if (isComposeErrorLine(normalizedLine) || /\bup failed\b/i.test(normalizedLine)) {
            progress.failed = true
            progress.failureLine = normalizedLine
          }
        }

        if (!shouldLog(logLevel, stream)) continue

        if (isComposeErrorLine(normalizedLine)) {
          console.error(`[nvent][compose] ${normalizedLine}`)
          continue
        }

        if (logLevel === 'info') {
          if (!compactLogs || isComposeLifecycleLine(normalizedLine)) {
            console.log(`[nvent][compose] ${normalizedLine}`)
          }
        }
      }
    }

    this.process = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      cwd: workingDir,
      env: {
        ...process.env,
        PATH: `${dirname(binaryPath)}${delimiter}${process.env.PATH ?? ''}`,
        ...(composeStateDir ? { III_COMPOSE_STATE_DIR: composeStateDir } : {}),
      },
    })

    this.process.stdout?.on('data', (chunk: Buffer) => processOutput('stdout', chunk))
    this.process.stderr?.on('data', (chunk: Buffer) => processOutput('stderr', chunk))

    this.process.on('error', (err) => {
      console.error(`[nvent] compose daemon process error: ${err.message}`)
      this.process = null
    })

    this.process.on('exit', (code, signal) => {
      if (logLevel === 'info') {
        console.info(`[nvent] compose daemon exited (code=${code}, signal=${signal})`)
      }
      this.process = null
    })

    if (upOnStart && waitForUp) {
      const startTs = Date.now()
      while (Date.now() - startTs < upTimeoutMs) {
        if (progress.completed) return
        if (progress.failed) {
          throw new Error(progress.failureLine || 'compose up failed')
        }
        if (!this.isRunning()) {
          throw new Error('compose daemon exited before startup completed')
        }
        await sleep(100)
      }
      throw new Error(`compose up timeout after ${upTimeoutMs}ms`)
    }
  }

  async stop(): Promise<void> {
    if (!this.process) return

    await new Promise<void>((resolve) => {
      const proc = this.process
      if (!proc) {
        resolve()
        return
      }
      proc.once('exit', () => {
        this.process = null
        resolve()
      })

      try {
        proc.kill('SIGTERM')
      }
      catch {
        try { proc.kill('SIGKILL') } catch {}
      }

      setTimeout(() => {
        if (!this.process) return
        try {
          this.process.kill('SIGKILL')
        }
        catch {}
      }, 5000)
    })
  }
}

export function createComposeManager(opts: ComposeManagerOptions): ComposeManager {
  return new ComposeManager(opts)
}
