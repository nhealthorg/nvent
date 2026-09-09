import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'

export type ComposeStartupErrorCode =
  | 'PROJECT_DID_NOT_START'
  | 'STARTUP_TIMEOUT'
  | 'INVALID_NAMESPACE'
  | 'ENGINE_STARTUP_TIMEOUT'
  | 'MANAGED_ENGINE_ENDPOINT_MISMATCH'
  | 'COMPOSE_UP_FAILED'

export class ComposeStartupError extends Error {
  readonly code: ComposeStartupErrorCode
  readonly hint: string
  readonly detail?: string

  constructor(code: ComposeStartupErrorCode, message: string, hint: string, detail?: string) {
    const lines = [`[${code}] ${message}`, `hint: ${hint}`]
    if (detail) lines.push(`detail: ${detail}`)
    super(lines.join('\n'))
    this.name = 'ComposeStartupError'
    this.code = code
    this.hint = hint
    this.detail = detail
  }
}

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

interface ComposeStartupErrorContext {
  daemonNamespace: string
  composeFilePath: string
  upTimeoutMs: number
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

export function classifyComposeStartupError(detail?: string): ComposeStartupErrorCode {
  const text = String(detail ?? '').toLowerCase()

  if (/invalid\s+namespace|namespace\s+.*invalid|unknown\s+namespace/.test(text)) {
    return 'INVALID_NAMESPACE'
  }
  if (/engine\s+startup\s+timeout|engine\s+.*timed\s*out/.test(text)) {
    return 'ENGINE_STARTUP_TIMEOUT'
  }
  if (/managed\s+engine\s+endpoint\s+mismatch|endpoint\s+mismatch|engine\s+endpoint\s+.*mismatch/.test(text)) {
    return 'MANAGED_ENGINE_ENDPOINT_MISMATCH'
  }
  if (/startup\s+timeout|timed\s*out|up\s+timeout/.test(text)) {
    return 'STARTUP_TIMEOUT'
  }
  if (/child_exited_before_registration|project\s+.*did\s+not\s+start|exited\s+before\s+startup\s+completed|address\s+already\s+in\s+use/.test(text)) {
    return 'PROJECT_DID_NOT_START'
  }

  return 'COMPOSE_UP_FAILED'
}

function composeStartupHint(code: ComposeStartupErrorCode, ctx: ComposeStartupErrorContext): string {
  switch (code) {
    case 'INVALID_NAMESPACE':
      return `Check nvent.iii.namespace and compose daemon namespace. Current daemon namespace: '${ctx.daemonNamespace}'.`
    case 'ENGINE_STARTUP_TIMEOUT':
      return `Engine workers did not become ready in time. Inspect compose logs and increase nvent.iii.compose.upTimeoutMs if startup is expected to be slow.`
    case 'MANAGED_ENGINE_ENDPOINT_MISMATCH':
      return `Ensure compose is allowed to manage the engine URL from worker-compose.yaml and avoid overriding with conflicting external endpoints.`
    case 'STARTUP_TIMEOUT':
      return `Compose startup exceeded ${ctx.upTimeoutMs}ms. Check worker startup logs or raise nvent.iii.compose.upTimeoutMs.`
    case 'PROJECT_DID_NOT_START':
      return `A project worker failed to come up. Check for port collisions and inspect compose logs for failing container entries.`
    default:
      return `Compose startup failed. Inspect daemon logs for ${ctx.composeFilePath}.`
  }
}

function createComposeStartupError(detail: string | undefined, ctx: ComposeStartupErrorContext): ComposeStartupError {
  const code = classifyComposeStartupError(detail)
  const message = `Compose startup failed for namespace '${ctx.daemonNamespace}' using ${ctx.composeFilePath}.`
  const hint = composeStartupHint(code, ctx)
  return new ComposeStartupError(code, message, hint, detail)
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
      const startupContext: ComposeStartupErrorContext = {
        daemonNamespace,
        composeFilePath,
        upTimeoutMs,
      }
      while (Date.now() - startTs < upTimeoutMs) {
        if (progress.completed) return
        if (progress.failed) {
          throw createComposeStartupError(progress.failureLine || 'compose up failed', startupContext)
        }
        if (!this.isRunning()) {
          throw createComposeStartupError('compose daemon exited before startup completed', startupContext)
        }
        await sleep(100)
      }
      throw createComposeStartupError(`compose up timeout after ${upTimeoutMs}ms`, startupContext)
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
