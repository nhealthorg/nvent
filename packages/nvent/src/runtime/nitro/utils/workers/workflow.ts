/**
 * Workflow Worker Configuration Utility
 *
 * Provides configuration metadata for the Rust workflow orchestrator worker.
 * The actual process management is handled by the iii engine's exec worker.
 */

import { join } from 'node:path'

export class WorkflowWorkerManager {
  private static instance: WorkflowWorkerManager | null = null

  constructor(
    private readonly wsUrl: string,
    private readonly rustProjectDir: string
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
    const cargoToml = join(this.rustProjectDir, 'Cargo.toml')
    return {
      command: 'cargo',
      args: ['run', '--manifest-path', cargoToml, '--', '--url', this.wsUrl]
    }
  }
}
