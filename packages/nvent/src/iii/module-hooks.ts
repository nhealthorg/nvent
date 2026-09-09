import type { LayerInfo } from './registry'
import type { NventExtendedQueueDefinition } from './extendedQueues'

export interface NventExtendedFunction {
  /** iii function ID (e.g. `fhir::terminology::lookup`) */
  id: string
  /** Absolute file path, or root-relative path, to a TS/JS function module */
  absPath: string
  /** Optional human-readable description */
  description?: string
}

export interface NventExtendedPythonFunction {
  /** iii function ID (e.g. `fhir::terminology::expand`) */
  id: string
  /** Absolute file path, or root-relative path, to a .py file */
  absPath: string
  /** When true, start this function in a dedicated worker process */
  standalone?: boolean
}

export interface NventExtendFunctionsHookPayload {
  /** Push extra TS/JS function files to register */
  functions: NventExtendedFunction[]
  /** Push extra Python function files to register */
  pythonFunctions: NventExtendedPythonFunction[]
  /** Push extra Workflow files to register */
  workflows: NventExtendedFunction[]
  /** Nuxt project root */
  rootDir: string
  /** Layer scan context (same as nvent internal scan) */
  layerInfos: LayerInfo[]
  /** Configured functions dir relative to each layer's server dir */
  functionsDir: string
  /** Configured workflows dir relative to each layer's server dir */
  workflowsDir: string
}

export interface NventExtendQueuesHookPayload {
  /** Push extra named queues to register in iii engine config. */
  queues: NventExtendedQueueDefinition[]
  /** Nuxt project root */
  rootDir: string
}

declare module '@nuxt/schema' {
  interface NuxtHooks {
    /**
     * Extend nvent function discovery with additional TS/JS or Python function files.
     * Useful for Nuxt modules that ship their own iii handlers.
     */
    'nvent:functions:extend': (payload: NventExtendFunctionsHookPayload) => void | Promise<void>
    /**
     * Extend iii named queue definitions so module-owned workflows can enqueue safely.
     * Duplicate policy: first queue definition wins; later duplicates are ignored with a warning.
     */
    'nvent:queues:extend': (payload: NventExtendQueuesHookPayload) => void | Promise<void>
  }
}
