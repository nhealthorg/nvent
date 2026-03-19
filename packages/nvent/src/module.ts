/**
 * nvent Module — iii engine integration
 *
 * This is the new module entrypoint for nvent v1.x built on the iii engine.
 * No backward compatibility with previous adapter-based config.
 *
 * What this module does:
 * 1. Installs the iii engine binary locally if missing
 * 2. Generates iii-config.yaml from nvent options
 * 3. Starts/stops the iii engine process in dev mode
 * 4. Scans server/functions/ and generates #nvent/iii-registry template
 * 5. Registers the Nitro worker plugin (connects, registers functions/triggers)
 * 6. Adds server auto-imports (useIii, defineFunction, logger, enqueue, stateManager)
 * 7. Adds nhealth console API routes
 * 8. Watches function files for changes (dev HMR)
 */

import { join, basename, relative } from 'node:path'
import {
  defineNuxtModule,
  createResolver,
  addServerPlugin,
  addServerHandler,
  addServerImports,
  addImports,
  addTemplate,
  updateTemplates,
} from '@nuxt/kit'
import { readFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { ensureIiiEngine } from './iii/install'
import { ensureIiiConsole } from './iii/console'
import {
  writeIiiConfig,
  generateIiiConfigYaml,
  buildEngineConfig,
} from './iii/config'
import type { NventIiiOptions } from './iii/options'
import { scanFunctions, generateIiiRegistryTemplate, type ScannedRegistry, type PythonPathRewrite } from './iii/registry'
import { installNventPyToSitePackages, installPythonRequirements } from './iii/python'
import { PythonWorkersOrchestrator } from './runtime/nitro/utils/workers/python'
import { createEngineManager } from './runtime/nitro/utils/engine'
import { ConsoleManager } from './runtime/nitro/utils/console'

import chokidar from 'chokidar'
import { debounce } from 'perfect-debounce'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

const meta = {
  name: 'nvent',
  version: packageJson.version,
  configKey: 'nvent',
}

const III_REGISTRY_TEMPLATE = 'iii-registry.mjs'

export default defineNuxtModule<NventIiiOptions>().with({
  meta,
  defaults: {},

  async setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    const PYTHON_RUNTIME_SRC = resolve('./runtime/python/worker_runtime.py')
    const PYTHON_NVENT_HELPER_SRC = resolve('./runtime/python/nvent.py')

    const userConfig = (nuxt.options as any)[meta.configKey] ?? {}
    const opts: NventIiiOptions = { ...userConfig, ...options }

    const iiiOpts = opts.iii ?? {}
    const functionsDir = opts.functions?.dir ?? 'functions'
    const pythonBin = opts.functions?.python?.devPath
      ? join(nuxt.options.rootDir, opts.functions.python.devPath)
      : 'python3'

    // Install nvent.py into the venv site-packages so Pylance / VS Code resolves
    // `from nvent import ...` automatically without any user configuration.
    installNventPyToSitePackages(pythonBin, readFileSync(PYTHON_NVENT_HELPER_SRC, 'utf-8'))

    const consoleEnabled = opts.console?.enabled ?? true
    const wsUrl = iiiOpts.wsUrl ?? 'ws://localhost:49134'
    const mode = iiiOpts.mode ?? 'local'
    // managed: default true for local mode (nvent handles engine lifecycle),
    // false for docker/remote modes (external service manages the engine).
    const managed = iiiOpts.managed ?? (mode === 'local')
    const skipPython = opts.functions?.python?.skip ?? false

    // Build engine config from user options, then write iii-config.yaml for dev Nitro usage.
    const engineCfg = buildEngineConfig(iiiOpts)
    const engineConfigYaml = generateIiiConfigYaml(engineCfg)
    writeIiiConfig(join(nuxt.options.buildDir, 'iii-config.yaml'), engineCfg)

    // Pass iii connection info through runtimeConfig so plugins can read it
    const rc = nuxt.options.runtimeConfig as any
    rc.nvent = {
      ...(rc.nvent ?? {}),
      iii: {
        wsUrl,
        httpPort: engineCfg.httpPort,
        httpHost: iiiOpts.httpHost ?? 'localhost',
        wsPort: engineCfg.wsPort,
        streamPort: engineCfg.streamPort,
        managed,
        mode,
        version: iiiOpts.version ?? 'latest',
        modules: engineCfg.modules,
        logLevel: iiiOpts.logLevel ?? 'warn',
        // YAML config stored at build time so the production lifecycle plugin can write
        // iii-config.yaml without needing confbox or rebuilding it from options.
        engineConfigYaml,
      },
      python: {
        runtimeContent: skipPython ? '' : readFileSync(PYTHON_RUNTIME_SRC, 'utf-8'),
        nventHelperContent: skipPython ? '' : readFileSync(PYTHON_NVENT_HELPER_SRC, 'utf-8'),
        skip: skipPython,
      },
      console: {
        enabled: !!iiiOpts.console,
        version: typeof iiiOpts.console === 'object' ? (iiiOpts.console.version ?? '') : '',
        port: (typeof iiiOpts.console === 'object' ? iiiOpts.console.port : undefined) ?? 3113,
        host: (typeof iiiOpts.console === 'object' ? iiiOpts.console.host : undefined) ?? 'localhost',
        flow: (typeof iiiOpts.console === 'object' ? iiiOpts.console.flow : undefined) ?? true,
      },
    }

    // Collect layer infos for scanning
    const layerInfos = nuxt.options._layers.map(l => ({
      rootDir: l.config.rootDir,
      serverDir: l.config?.serverDir ?? join(l.config.rootDir, 'server'),
    }))

    // Initial scan
    let lastScanned: ScannedRegistry = await scanFunctions({ layerInfos, functionsDir })
    // In production, Python absPath values in the registry are rewritten to the runtime
    // location (node_modules/.nvent/functions/<rel>) relative to process.cwd() = .output/server/.
    // Computed eagerly here so the registry template is already correct when Nitro bundles it.
    let pythonPathRewrite: PythonPathRewrite | undefined
    if (!nuxt.options.dev && !skipPython && lastScanned.pythonFunctions.length > 0) {
      pythonPathRewrite = new Map()
      for (const fn of lastScanned.pythonFunctions) {
        for (const layer of layerInfos) {
          const fnDir = join(layer.serverDir, functionsDir)
          if (fn.absPath.startsWith(fnDir)) {
            pythonPathRewrite.set(fn.absPath, join('node_modules', '.nvent', 'functions', relative(fnDir, fn.absPath)))
            break
          }
        }
      }
    }

    // Register the generated registry template
    // The Nitro worker plugin imports this as '#nvent/iii-registry'
    addTemplate({
      filename: III_REGISTRY_TEMPLATE,
      write: true,
      getContents: () => generateIiiRegistryTemplate(lastScanned, pythonPathRewrite),
    })

    const registryTemplatePath = resolve(nuxt.options.buildDir, III_REGISTRY_TEMPLATE)

    // Alias for Vite/TypeScript
    nuxt.options.alias['#nvent/iii-registry'] = registryTemplatePath

    // Tell Rollup/Nitro to bundle/transpile the generated registry and all its
    // transitive imports (the function .ts files). Without this the function files
    // are loaded raw by Node.js ESM where virtual aliases like `#imports` don't exist.
    nuxt.options.build.transpile.push(registryTemplatePath)

    // Expose registry exports as server auto-imports
    addServerImports([
      { from: registryTemplatePath, name: 'registry' },
      { from: registryTemplatePath, name: 'pythonFunctions' },
    ])

    // Add the Nitro worker plugin
    addServerPlugin(resolve('./runtime/nitro/plugins/00.iii-worker'))
    // Add the lifecycle plugin (starts iii engine, Python workers, console at server runtime)
    addServerPlugin(resolve('./runtime/nitro/plugins/01.iii-lifecycle'))

    // Add nvent console routes if enabled
    if (consoleEnabled) {
      addServerHandler({ route: '/api/_nvent/health', handler: resolve('./runtime/nitro/routes/_nvent/health'), method: 'get' })
      addServerHandler({ route: '/api/_nvent/functions', handler: resolve('./runtime/nitro/routes/_nvent/functions'), method: 'get' })
      addServerHandler({ route: '/api/_nvent/workers', handler: resolve('./runtime/nitro/routes/_nvent/workers'), method: 'get' })
      addServerHandler({ route: '/api/_nvent/triggers', handler: resolve('./runtime/nitro/routes/_nvent/triggers'), method: 'get' })
      addServerHandler({ route: '/api/_nvent/traces', handler: resolve('./runtime/nitro/routes/_nvent/traces'), method: 'get' })
      addServerHandler({ route: '/api/_nvent/logs', handler: resolve('./runtime/nitro/routes/_nvent/logs'), method: 'get' })
      addServerHandler({ route: '/api/_nvent/metrics', handler: resolve('./runtime/nitro/routes/_nvent/metrics'), method: 'get' })
      addServerHandler({ route: '/api/_nvent/trigger/:id', handler: resolve('./runtime/nitro/routes/_nvent/invoke'), method: 'post' })
    }

    // Proxy /functions/** to the iii engine HTTP API.
    // routeRules with proxy also tells the client-side router to skip these paths.
    const nitroOpts = (nuxt.options as any).nitro ??= {}
    nitroOpts.routeRules ??= {}
    const engineHost = iiiOpts.httpHost ?? 'localhost'
    nitroOpts.routeRules['/functions/**'] = { proxy: `http://${engineHost}:${engineCfg.httpPort}/**` }
    // Enable Nitro WebSocket support so the stream-proxy route handler works.
    nitroOpts.experimental ??= {}
    nitroOpts.experimental.websocket = true

    // Proxy WebSocket connections for the iii Stream module via a dedicated handler.
    // The iii stream port is separate (default 3112); the handler bridges /stream/**
    // WebSocket connections from the Nuxt origin to that port transparently.
    addServerHandler({ route: '/stream/**', handler: resolve('./runtime/nitro/routes/stream-proxy') })

    // Auto-imports for function files
    addServerImports([
      {
        name: 'useIii',
        from: resolve('./runtime/nitro/utils/useIii'),
      },
      {
        name: 'useIiiHealth',
        from: resolve('./runtime/nitro/utils/useIii'),
      },
      {
        name: 'getContext',
        from: resolve('./runtime/nitro/utils/useIii'),
      },
      {
        name: 'defineFunction',
        from: resolve('./runtime/nitro/utils/defineFunction'),
      },
      {
        name: 'FunctionContext',
        from: resolve('./runtime/nitro/utils/defineFunction'),
      },
    ])

    // Client-side auto-imports (Vue composables)
    addImports([
      {
        name: 'useFunctionCall',
        from: resolve('./runtime/app/composables/useFunctionCall'),
      },
      {
        name: 'useNventStream',
        from: resolve('./runtime/app/composables/useNventStream'),
      },
    ])

    // Engine lifecycle management
    // For 'local' mode: binaries are downloaded here (both dev and prod build).
    // Dev:  engine + console + Python workers are started in the Nuxt process so they
    //       survive Nitro hot-reloads.
    // Prod: binaries are copied to .output/.nvent/bin/ so the Docker image is self-contained.
    //       The lifecycle Nitro plugin (01.iii-lifecycle.ts) handles actual startup at runtime.
    if (managed && mode === 'local') {
      const nventDir = join(nuxt.options.rootDir, 'node_modules', '.nvent')
      const binDir = join(nventDir, 'bin')
      const version = iiiOpts.version ?? 'latest'
      const logLevel = iiiOpts.logLevel ?? 'warn'

      // Download iii engine binary (idempotent — skipped if already at the right version).
      const binaryPath = await ensureIiiEngine({ binDir, version, logLevel })

      // Download iii-console binary if the console UI is requested (dev + prod).
      let consoleBinaryPath: string | undefined
      if (iiiOpts.console) {
        const uiCfg = typeof iiiOpts.console === 'object' ? iiiOpts.console : {}
        consoleBinaryPath = await ensureIiiConsole({ binDir, version: uiCfg.version ?? version, logLevel })
      }

      if (nuxt.options.dev) {
        // --- Dev: start everything in the Nuxt process ---
        const nventConfigPath = join(nventDir, 'iii-config.yaml')
        writeIiiConfig(nventConfigPath, engineCfg)
        const engine = createEngineManager({
          binaryPath,
          configPath: nventConfigPath,
          httpPort: engineCfg.httpPort,
          wsPort: engineCfg.wsPort,
          logLevel,
        })
        await engine.start()
        nuxt.hook('close', async () => { await engine.stop() })

        if (!skipPython) {
          // Install Python requirements at dev startup
          for (const reqPath of [
            join(nuxt.options.rootDir, 'requirements.txt'),
            join(nuxt.options.rootDir, 'server', 'requirements.txt'),
          ]) {
            await installPythonRequirements(reqPath, pythonBin, logLevel)
          }

          // Start Python workers in the Nuxt process so they survive Nitro hot-reloads
          // and can be restarted directly on .py file changes without globalThis tricks.
          const workersDir = join(nventDir, 'workers')
          const pythonOrchestrator = new PythonWorkersOrchestrator(
            workersDir,
            readFileSync(PYTHON_RUNTIME_SRC, 'utf-8'),
            readFileSync(PYTHON_NVENT_HELPER_SRC, 'utf-8'),
            wsUrl,
            pythonBin,
            logLevel,
          )
          await pythonOrchestrator.start(lastScanned.pythonFunctions)
          nuxt.hook('close', async () => { await pythonOrchestrator.stop() })

          // Attach to Nuxt instance for Python HMR (chokidar watcher below)
          ;(nuxt as any).__nventPythonOrchestrator = pythonOrchestrator
        }

        if (iiiOpts.console && consoleBinaryPath) {
          const uiCfg = typeof iiiOpts.console === 'object' ? iiiOpts.console : {}
          const consoleManager = new ConsoleManager({
            binaryPath: consoleBinaryPath,
            port: uiCfg.port ?? 3113,
            enginePort: engineCfg.httpPort,
            bridgePort: engineCfg.wsPort,
            flow: uiCfg.flow ?? true,
            logLevel,
          })
          await consoleManager.start()
          nuxt.hook('close', async () => { await consoleManager.stop() })
        }
      }
      else {
        // nitro:build:public-assets fires after Nitro has fully written .output/server/,
        // so nothing gets wiped after our copies land.
        ;(nuxt.hook as any)('nitro:build:public-assets', async (nitro: any) => {
          // node runs from .output/ (CWD), so place files at .output/node_modules/.nvent/
          const nventDir = join(nitro.options.output.dir, 'node_modules', '.nvent')
          const binDir = join(nventDir, 'bin')
          mkdirSync(binDir, { recursive: true })
          copyFileSync(binaryPath, join(binDir, basename(binaryPath)))
          if (consoleBinaryPath) copyFileSync(consoleBinaryPath, join(binDir, basename(consoleBinaryPath)))
          writeFileSync(join(nventDir, 'iii-config.yaml'), engineConfigYaml, 'utf-8')
          if (!skipPython) {
            for (const fn of lastScanned.pythonFunctions) {
              for (const layer of layerInfos) {
                const fnDir = join(layer.serverDir, functionsDir)
                if (fn.absPath.startsWith(fnDir)) {
                  const dest = join(nventDir, 'functions', relative(fnDir, fn.absPath))
                  mkdirSync(join(dest, '..'), { recursive: true })
                  copyFileSync(fn.absPath, dest)
                  break
                }
              }
            }
          }
          console.log('[nvent] Binaries + config copied to .output/node_modules/.nvent/')
        })
      }
    }

    // Hot reload in dev: handle function file changes via Nuxt's own file watcher.
    // Using builder:watch instead of a separate chokidar instance avoids duplicated
    // watchers and lets us coordinate with Nitro's restart behaviour.
    if (nuxt.options.dev) {
      const dirsToWatch = layerInfos.map(l =>
        join(l.serverDir ?? join(l.rootDir, 'server'), functionsDir),
      )

      const refresh = debounce(async (changedPath?: string) => {
        lastScanned = await scanFunctions({ layerInfos, functionsDir })
        await updateTemplates({ filter: t => t.filename === III_REGISTRY_TEMPLATE })
        console.log(`[nvent] registry refreshed${changedPath ? ` (${changedPath})` : ''}`)

        if (!skipPython && changedPath?.endsWith('.py')) {
          const orchestrator: PythonWorkersOrchestrator | undefined = (nuxt as any).__nventPythonOrchestrator
          await orchestrator?.onFileChanged(changedPath, lastScanned.pythonFunctions)
        }
      }, 200)

      chokidar.watch(dirsToWatch, {
        ignoreInitial: true,
        ignored: ['**/node_modules/**', '**/.nuxt/**', '**/__pycache__/**', '**/*.pyc'],
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
      }).on('all', (_event, path) => refresh(path))
    }
  },
})

export type { NventIiiOptions as ModuleOptions }
