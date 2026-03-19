/**
 * iii Lifecycle Plugin
 *
 * Manages the iii engine and console process lifecycle at **server runtime**.
 *
 * - **Development**: no-op. The Nuxt module (module.ts) starts engine + console
 *   in the parent Nuxt process so they survive Nitro hot-reloads naturally.
 * - **Production** (`managed: true`, `mode: 'local'`): starts engine + console here.
 *
 * Binaries and iii-config.yaml are placed by `nuxt build` (module.ts) into:
 *   - Docker deploy:      `<cwd>/.nvent/`  (contents of .output copied to WORKDIR)
 *   - Traditional deploy: `<cwd>/node_modules/.nvent/`
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

  // Binaries are placed by `nuxt build` into .output/node_modules/.nvent/bin/.
  // node runs with CWD = .output/, so process.cwd()/node_modules/.nvent/ resolves correctly.
  // The second candidate covers running from the project root outside of Docker.
  const cwdBinDir = join(process.cwd(), 'node_modules', '.nvent', 'bin')
  const nodeModulesBinDir = join(process.cwd(), '..', 'node_modules', '.nvent', 'bin')

  const binaryPath = findExisting(join(cwdBinDir, binaryName), join(nodeModulesBinDir, binaryName))
  if (!binaryPath) {
    console.error('[nvent] iii engine binary not found. Run `nuxt build` to install it.')
    return
  }

  // Resolve iii-config.yaml — placed alongside the binaries in .output/node_modules/.nvent/.
  const cwdConfigPath = join(process.cwd(), 'node_modules', '.nvent', 'iii-config.yaml')
  const nodeModulesConfigPath = join(process.cwd(), '..', 'node_modules', '.nvent', 'iii-config.yaml')

  let configPath = findExisting(cwdConfigPath, nodeModulesConfigPath)
  if (!configPath) {
    // Fallback: write from the build-time YAML stored in runtimeConfig.
    if (!iiiCfg.engineConfigYaml) {
      console.error('[nvent] iii-config.yaml not found and no stored config available. Skipping engine start.')
      return
    }
    configPath = cwdConfigPath
    mkdirSync(join(process.cwd(), '.nvent'), { recursive: true })
    writeFileSync(configPath, iiiCfg.engineConfigYaml, 'utf-8')
  }

  const engine = createEngineManager({ binaryPath, configPath, httpPort, wsPort, logLevel })
  await engine.start()

  let consoleManager: ConsoleManager | null = null
  if (cfg.console?.enabled) {
    const consoleBinaryName = process.platform === 'win32' ? 'iii-console.exe' : 'iii-console'
    const consoleBinPath = findExisting(join(cwdBinDir, consoleBinaryName), join(nodeModulesBinDir, consoleBinaryName))
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


