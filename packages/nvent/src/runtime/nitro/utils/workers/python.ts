/**
 * Python Worker Manager
 *
 * Manages spawning and lifecycle of Python worker processes that connect
 * Python functions to the iii engine.
 *
 * Lives in src/iii/ so it can be used by both:
 *   - module.ts (dev) — starts workers in the Nuxt process for HMR
 *   - the Nitro plugin (prod) — starts workers at server startup
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { consola } from 'consola'

const logger = consola.withTag('nvent:python')

type LogLevel = 'info' | 'warn' | 'error'

/** Parse log level from a Python logging line: "[INFO] ...", "[WARNING] ...", "[ERROR] ..." */
function parsePythonLineLevel(line: string): LogLevel | null {
  if (line.startsWith('[ERROR]') || line.startsWith('[CRITICAL]')) return 'error'
  if (line.startsWith('[WARNING]') || line.startsWith('[WARN]')) return 'warn'
  if (line.startsWith('[INFO]')) return 'info'
  if (line.startsWith('[DEBUG]')) return 'info'
  return null
}

const LOG_LEVEL_RANK: Record<string, number> = { none: 0, error: 1, warn: 2, info: 3 }

function shouldShow(lineLevel: LogLevel, minLevel: string): boolean {
  return (LOG_LEVEL_RANK[lineLevel] ?? 0) <= (LOG_LEVEL_RANK[minLevel] ?? 0)
}

const MAX_BACKOFF_MS = 30_000

/** Minimal function descriptor — matches PythonFunctionMeta from registry.ts */
export interface PyFnInfo {
  id: string
  absPath: string
  standalone: boolean
}

export class PythonWorkerManager {
  private process: ChildProcess | null = null
  private stopped = false
  private restartAttempts = 0

  constructor(
    /** Absolute path to _runtime.py */
    private readonly runtimeScript: string,
    private readonly wsUrl: string,
    private readonly workerName: string,
    private readonly fns: PyFnInfo[],
    private readonly python: string = 'python3',
    private readonly logLevel: string = 'warn',
  ) {}

  isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null
  }

  async start(): Promise<void> {
    if (this.isRunning()) return
    this.stopped = false
    this.restartAttempts = 0
    this._spawn()
  }

  async restart(): Promise<void> {
    this.stopped = true
    await this._kill()
    this.stopped = false
    this.restartAttempts = 0
    this._spawn()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this._kill()
  }

  private _spawn(): void {
    if (this.logLevel === 'info') logger.info(`Starting Python worker — ${this.workerName}`)

    // _runtime.py <ws_url> <worker_name> <path1> <id1> [<path2> <id2> ...]
    const fnArgs = this.fns.flatMap(fn => [fn.absPath, fn.id])
    this.process = spawn(this.python, [this.runtimeScript, this.wsUrl, this.workerName, ...fnArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    let stdoutBuffer = ''
    this.process.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdoutBuffer += text
      if (this.logLevel === 'none') return
      for (const line of text.split('\n').filter(Boolean)) {
        const level = parsePythonLineLevel(line) ?? 'info'
        if (!shouldShow(level, this.logLevel)) continue
        if (level === 'error') logger.error(`[python] ${line}`)
        else if (level === 'warn') logger.warn(`[python] ${line}`)
        else logger.info(`[python] ${line}`)
      }
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      if (this.logLevel === 'none') return
      for (const line of chunk.toString().split('\n').filter(Boolean))
        logger.error(`[python] ${line}`)
    })

    this.process.on('exit', (code, signal) => {
      if (this.logLevel === 'info') logger.info(`Python worker exited (code=${code}, signal=${signal})`)
      this.process = null
      if (this.stopped) return

      if (code === 1 && stdoutBuffer.includes('iii package not found')) {
        logger.error('Python worker stopped: iii SDK not installed. Run: pip install iii-sdk')
        this.stopped = true
        return
      }
      this._scheduleRestart()
    })

    this.process.on('error', (err) => {
      logger.error(`Python worker process error: ${err.message}`)
      this.process = null
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.error(`Python binary not found: ${this.python}. Check functions.python.path in nvent config.`)
        this.stopped = true
        return
      }
      if (!this.stopped) this._scheduleRestart()
    })
  }

  private _scheduleRestart(): void {
    this.restartAttempts++
    const delay = Math.min(500 * 2 ** this.restartAttempts, MAX_BACKOFF_MS)
    logger.warn(`Python worker will restart in ${delay}ms (attempt ${this.restartAttempts})`)
    setTimeout(() => { if (!this.stopped) this._spawn() }, delay)
  }

  private _kill(): Promise<void> {
    if (!this.isRunning() || !this.process) return Promise.resolve()
    return new Promise((resolve) => {
      this.process!.once('exit', () => { this.process = null; resolve() })
      this.process!.kill('SIGTERM')
      setTimeout(() => { if (this.process) this.process.kill('SIGKILL') }, 5000)
    })
  }
}

