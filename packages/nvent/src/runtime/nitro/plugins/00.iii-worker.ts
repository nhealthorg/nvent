/**
 * iii Worker Plugin
 *
 * Unified worker plugin — connects Nitro to the running iii engine and manages
 * all worker types: Node.js (TypeScript) and Python (and future runtimes).
 * The iii instance is stored on nitroApp so consumers can reach it via useIii().
 */

import { defineNitroPlugin, useRuntimeConfig } from '#imports'
import { join } from 'node:path'
import { registerWorker } from 'iii-sdk'
import { registerNodeFunctions } from '../utils/workers/node'
import { PythonWorkersOrchestrator } from '../utils/workers/python'
// `registry` and `pythonFunctions` are auto-imported from the generated iii-registry template
declare const registry: {
  functions: import('../utils/workers/node').NodeFnInfo[]
  triggers: Array<{ type: string; function_id: string; config?: Record<string, unknown> }>
}
declare const pythonFunctions: Array<{ id: string; absPath: string; standalone: boolean }>

declare module 'nitropack' {
  interface NitroApp {
    $iii: ReturnType<typeof registerWorker>
  }
}

export default defineNitroPlugin(async (nitroApp) => {
  const runtimeConfig = useRuntimeConfig()
  const nventCfg = (runtimeConfig as any).nvent ?? {}
  const cfg = nventCfg.iii ?? {}
  const pythonCfg = nventCfg.python ?? {}

  const wsUrl: string = cfg.wsUrl ?? process.env.III_BRIDGE_URL ?? 'ws://localhost:49134'
  const logLevel: string = cfg.logLevel ?? 'warn'

  const workerName = cfg.workerName ?? `nvent-${process.pid}`

  const fnCount = (registry.functions ?? []).length
  const triggerCount = (registry.triggers ?? []).length
  console.log(`[nvent] iii-worker: connecting to ${wsUrl} — ${fnCount} function(s), ${triggerCount} trigger(s)`)

  const iii = registerWorker(wsUrl, {
    workerName,
    reconnectionConfig: {
      initialDelayMs: 500,
      maxDelayMs: 15_000,
      maxRetries: -1,
    },
  })

  iii.on('connected', () => {
    console.log(`[nvent] iii-worker: connected to engine (worker: ${workerName})`)
  })

  // Register all Node.js functions and triggers with the iii engine
  registerNodeFunctions(iii, registry.functions ?? [])

  // Expose on nitroApp for useIii() composable
  nitroApp.$iii = iii

  // Python workers — started here only in production.
  // In development, module.ts manages Python workers directly in the Nuxt process.
  const workersDir = join(process.cwd(), 'node_modules', '.nvent', 'workers')
  const orchestrator = new PythonWorkersOrchestrator(
    workersDir,
    pythonCfg.runtimeContent ?? '',
    pythonCfg.nventHelperContent ?? '',
    wsUrl,
    pythonCfg.bin ?? 'python3',
    logLevel,
  )

  if (process.env.NODE_ENV !== 'development') {
    await orchestrator.start(pythonFunctions ?? [])
  }

  // Graceful shutdown
  nitroApp.hooks.hookOnce('close', async () => {
    await orchestrator.stop()
    await iii.shutdown()
  })
})
