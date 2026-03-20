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
  hasNuxtModule,
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

export default defineNuxtModule<NventIiiOptions>({
  meta,
  defaults: {},
  moduleDependencies: {
    '@nvent-addon/app':{
      optional: true
    }
  },
  async setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    const PYTHON_RUNTIME_SRC = resolve('./runtime/python/worker_runtime.py')
    const PYTHON_NVENT_HELPER_SRC = resolve('./runtime/python/nvent.py')

    // -------------------------------------------------------------------------
    // Options
    // -------------------------------------------------------------------------
    const userConfig = (nuxt.options as any)[meta.configKey] ?? {}
    const opts: NventIiiOptions = { ...userConfig, ...options }
    const iiiOpts = opts.iii ?? {}

    const functionsDir = opts.functions?.dir ?? 'functions'
    const pythonBin = opts.functions?.python?.devPath
      ? join(nuxt.options.rootDir, opts.functions.python.devPath)
      : 'python3'
    const skipPython = opts.functions?.python?.skip ?? false
    const wsUrl = iiiOpts.wsUrl ?? 'ws://localhost:49134'
    const mode = iiiOpts.mode ?? 'local'
    // managed: true by default for local mode — nvent owns the engine lifecycle.
    // false for docker/remote modes where an external service runs the engine.
    const managed = iiiOpts.managed ?? (mode === 'local')
    const version = iiiOpts.version ?? 'latest'
    const logLevel = iiiOpts.logLevel ?? 'warn'
    const consoleCfg = typeof iiiOpts.console === 'object' ? iiiOpts.console : {}

    // -------------------------------------------------------------------------
    // IDE integration: install nvent.py into the venv site-packages so
    // Pylance / VS Code resolves `from nvent import ...` automatically.
    // -------------------------------------------------------------------------
    installNventPyToSitePackages(pythonBin, readFileSync(PYTHON_NVENT_HELPER_SRC, 'utf-8'))

    // -------------------------------------------------------------------------
    // Forward nvent.app options to @nvent-addon/app (configKey: 'nventapp').
    // nvent runs first in module order, so values set here become defaults for
    // @nvent-addon/app. Direct `nventapp` config in nuxt.config takes priority.
    // -------------------------------------------------------------------------
    if (hasNuxtModule('@nvent-addon/app')) {
      const nventOpts = nuxt.options as any
      nventOpts.nventapp ??= {}
      nventOpts.nventapp.route ??= opts.app?.enabled !== false
      if (opts.app?.routePath) nventOpts.nventapp.routePath ??= opts.app.routePath
      if (opts.app?.layout !== undefined) nventOpts.nventapp.layout ??= opts.app.layout
    }

    // -------------------------------------------------------------------------
    // Engine config + runtimeConfig
    // -------------------------------------------------------------------------
    const engineCfg = buildEngineConfig(iiiOpts)
    const engineConfigYaml = generateIiiConfigYaml(engineCfg)

    // Write iii-config.yaml into .nuxt/ so the dev-mode Nitro server can read it.
    writeIiiConfig(join(nuxt.options.buildDir, 'iii-config.yaml'), engineCfg)

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
        version,
        modules: engineCfg.modules,
        logLevel,
        // YAML config embedded at build time so the production lifecycle plugin can
        // write iii-config.yaml without needing confbox or rebuilding from options.
        engineConfigYaml,
      },
      python: {
        runtimeContent: skipPython ? '' : readFileSync(PYTHON_RUNTIME_SRC, 'utf-8'),
        nventHelperContent: skipPython ? '' : readFileSync(PYTHON_NVENT_HELPER_SRC, 'utf-8'),
        skip: skipPython,
      },
      console: {
        enabled: !!iiiOpts.console,
        version: consoleCfg.version ?? '',
        port: consoleCfg.port ?? 3113,
        host: consoleCfg.host ?? 'localhost',
        flow: consoleCfg.flow ?? true,
      },
    }

    // -------------------------------------------------------------------------
    // Function registry
    // -------------------------------------------------------------------------
    const layerInfos = nuxt.options._layers.map(l => ({
      rootDir: l.config.rootDir,
      serverDir: l.config?.serverDir ?? join(l.config.rootDir, 'server'),
    }))

    let lastScanned: ScannedRegistry = await scanFunctions({ layerInfos, functionsDir })

    // In production, Python absPath values are rewritten to paths relative to
    // .output/nvent/functions/ (e.g. 'analyze.py') so the worker plugin can
    // resolve them regardless of where .output/ is deployed.
    let pythonPathRewrite: PythonPathRewrite | undefined
    if (!nuxt.options.dev && !skipPython && lastScanned.pythonFunctions.length > 0) {
      pythonPathRewrite = new Map()
      for (const fn of lastScanned.pythonFunctions) {
        for (const layer of layerInfos) {
          const fnDir = join(layer.serverDir, functionsDir)
          if (fn.absPath.startsWith(fnDir)) {
            pythonPathRewrite.set(fn.absPath, relative(fnDir, fn.absPath))
            break
          }
        }
      }
    }

    addTemplate({
      filename: III_REGISTRY_TEMPLATE,
      write: true,
      getContents: () => generateIiiRegistryTemplate(lastScanned, pythonPathRewrite),
    })
    const registryTemplatePath = resolve(nuxt.options.buildDir, III_REGISTRY_TEMPLATE)
    nuxt.options.alias['#nvent/iii-registry'] = registryTemplatePath
    // Transpile so Nitro bundles the registry + all function .ts files; without
    // this Node.js ESM tries to load them raw and virtual aliases like `#imports` break.
    nuxt.options.build.transpile.push(registryTemplatePath)

    // -------------------------------------------------------------------------
    // Nuxt / Nitro wiring (always, dev + prod)
    // -------------------------------------------------------------------------

    // Server plugins: lifecycle first (starts the engine), workers second (connects).
    addServerPlugin(resolve('./runtime/nitro/plugins/00.iii-lifecycle'))
    addServerPlugin(resolve('./runtime/nitro/plugins/01.iii-worker'))

    // Proxy /functions/** to the iii engine HTTP API.
    const nitroOpts = (nuxt.options as any).nitro ??= {}
    nitroOpts.routeRules ??= {}
    nitroOpts.routeRules['/functions/**'] = {
      proxy: `http://${iiiOpts.httpHost ?? 'localhost'}:${engineCfg.httpPort}/**`,
    }
    // WebSocket support for the stream-proxy route handler.
    nitroOpts.experimental ??= {}
    nitroOpts.experimental.websocket = true
    addServerHandler({ route: '/stream/**', handler: resolve('./runtime/nitro/routes/stream-proxy') })

    // Server auto-imports
    addServerImports([
      { from: resolve('./runtime/nitro/utils/useIii'), name: 'useIii' },
      { from: resolve('./runtime/nitro/utils/useIii'), name: 'useIiiHealth' },
      { from: resolve('./runtime/nitro/utils/useIii'), name: 'getContext' },
      { from: resolve('./runtime/nitro/utils/defineFunction'), name: 'defineFunction' },
      { from: resolve('./runtime/nitro/utils/defineFunction'), name: 'FunctionContext' },
    ])

    // Client-side composables
    addImports([
      { from: resolve('./runtime/app/composables/useFunctionCall'), name: 'useFunctionCall' },
      { from: resolve('./runtime/app/composables/useNventStream'), name: 'useNventStream' },
    ])

    // -------------------------------------------------------------------------
    // Dev mode
    // -------------------------------------------------------------------------
    if (nuxt.options.dev) {
      const nventDir = join(nuxt.options.rootDir, 'node_modules', '.nvent')
      const binDir = join(nventDir, 'bin')

      if (managed && mode === 'local') {
        // Download binaries (idempotent — skipped when already at the right version).
        const binaryPath = await ensureIiiEngine({ binDir, version, logLevel })
        const consoleBinaryPath = iiiOpts.console
          ? await ensureIiiConsole({ binDir, version: consoleCfg.version ?? version, logLevel })
          : undefined

        // Start the engine in the Nuxt process so it survives Nitro hot-reloads.
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

        // Start the console UI if configured.
        if (consoleBinaryPath) {
          const consoleManager = new ConsoleManager({
            binaryPath: consoleBinaryPath,
            port: consoleCfg.port ?? 3113,
            enginePort: engineCfg.httpPort,
            bridgePort: engineCfg.wsPort,
            flow: consoleCfg.flow ?? true,
            logLevel,
          })
          await consoleManager.start()
          nuxt.hook('close', async () => { await consoleManager.stop() })
        }
      }

      if (!skipPython) {
        const nventDir = join(nuxt.options.rootDir, 'node_modules', '.nvent')

        // Install Python requirements on dev startup.
        for (const reqPath of [
          join(nuxt.options.rootDir, 'requirements.txt'),
          join(nuxt.options.rootDir, 'server', 'requirements.txt'),
        ]) {
          await installPythonRequirements(reqPath, pythonBin, logLevel)
        }

        // Start Python workers in the Nuxt process so they survive Nitro hot-reloads
        // and can be restarted directly on .py file changes.
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
        ;(nuxt as any).__nventPythonOrchestrator = pythonOrchestrator
      }

      // HMR: watch function files and refresh the registry on changes.
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

    // -------------------------------------------------------------------------
    // Production build
    // nitro:build:public-assets fires after Nitro has written .output/server/,
    // so our copies land after Nitro is done and nothing gets wiped.
    // -------------------------------------------------------------------------
    else {
      if (managed && mode === 'local') {
        // Download binaries at build time so they can be embedded in the image.
        const binDir = join(nuxt.options.rootDir, 'node_modules', '.nvent', 'bin')
        const binaryPath = await ensureIiiEngine({ binDir, version, logLevel })
        const consoleBinaryPath = iiiOpts.console
          ? await ensureIiiConsole({ binDir, version: consoleCfg.version ?? version, logLevel })
          : undefined

        ;(nuxt.hook as any)('nitro:build:public-assets', async (nitro: any) => {
          const outputNventDir = join(nitro.options.output.dir, 'nvent')
          const outputBinDir = join(outputNventDir, 'bin')
          mkdirSync(outputBinDir, { recursive: true })
          copyFileSync(binaryPath, join(outputBinDir, basename(binaryPath)))
          if (consoleBinaryPath) copyFileSync(consoleBinaryPath, join(outputBinDir, basename(consoleBinaryPath)))
          writeFileSync(join(outputNventDir, 'iii-config.yaml'), engineConfigYaml, 'utf-8')
          console.log('[nvent] Engine binaries + config copied to .output/nvent/')
        })
      }

      if (!skipPython) {
        ;(nuxt.hook as any)('nitro:build:public-assets', async (nitro: any) => {
          const outputNventDir = join(nitro.options.output.dir, 'nvent')
          const workersDir = join(outputNventDir, 'workers')
          mkdirSync(workersDir, { recursive: true })
          copyFileSync(PYTHON_RUNTIME_SRC, join(workersDir, '_runtime.py'))
          copyFileSync(PYTHON_NVENT_HELPER_SRC, join(workersDir, 'nvent.py'))

          for (const fn of lastScanned.pythonFunctions) {
            for (const layer of layerInfos) {
              const fnDir = join(layer.serverDir, functionsDir)
              if (fn.absPath.startsWith(fnDir)) {
                const dest = join(outputNventDir, 'functions', relative(fnDir, fn.absPath))
                mkdirSync(join(dest, '..'), { recursive: true })
                copyFileSync(fn.absPath, dest)
                break
              }
            }
          }
          console.log('[nvent] Python worker files copied to .output/nvent/')
        })
      }
    }
  },
})
