/**
 * Workflow Worker Configuration Utility
 *
 * Provides configuration metadata for the Rust workflow orchestrator worker.
 * The actual process management is handled by the iii engine's exec worker.
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getBinaryPath } from '@nvent-addon/workflow-worker'

export function getLocalWorkflowPackageDir(): string | null {
  if (process.platform === 'linux' && process.arch === 'x64') return 'workflow-worker-linux-x64-gnu'
  if (process.platform === 'linux' && process.arch === 'arm64') return 'workflow-worker-linux-arm64-gnu'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'workflow-worker-darwin-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'workflow-worker-darwin-arm64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'workflow-worker-win32-x64-msvc'
  return null
}

export function resolveWorkflowPackagedBinaryPath(): string | null {
  try {
    const binaryPath = getBinaryPath()
    return binaryPath && existsSync(binaryPath) ? binaryPath : null
  }
  catch {
    return null
  }
}

export function resolveWorkflowBinaryFromPackageRoot(packageRootDir: string): string | null {
  const packageDir = getLocalWorkflowPackageDir()
  if (packageDir) {
    const binaryName = process.platform === 'win32' ? 'workflow.exe' : 'workflow'
    const binaryPath = join(packageRootDir, packageDir, 'bin', binaryName)
    if (existsSync(binaryPath)) return binaryPath
  }
  return resolveWorkflowPackagedBinaryPath()
}

export interface WorkflowWorkerBootConfig {
  adapter?: {
    type: 'redis' | 'file' | 'memory'
    redisUrl?: string
    fileDir?: string
  }
  config?: {
    defaultPendingTimeoutMs?: number
    sweepExpression?: string
    dispatchTimeoutMs?: number
    cleanupTimeoutMs?: number
    maxNodeRetries?: number
    runRetentionMs?: number
    observabilityRetentionMs?: number
    redisGlobalLogTraceIndex?: boolean
    idempotencyTtlMs?: number
  }
}

export class WorkflowWorkerManager {
  private static instance: WorkflowWorkerManager | null = null

  constructor(
    private readonly wsUrl: string,
    private readonly rustProjectDir: string,
    private readonly packageRootDir: string,
    private readonly workflowConfig?: WorkflowWorkerBootConfig,
    private readonly preferredCommand?: string,
  ) {
    WorkflowWorkerManager.instance = this
    ;(globalThis as any).__WorkflowWorkerManager = WorkflowWorkerManager
  }

  static getInstance(): WorkflowWorkerManager | null {
    return WorkflowWorkerManager.instance
  }

  /**
   * Returns the command and arguments needed to start the workflow worker.
   * This is used by the iii engine config generator to register an exec worker.
   */
  getCommandArgs(): { command: string, args: string[] } {
    const workerConfigArg = this.buildWorkerConfigArg()
    if (this.preferredCommand) {
      return {
        command: this.preferredCommand,
        args: workerConfigArg
          ? ['--url', this.wsUrl, '--config', workerConfigArg]
          : ['--url', this.wsUrl],
      }
    }

    const packagedBinary = this.tryResolvePackagedBinary()
    if (packagedBinary) {
      return {
        command: packagedBinary,
        args: workerConfigArg
          ? ['--url', this.wsUrl, '--config', workerConfigArg]
          : ['--url', this.wsUrl],
      }
    }

    const cargoToml = join(this.rustProjectDir, 'Cargo.toml')
    return {
      command: 'cargo',
      args: workerConfigArg
        ? ['run', '--manifest-path', cargoToml, '--', '--url', this.wsUrl, '--config', workerConfigArg]
        : ['run', '--manifest-path', cargoToml, '--', '--url', this.wsUrl],
    }
  }

  private normalizeAdapter(): {
    type: 'redis' | 'file' | 'memory'
    redisUrl?: string
    fileDir?: string
  } | null {
    const adapter = this.workflowConfig?.adapter
    if (adapter?.type) {
      return adapter
    }
    return null
  }

  private buildWorkerConfigArg(): string | null {
    if (!this.workflowConfig) return null

    const runtimeConfig = this.workflowConfig.config
    const configPayload: Record<string, unknown> = {}
    if (runtimeConfig?.defaultPendingTimeoutMs != null) {
      configPayload.default_pending_timeout_ms = runtimeConfig.defaultPendingTimeoutMs
    }
    if (runtimeConfig?.sweepExpression != null) {
      configPayload.sweep_expression = runtimeConfig.sweepExpression
    }
    if (runtimeConfig?.dispatchTimeoutMs != null) {
      configPayload.dispatch_timeout_ms = runtimeConfig.dispatchTimeoutMs
    }
    if (runtimeConfig?.cleanupTimeoutMs != null) {
      configPayload.cleanup_timeout_ms = runtimeConfig.cleanupTimeoutMs
    }
    if (runtimeConfig?.maxNodeRetries != null) {
      configPayload.max_node_retries = runtimeConfig.maxNodeRetries
    }
    if (runtimeConfig?.runRetentionMs != null) {
      configPayload.run_retention_ms = runtimeConfig.runRetentionMs
    }
    if (runtimeConfig?.observabilityRetentionMs != null) {
      configPayload.observability_retention_ms = runtimeConfig.observabilityRetentionMs
    }
    const adapter = this.normalizeAdapter()
    if (adapter?.type != null) {
      // Worker currently supports redis/file backends. Treat memory as local file backend.
      configPayload.internal_state_backend = adapter.type === 'memory'
        ? 'file'
        : adapter.type
    }
    if (adapter?.redisUrl != null) {
      configPayload.internal_state_redis_url = adapter.redisUrl
    }
    if (adapter?.fileDir != null) {
      configPayload.internal_state_file_dir = adapter.fileDir
    }
    if (runtimeConfig?.redisGlobalLogTraceIndex != null) {
      configPayload.redis_global_log_trace_index = runtimeConfig.redisGlobalLogTraceIndex
    }
    if (runtimeConfig?.idempotencyTtlMs != null) {
      configPayload.idempotency_ttl_ms = runtimeConfig.idempotencyTtlMs
    }

    if (Object.keys(configPayload).length === 0) {
      return null
    }
    return JSON.stringify(configPayload)
  }

  private tryResolvePackagedBinary(): string | null {
    const localBinaryPath = this.tryResolveLocalPackagedBinary()
    if (localBinaryPath) {
      return localBinaryPath
    }

    try {
      const binaryPath = getBinaryPath()
      if (binaryPath && existsSync(binaryPath)) {
        return binaryPath
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Keep dev/local workflow working by falling back to cargo when no packaged binary exists.
      console.warn(`[nvent] workflow worker package binary unresolved, falling back to cargo: ${message}`)
    }
    return null
  }

  private tryResolveLocalPackagedBinary(): string | null {
    return resolveWorkflowBinaryFromPackageRoot(this.packageRootDir)
  }
}
