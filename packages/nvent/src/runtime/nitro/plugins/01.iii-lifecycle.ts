/**
 * iii Lifecycle Plugin
 *
 * Manages the iii engine and console process lifecycle at **server runtime**.
 *
 * - **Development**: no-op. The Nuxt module (module.ts) starts engine + console
 *   in the parent Nuxt process so they survive Nitro hot-reloads naturally.
 * - **Production** (`managed: true`): starts engine + console here so they are
 *   available before workers connect.
 *
 * Worker registration (Node.js + Python) is handled by 00.iii-worker.ts.
 */

import { defineNitroPlugin, useRuntimeConfig } from '#imports'
import { join } from 'node:path'
import { createEngineManager } from '../utils/engine'
import { ConsoleManager } from '../utils/console'
import { ensureIiiEngine } from '../../../iii/install'
import { ensureIiiConsole } from '../../../iii/console'
import { writeIiiConfig } from '../../../iii/config'

export default defineNitroPlugin(async (nitroApp) => {
  const rc = useRuntimeConfig() as any
  const cfg = rc.nvent ?? {}
  const iiiCfg = cfg.iii ?? {}

  if (!iiiCfg.managed) return
  if ((iiiCfg.mode ?? 'local') !== 'local') return

  // In dev, module.ts manages engine + console in the Nuxt parent process.
  if (process.env.NODE_ENV === 'development') return

  const nventDir = join(process.cwd(), 'node_modules', '.nvent')
  const binDir = join(nventDir, 'bin')
  const configPath = join(nventDir, 'iii-config.yaml')

  const httpPort: number = iiiCfg.httpPort ?? 3111
  const wsPort: number = iiiCfg.wsPort ?? 49134
  const logLevel = (iiiCfg.logLevel ?? 'warn') as 'none' | 'error' | 'warn' | 'info'

  writeIiiConfig(configPath, {
    wsPort,
    httpPort,
    modules: iiiCfg.modules ?? { state: true, queue: true, cron: true, observability: true, stream: true },
  })

  const binaryPath = await ensureIiiEngine({ binDir, version: iiiCfg.version ?? 'latest', logLevel })
  const engine = createEngineManager({ binaryPath, configPath, httpPort, wsPort, logLevel })
  await engine.start()

  let consoleManager: ConsoleManager | null = null
  if (cfg.console?.enabled) {
    const consoleBinPath = await ensureIiiConsole({
      binDir,
      version: cfg.console.version ?? iiiCfg.version ?? 'latest',
      logLevel,
    })
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

  nitroApp.hooks.hookOnce('close', async () => {
    await consoleManager?.stop()
    await engine.stop()
  })
})