/**
 * Orchestrates all Python workers:
 * - Shared worker: one process for all non-standalone functions
 * - Standalone workers: one dedicated process per function with `standalone: true`
 */
export class PythonWorkersOrchestrator {
  private workers = new Map<string, PythonWorkerManager>()
  private lastFns: PyFnInfo[] = []
  private runtimeScript: string

  constructor(
    private readonly workersDir: string,
    /** Content of worker_runtime.py, written to workersDir/_runtime.py */
    private readonly runtimeContent: string,
    /** Content of nvent.py, written to workersDir/nvent.py */
    private readonly nventHelperContent: string,
    private readonly wsUrl: string,
    private readonly pythonBin: string,
    private readonly logLevel: string = 'warn',
  ) {
    this.runtimeScript = join(workersDir, '_runtime.py')
  }

  async start(fns: PyFnInfo[]): Promise<void> {
    this.lastFns = fns
    if (fns.length === 0) return
    this._prepareDir()

    const sharedFns = fns.filter(fn => !fn.standalone)
    const standaloneFns = fns.filter(fn => fn.standalone)

    if (sharedFns.length > 0) {
      const worker = this._makeWorker('__shared__', sharedFns)
      await worker.start()
      this.workers.set('__shared__', worker)
    }

    for (const fn of standaloneFns) {
      const worker = this._makeWorker(fn.id, [fn])
      await worker.start()
      this.workers.set(fn.id, worker)
    }
  }

  /** Called when a Python source file changes. Pass updated fns to handle additions/removals. */
  async onFileChanged(changedPath: string, fns?: PyFnInfo[]): Promise<void> {
    const effectiveFns = fns ?? this.lastFns
    this.lastFns = effectiveFns
    this._prepareDir()

    const sharedFns = effectiveFns.filter(fn => !fn.standalone)
    const standaloneFns = effectiveFns.filter(fn => fn.standalone)
    const changedFn = effectiveFns.find(fn => fn.absPath === changedPath)
    const affectsShared = !changedFn?.standalone

    if (affectsShared) {
      if (sharedFns.length > 0) {
        const existing = this.workers.get('__shared__')
        if (existing) { await existing.restart() }
        else {
          const worker = this._makeWorker('__shared__', sharedFns)
          await worker.start()
          this.workers.set('__shared__', worker)
        }
      }
      else {
        const existing = this.workers.get('__shared__')
        if (existing) { await existing.stop(); this.workers.delete('__shared__') }
      }
    }

    if (changedFn?.standalone) {
      const existing = this.workers.get(changedFn.id)
      if (existing) { await existing.restart() }
      else {
        const worker = this._makeWorker(changedFn.id, [changedFn])
        await worker.start()
        this.workers.set(changedFn.id, worker)
      }
    }

    // Clean up workers for removed functions
    for (const [id, worker] of this.workers) {
      if (id === '__shared__') continue
      if (!effectiveFns.find(fn => fn.id === id)) { await worker.stop(); this.workers.delete(id) }
    }

    // Start workers for newly added standalone functions
    for (const fn of standaloneFns) {
      if (!this.workers.has(fn.id)) {
        const worker = this._makeWorker(fn.id, [fn])
        await worker.start()
        this.workers.set(fn.id, worker)
      }
    }
  }

  async stop(): Promise<void> {
    for (const worker of this.workers.values()) await worker.stop()
    this.workers.clear()
  }

  private _prepareDir(): void {
    mkdirSync(this.workersDir, { recursive: true })
    writeFileSync(this.runtimeScript, this.runtimeContent, 'utf-8')
    writeFileSync(join(this.workersDir, 'nvent.py'), this.nventHelperContent, 'utf-8')
  }

  private _makeWorker(name: string, fns: PyFnInfo[]): PythonWorkerManager {
    return new PythonWorkerManager(
      this.runtimeScript,
      this.wsUrl,
      `nvent-python-${name}`,
      fns,
      this.pythonBin,
      this.logLevel,
    )
  }
}
