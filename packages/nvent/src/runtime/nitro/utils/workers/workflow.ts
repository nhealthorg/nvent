/**
 * Workflow Worker Configuration Utility
 *
 * Provides configuration metadata for the Rust workflow orchestrator worker.
 * The actual process management is handled by the iii engine's exec worker.
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getBinaryPath } from '@nvent-addon/workflow-worker'

export interface WorkflowWorkerBootConfig {
  defaultPendingTimeoutMs?: number
  sweepExpression?: string
  dispatchTimeoutMs?: number
  maxNodeRetries?: number
  runRetentionMs?: number
  observabilityRetentionMs?: number
}

export class WorkflowWorkerManager {
  private static instance: WorkflowWorkerManager | null = null

  constructor(
    private readonly wsUrl: string,
    private readonly rustProjectDir: string,
    private readonly packageRootDir: string,
    private readonly workflowConfig?: WorkflowWorkerBootConfig,
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

  private buildWorkerConfigArg(): string | null {
    if (!this.workflowConfig) return null

    const configPayload: Record<string, unknown> = {}
    if (this.workflowConfig.defaultPendingTimeoutMs != null) {
      configPayload.default_pending_timeout_ms = this.workflowConfig.defaultPendingTimeoutMs
    }
    if (this.workflowConfig.sweepExpression != null) {
      configPayload.sweep_expression = this.workflowConfig.sweepExpression
    }
    if (this.workflowConfig.dispatchTimeoutMs != null) {
      configPayload.dispatch_timeout_ms = this.workflowConfig.dispatchTimeoutMs
    }
    if (this.workflowConfig.maxNodeRetries != null) {
      configPayload.max_node_retries = this.workflowConfig.maxNodeRetries
    }
    if (this.workflowConfig.runRetentionMs != null) {
      configPayload.run_retention_ms = this.workflowConfig.runRetentionMs
    }
    if (this.workflowConfig.observabilityRetentionMs != null) {
      configPayload.observability_retention_ms = this.workflowConfig.observabilityRetentionMs
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
    const packageDir = this.getLocalPackageDir()
    if (!packageDir) {
      return null
    }

    const binaryName = process.platform === 'win32' ? 'workflow.exe' : 'workflow'
    const binaryPath = join(this.packageRootDir, packageDir, 'bin', binaryName)
    return existsSync(binaryPath) ? binaryPath : null
  }

  private getLocalPackageDir(): string | null {
    if (process.platform === 'linux' && process.arch === 'x64') return 'workflow-worker-linux-x64-gnu'
    if (process.platform === 'linux' && process.arch === 'arm64') return 'workflow-worker-linux-arm64-gnu'
    if (process.platform === 'darwin' && process.arch === 'x64') return 'workflow-worker-darwin-x64'
    if (process.platform === 'darwin' && process.arch === 'arm64') return 'workflow-worker-darwin-arm64'
    if (process.platform === 'win32' && process.arch === 'x64') return 'workflow-worker-win32-x64-msvc'
    return null
  }
}
