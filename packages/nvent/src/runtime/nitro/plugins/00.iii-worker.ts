/**
 * iii Worker Plugin
 *
 * Unified worker plugin — connects Nitro to the running iii engine and manages
 * all worker types: Node.js (TypeScript) and Python (and future runtimes).
 * The iii instance is stored on nitroApp so consumers can reach it via useIii().
 */

import { defineNitroPlugin, useRuntimeConfig } from '#imports'
import { existsSync, readFileSync } from 'node:fs'
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

function readProjectName(): string | undefined {
  try {
    const pkgPath = join(process.cwd(), 'package.json')
    if (!existsSync(pkgPath)) return undefined
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return typeof pkg.name === 'string' ? pkg.name : undefined
  } catch {
    return undefined
  }
}

export default defineNitroPlugin(async (nitroApp) => {
  const runtimeConfig = useRuntimeConfig()
  const nventCfg = (runtimeConfig as any).nvent ?? {}
  const cfg = nventCfg.iii ?? {}
  const pythonCfg = nventCfg.python ?? {}

  const wsUrl: string = cfg.wsUrl ?? process.env.III_BRIDGE_URL ?? 'ws://localhost:49134'
  const logLevel: string = cfg.logLevel ?? 'warn'
  // Python binary: configurable at deploy time via NVENT_PYTHON_BIN env var.
  // Never baked in at build time — the build-machine venv path won't exist on the target.
  const pythonBin = process.env.NVENT_PYTHON_BIN ?? 'python3'

  const workerName = cfg.workerName ?? `nvent-${process.pid}`

  const fnCount = (registry.functions ?? []).length
  const triggerCount = (registry.triggers ?? []).length
  console.log(`[nvent] iii-worker: connecting to ${wsUrl} — ${fnCount} function(s), ${triggerCount} trigger(s)`)

  const iii = registerWorker(wsUrl, {
    workerName,
    otel: {
      enabled: true,
      serviceName: 'nvent',
    },
    telemetry: {
      framework: 'nvent',
      project_name: readProjectName(),
    },
    reconnectionConfig: {
      initialDelayMs: 500,
      maxDelayMs: 15_000,
      maxRetries: -1,
    },
  })
  console.log(`[nvent] iii-worker: connected to engine (worker: ${workerName})`)

  // Register all Node.js functions and triggers with the iii engine
  registerNodeFunctions(iii, registry.functions ?? [])

  // Expose on nitroApp for useIii() composable
  nitroApp.$iii = iii

  // Python workers — started here only in production.
  // In development, module.ts manages Python workers directly in the Nuxt process.
  // Python workers — started here only in production.
  // In development, module.ts manages Python workers directly in the Nuxt process.
  // workersDir: prefer .nvent/workers at cwd (Docker: .output contents at WORKDIR)
  //             fall back to node_modules/.nvent/workers (traditional deployment).
  const workersDir = join(process.cwd(), '.nvent', 'workers')
  const orchestrator = new PythonWorkersOrchestrator(
    workersDir,
    pythonCfg.runtimeContent ?? '',
    pythonCfg.nventHelperContent ?? '',
    wsUrl,
    pythonBin,
    logLevel,
  )

  if (process.env.NODE_ENV !== 'development' && !pythonCfg.skip) {
    await orchestrator.start(pythonFunctions ?? [])
  }

  // Graceful shutdown
  nitroApp.hooks.hookOnce('close', async () => {
    await orchestrator.stop()
    await iii.shutdown()
  })
})
