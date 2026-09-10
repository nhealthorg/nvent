/**
 * iii Lifecycle Plugin
 *
 * Manages the iii compose daemon lifecycle at **server runtime**.
 *
 * - **Development**: no-op. The Nuxt module (module.ts) starts compose
 *   in the parent Nuxt process so they survive Nitro hot-reloads naturally.
 * - **Production** (`compose.managed: true`): starts compose here.
 *
 * Binaries and worker-compose.yaml are placed by `nuxt build` (module.ts) into
 * `.output/nvent/`. The plugin finds them by walking up from import.meta.url —
 * this is CWD-independent and works when .output/ is copied or deployed elsewhere.
 *
 * This plugin does NOT download any workers — compose resolves package workers.
 *
 * Worker registration (Node.js + Python) is handled by 00.iii-worker.ts.
 */

import { useRuntimeConfig } from '#imports'
import { defineNitroPlugin } from 'nitropack/runtime'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createComposeManager } from '../utils/compose'
import { resolveNventDir } from '../utils/nventDir'
import { printNventStartupReport } from '../utils/startup-report'

/** Returns the first path that exists among the candidates. */
function findExisting(...candidates: string[]): string | undefined {
  return candidates.find(p => existsSync(p))
}

export default defineNitroPlugin(async (nitroApp) => {
  const rc = useRuntimeConfig() as any
  const cfg = rc.nvent ?? {}
  const iiiCfg = cfg.iii ?? {}
  const composeCfg = iiiCfg.compose ?? {}

  if (!composeCfg.managed) return

  // In dev, module.ts manages engine + ADE UI in the Nuxt parent process.
  if (process.env.NODE_ENV === 'development') return

  const logLevel = ((composeCfg.logLevel ?? 'info') as 'none' | 'error' | 'warn' | 'info')

  const binaryName = process.platform === 'win32' ? 'iii.exe' : 'iii'

  // nventDir is always .output/nvent/ — the sibling of .output/server/ where
  // import.meta.url (the Nitro entry) lives. CWD-independent, deploy-safe.
  // Set NVENT_DIR env var to override for custom deploy layouts.
  const nventDir = resolveNventDir(import.meta.url)
  const binDir = join(nventDir, 'bin')
  const composeFileName = (composeCfg.file ?? 'worker-compose.yaml').trim() || 'worker-compose.yaml'
  const composeFilePath = join(nventDir, composeFileName)

  const binaryPath = findExisting(join(binDir, binaryName))
  if (!binaryPath) {
    console.error('[nvent] iii engine binary not found. Run `nuxt build` to install it.')
    return
  }

  if (!existsSync(composeFilePath)) {
    if (!composeCfg.workerComposeYaml) {
      console.error('[nvent] compose file missing and no runtime compose YAML available. Skipping compose startup.')
      return
    }
    mkdirSync(nventDir, { recursive: true })
    writeFileSync(composeFilePath, composeCfg.workerComposeYaml, 'utf-8')
  }

  const compose = createComposeManager({
    binaryPath,
    composeFilePath,
    daemonNamespace: composeCfg.daemonNamespace ?? iiiCfg.namespace?.default ?? 'default',
    upOnStart: composeCfg.upOnStart ?? true,
    composeStateDir: join(nventDir, '.compose-state'),
    resetNamespaceStateOnStart: true,
    logLevel,
    compactLogs: composeCfg.compactLogs ?? true,
    waitForUp: composeCfg.waitForUp ?? true,
    upTimeoutMs: composeCfg.upTimeoutMs ?? 120_000,
    workingDir: nventDir,
  })

  printNventStartupReport({
    wsUrl: iiiCfg.wsUrl ?? `ws://localhost:${iiiCfg.wsPort ?? 49134}`,
    httpPort: iiiCfg.httpPort ?? 3111,
    httpHost: iiiCfg.httpHost ?? 'localhost',
    streamPort: iiiCfg.streamPort ?? 3112,
    adePort: iiiCfg.ade?.port,
    adeEnabled: !!iiiCfg.ade,
    composeNamespace: composeCfg.daemonNamespace ?? iiiCfg.namespace?.default ?? 'default',
    projectNamespace: iiiCfg.namespace?.map?.compose ?? iiiCfg.namespace?.default ?? composeCfg.daemonNamespace ?? 'default',
    namespaceMode: iiiCfg.namespace?.mode ?? 'single',
    namespaceMap: iiiCfg.namespace?.map,
    composeFilePath,
  })

  await compose.start()

  let shuttingDown = false
  let shutdownPromise: Promise<void> | null = null
  const stopCompose = async () => {
    if (shuttingDown) return shutdownPromise
    shuttingDown = true
    shutdownPromise = compose.stop().catch((err) => {
      console.error('[nvent] compose shutdown failed:', err)
    })
    return shutdownPromise
  }

  const handleSignal = (signal: NodeJS.Signals) => {
    console.warn(`[nvent] received ${signal}; stopping iii compose before exit`)
    void stopCompose()
  }

  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)

  nitroApp.hooks.hookOnce('close', async () => {
    await stopCompose()
  })
})


