/**
 * iii Lifecycle Plugin
 *
 * Manages the iii engine and console process lifecycle at **server runtime**.
 *
 * - **Development**: no-op. The Nuxt module (module.ts) starts engine + console
 *   in the parent Nuxt process so they survive Nitro hot-reloads naturally.
 * - **Production** (`managed: true`, `mode: 'local'`): starts engine + console here.
 *
 * Binaries and iii-config.yaml are placed by `nuxt build` (module.ts) into
 * `.output/nvent/`. The plugin finds them by walking up from import.meta.url —
 * this is CWD-independent and works when .output/ is copied or deployed elsewhere.
 *
 * This plugin does NOT download anything — it finds what build already placed.
 *
 * Worker registration (Node.js + Python) is handled by 00.iii-worker.ts.
 */

import { defineNitroPlugin, useRuntimeConfig } from '#imports'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEngineManager } from '../utils/engine'
import { ConsoleManager } from '../utils/console'
import { resolveNventDir } from '../utils/nventDir'

/** Returns the first path that exists among the candidates. */
function findExisting(...candidates: string[]): string | undefined {
  return candidates.find(p => existsSync(p))
}

export default defineNitroPlugin(async (nitroApp) => {
  const rc = useRuntimeConfig() as any
  const cfg = rc.nvent ?? {}
  const iiiCfg = cfg.iii ?? {}

  if (!iiiCfg.managed) return
  if ((iiiCfg.mode ?? 'local') !== 'local') return

  // In dev, module.ts manages engine + console in the Nuxt parent process.
  if (process.env.NODE_ENV === 'development') return

  const httpPort: number = iiiCfg.httpPort ?? 3111
  const wsPort: number = iiiCfg.wsPort ?? 49134
  const logLevel = (iiiCfg.logLevel ?? 'warn') as 'none' | 'error' | 'warn' | 'info'

  const binaryName = process.platform === 'win32' ? 'iii.exe' : 'iii'

  // nventDir is always .output/nvent/ — the sibling of .output/server/ where
  // import.meta.url (the Nitro entry) lives. CWD-independent, deploy-safe.
  // Set NVENT_DIR env var to override for custom deploy layouts.
  const nventDir = resolveNventDir(import.meta.url)
  const binDir = join(nventDir, 'bin')

  const binaryPath = findExisting(join(binDir, binaryName))
  if (!binaryPath) {
    console.error('[nvent] iii engine binary not found. Run `nuxt build` to install it.')
    return
  }

  // Prefer the build-generated config.yaml. Keep iii-config.yaml as legacy fallback.
  let configPath = findExisting(join(nventDir, 'config.yaml'), join(nventDir, 'iii-config.yaml'))
  if (!configPath) {
    // Fallback: write from the build-time YAML stored in runtimeConfig.
    if (!iiiCfg.engineConfigYaml) {
      console.error('[nvent] config.yaml not found and no stored config available. Skipping engine start.')
      return
    }
    mkdirSync(nventDir, { recursive: true })
    configPath = join(nventDir, 'config.yaml')
    writeFileSync(configPath, iiiCfg.engineConfigYaml, 'utf-8')
  }

  const engine = createEngineManager({
    binaryPath,
    configPath,
    httpPort,
    wsPort,
    logLevel,
    workingDir: nventDir,
    allowPortReuse: false,
  })
  await engine.start()

  let consoleManager: ConsoleManager | null = null
  if (cfg.console?.enabled) {
    const consoleBinaryName = process.platform === 'win32' ? 'iii-console.exe' : 'iii-console'
    const consoleBinPath = findExisting(join(binDir, consoleBinaryName))
    if (consoleBinPath) {
      consoleManager = new ConsoleManager({
        binaryPath: consoleBinPath,
        port: cfg.console.port ?? 3113,
        enginePort: httpPort,
        bridgePort: wsPort,
        flow: cfg.console.flow ?? true,
        logLevel,
      })
      await consoleManager.start()
    }
    else {
      console.warn('[nvent] iii-console binary not found — console UI will not start.')
    }
  }

  nitroApp.hooks.hookOnce('close', async () => {
    await consoleManager?.stop()
    await engine.stop()
  })
})


