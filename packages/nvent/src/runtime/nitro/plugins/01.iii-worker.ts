/**
 * iii Worker Plugin
 *
 * Unified worker plugin — connects Nitro to the running iii engine and manages
 * all worker types: Node.js (TypeScript) and Python (and future runtimes).
 * The iii instance is stored on nitroApp so consumers can reach it via useIii().
 */

import { defineNitroPlugin, useRuntimeConfig } from '#imports'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveNventDir } from '../utils/nventDir'
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
  // If the value is a relative path, resolve it against multiple candidate roots so that
  // `playground/.venv/bin/python3` works regardless of what directory the server starts from.
  const pythonBin = (() => {
    const raw = process.env.NVENT_PYTHON_BIN ?? 'python3'
    if (!raw || raw === 'python3' || raw === 'python' || isAbsolute(raw)) return raw
    // Relative path: walk up from CWD trying each ancestor until we find a match.
    // Also try NVENT_DIR as a sibling root if set.
    const roots = [
      process.cwd(),
      join(process.cwd(), '..'),
      join(process.cwd(), '..', '..'),
      join(process.cwd(), '..', '..', '..'),
      process.env.NVENT_DIR ? join(process.env.NVENT_DIR, '..') : null,
    ].filter(Boolean) as string[]
    for (const root of roots) {
      const candidate = resolve(root, raw)
      if (existsSync(candidate)) return candidate
    }
    // Nothing found — return as-is and let spawn produce a clear ENOENT.
    return raw
  })()

  const workerName = cfg.workerName ?? `nvent-${process.pid}`

  const fnCount = (registry.functions ?? []).length
  const triggerCount = (registry.triggers ?? []).length
  console.log(`[nvent] iii-worker: connecting to ${wsUrl} — ${fnCount} function(s), ${triggerCount} trigger(s)`)

  const iii = registerWorker(wsUrl, {
    workerName,
    otel: {
      enabled: true,
      serviceName: 'nvent',
      metricsExportIntervalMs: 10_000,
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
  // nventDir is always .output/nvent/ — the sibling of .output/server/ where
  // import.meta.url (the Nitro entry) lives. CWD-independent, deploy-safe.
  // Set NVENT_DIR env var to override for custom deploy layouts.
  const nventArtifactsDir = resolveNventDir(import.meta.url)
  const workersDir = join(nventArtifactsDir, 'workers')
  // Read runtime files from disk (.output/nvent/workers/ — copied there by the build hook).
  // Fall back to the runtimeConfig-embedded strings for environments where the files
  // may not have been copied (e.g. custom deploys that strip non-JS assets).
  const runtimeFilePath = join(workersDir, '_runtime.py')
  const nventHelperFilePath = join(workersDir, 'nvent.py')
  const runtimeContent = existsSync(runtimeFilePath)
    ? readFileSync(runtimeFilePath, 'utf-8')
    : (pythonCfg.runtimeContent ?? '')
  const nventHelperContent = existsSync(nventHelperFilePath)
    ? readFileSync(nventHelperFilePath, 'utf-8')
    : (pythonCfg.nventHelperContent ?? '')
  const orchestrator = new PythonWorkersOrchestrator(
    workersDir,
    runtimeContent,
    nventHelperContent,
    wsUrl,
    pythonBin,
    logLevel,
  )

  if (process.env.NODE_ENV !== 'development' && !pythonCfg.skip) {
    // Resolve relative absPath entries to absolute paths using nventArtifactsDir.
    // The registry stores a functions-dir-relative path (e.g. 'analyze.py') so that
    // the runtime CWD doesn't matter — we always produce a correct absolute path here.
    const resolvedPythonFunctions = (pythonFunctions ?? []).map(fn => ({
      ...fn,
      absPath: isAbsolute(fn.absPath)
        ? fn.absPath
        : join(nventArtifactsDir, 'functions', fn.absPath),
    }))
    await orchestrator.start(resolvedPythonFunctions)
  }

  // Graceful shutdown
  nitroApp.hooks.hookOnce('close', async () => {
    await orchestrator.stop()
    await iii.shutdown()
  })
})
