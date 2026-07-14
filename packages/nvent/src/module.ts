/**
 * nvent Module — iii engine integration
 *
 * This is the new module entrypoint for nvent v1.x built on the iii engine.
 * No backward compatibility with previous adapter-based config.
 *
 * What this module does:
 * 1. Installs the iii engine binary locally if missing
 * 2. Generates config.yaml from nvent options
 * 3. Starts/stops the iii engine process in dev mode
 * 4. Scans server/functions/ and generates #nvent/iii-registry template
 * 5. Registers the Nitro worker plugin (connects, registers functions/triggers)
 * 6. Adds server auto-imports (useIii, defineFunction, logger, enqueue, stateManager)
 * 7. Adds nhealth console API routes
 * 8. Watches function files for changes (dev HMR)
 */

import { join, basename, relative, parse as parsePath, isAbsolute } from 'node:path'
import {
  defineNuxtModule,
  createResolver,
  addServerPlugin,
  addServerHandler,
  addServerImports,
  addImports,
  addPlugin,
  addTemplate,
  updateTemplates,
  hasNuxtModule,
  extendViteConfig
} from '@nuxt/kit'
import { readFileSync, copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { addCustomTab } from '@nuxt/devtools-kit'
import { ensureIiiEngine } from './iii/install'
import { ensureIiiConsole } from './iii/console'
import {
  writeIiiConfig,
  generateIiiConfigYaml,
  buildEngineConfig,
} from './iii/config'
import { resolveExtendedFunctionAbsPath } from './iii/extendedFunctionPath'
import { mergeExtendedQueueConfigs, type NventExtendedQueueDefinition } from './iii/extendedQueues'
import type { NventIiiOptions } from './types'
import { scanFunctions, generateIiiRegistryTemplate, type ScannedRegistry, type PythonPathRewrite, type LayerInfo } from './iii/registry'
import { installNventPyToSitePackages, installPythonRequirements, writePyrightConfig } from './iii/python'
import { PythonWorkersOrchestrator } from './runtime/nitro/utils/workers/python'
import { WorkflowWorkerManager } from './runtime/nitro/utils/workers/workflow'
import { createEngineManager } from './runtime/nitro/utils/engine'
import { ConsoleManager } from './runtime/nitro/utils/console'

import chokidar from 'chokidar'
import { debounce } from 'perfect-debounce'

export type { NventExtendedQueueDefinition, NventQueueConfig } from './iii/extendedQueues'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

const meta = {
  name: 'nvent',
  version: packageJson.version,
  configKey: 'nvent',
}

const III_REGISTRY_TEMPLATE = 'iii-registry.mjs'

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

    extendViteConfig((config) => {
      config.optimizeDeps ||= {}
      config.optimizeDeps.include ||= []
      config.optimizeDeps.include.push('iii-browser-sdk')
    })

    // -------------------------------------------------------------------------
    // Options
    // -------------------------------------------------------------------------
    const userConfig = (nuxt.options as any)[meta.configKey] ?? {}
    const opts: NventIiiOptions = { ...userConfig, ...options }
    const iiiOpts = opts.iii ?? {}

    const functionsDir = opts.functions?.dir ?? 'functions'
    const workflowsDir = opts.workflows?.dir ?? 'workflows'
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
    const failOnInstallFailure = iiiOpts.failOnInstallFailure ?? false
    const consoleCfg = typeof iiiOpts.console === 'object' ? iiiOpts.console : {}

    // Instantiate the WorkflowWorkerManager to allow iii config generation to use it.
    // The actual process is managed by the iii-exec worker in the engine.
    new WorkflowWorkerManager(
      wsUrl,
      resolve(nuxt.options.rootDir, '../packages/workflow-worker')
    )

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
    const queuePayload: NventExtendQueuesHookPayload = {
      queues: [],
      rootDir: nuxt.options.rootDir,
    }
    await nuxt.callHook('nvent:queues:extend', queuePayload)

    const mergedQueues = mergeExtendedQueueConfigs(iiiOpts.queue?.queueConfigs, queuePayload.queues)
    const mergedQueueNames = Object.keys(mergedQueues.queueConfigs)
    for (const duplicateName of mergedQueues.duplicates) {
      console.warn(`[nvent] duplicate queue definition ignored (first wins): '${duplicateName}'`)
    }
    if (logLevel === 'info') {
      console.info(`[nvent] registered queues (${mergedQueueNames.length}): ${mergedQueueNames.join(', ') || '(none)'}`)
    }

    const engineCfg = buildEngineConfig(iiiOpts, mergedQueues.queueConfigs)
    const engineConfigYaml = generateIiiConfigYaml(engineCfg)

    // Write iii config.yaml into node_modules/.nvent so external tooling or
    // engine instances that inspect .nvent can find the generated config.
    const nventDir = join(nuxt.options.rootDir, 'node_modules', '.nvent')
    // Ensure old per-service config directory is removed before writing
    // the new `config.yaml` so stale configs don't persist across restarts.
    const configDir = join(nventDir, 'config')
    if (existsSync(configDir)) {
      try {
        rmSync(configDir, { recursive: true, force: true })
        console.log('[nvent] removed existing .nvent/config')
      } catch (err: any) {
        console.warn('[nvent] failed to remove .nvent/config', err && err.message ? err.message : err)
      }
    }
    writeIiiConfig(join(nventDir, 'config.yaml'), engineCfg)

    const rc = nuxt.options.runtimeConfig as any
    rc.nvent = {
      ...(rc.nvent ?? {}),
      iii: {
        wsUrl,
        httpPort: engineCfg.httpPort,
        httpHost: iiiOpts.httpHost ?? 'localhost',
        wsPort: engineCfg.wsPort,
        streamPort: engineCfg.streamPort,
        browserPort: engineCfg.workerManagerRbac?.port ?? iiiOpts.workerManager?.rbac?.port ?? 49135,
        managed,
        mode,
        version,
        modules: engineCfg.modules,
        logLevel,
        browserAuthFunctionId: iiiOpts.workerManager?.rbac?.authFunctionId ?? 'nvent::browser::auth',
        browserAuth: {
          // Signed, short-lived token is minted by /_iii/browser and validated by nvent::browser::auth.
          secret: process.env.NVENT_BROWSER_AUTH_SECRET ?? randomUUID(),
          tokenTtlSeconds: iiiOpts.workerManager?.rbac?.tokenTtlSeconds ?? 120,
          allowAnonymous: iiiOpts.workerManager?.rbac?.allowAnonymous ?? true,
          authResolverPath: iiiOpts.workerManager?.rbac?.authResolverPath,
        },
        // YAML config embedded at build time so the production lifecycle plugin can
        // write iii config.yaml without needing confbox or rebuilding from options.
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

    /**
     * Derive the function ID prefix for a layer.
     * Priority: nvent.prefix → $meta.name → package.json name (last segment) → dir name
     * The root project (index 0 in nuxt.options._layers) is always un-prefixed.
     */
    function resolveLayerPrefix(layer: typeof nuxt.options._layers[number], isRoot: boolean): string | undefined {
      if (isRoot) return undefined
      const layerCfg = layer.config as any
      // 1. Explicit nvent.functions.prefix
      const explicit = layerCfg?.nvent?.functions?.prefix
      if (typeof explicit === 'string') return explicit || undefined
      // 2. $meta.name (standard Nuxt layer name)
      const metaName = layerCfg?.$meta?.name
      if (metaName) return metaName
      // 3. package.json name — last segment of @scope/name
      const pkgPath = join(layer.config.rootDir, 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const pkgName: string = JSON.parse(readFileSync(pkgPath, 'utf-8')).name ?? ''
          if (pkgName) return pkgName.split('/').pop()!.replace(/^nuxt-/, '')
        } catch { /* ignore */ }
      }
      // 4. Directory name
      return parsePath(layer.config.rootDir).name
    }

    const layerInfos: LayerInfo[] = nuxt.options._layers.map((l, i) => ({
      rootDir: l.config.rootDir,
      serverDir: l.config?.serverDir ?? join(l.config.rootDir, 'server'),
      prefix: resolveLayerPrefix(l, i === 0),
    }))

    async function scanFunctionsWithExtensions(): Promise<ScannedRegistry> {
      const scanned = await scanFunctions({ layerInfos, functionsDir, workflowsDir })

      const payload: NventExtendFunctionsHookPayload = {
        functions: [],
        pythonFunctions: [],
        workflows: [],
        rootDir: nuxt.options.rootDir,
        layerInfos,
        functionsDir,
        workflowsDir,
      } as any
      await nuxt.callHook('nvent:functions:extend', payload)

      const normalizePath = (path: string) => (isAbsolute(path) ? path : join(nuxt.options.rootDir, path))

      const seenTs = new Set(scanned.functions.map(f => f.id))
      for (const fn of payload.functions) {
        if (!fn?.id || !fn?.absPath) continue
        if (seenTs.has(fn.id)) {
          console.warn(`[nvent] skipping extended TS function '${fn.id}' (duplicate id)`)
          continue
        }
        const requestedPath = normalizePath(fn.absPath)
        const resolvedPath = resolveExtendedFunctionAbsPath(requestedPath)
        if (resolvedPath.rewrittenFrom) {
          console.warn(`[nvent] extended TS function path rewritten for '${fn.id}': ${resolvedPath.rewrittenFrom} -> ${resolvedPath.absPath}`)
        }
        scanned.functions.push({
          id: fn.id,
          absPath: resolvedPath.absPath,
          relativePath: basename(resolvedPath.absPath),
          description: fn.description,
        })
        seenTs.add(fn.id)
      }

      const seenPy = new Set(scanned.pythonFunctions.map(f => f.id))
      for (const fn of payload.pythonFunctions) {
        if (!fn?.id || !fn?.absPath) continue
        if (seenPy.has(fn.id)) {
          console.warn(`[nvent] skipping extended Python function '${fn.id}' (duplicate id)`)
          continue
        }
        const absPath = normalizePath(fn.absPath)
        scanned.pythonFunctions.push({
          id: fn.id,
          absPath,
          relativePath: basename(absPath),
          standalone: !!fn.standalone,
        })
        seenPy.add(fn.id)
      }

      const seenWf = new Set(scanned.workflows.map(f => f.id))
      for (const wf of payload.workflows) {
        if (!wf?.id || !wf?.absPath) continue
        if (seenWf.has(wf.id)) {
          console.warn(`[nvent] skipping extended Workflow '${wf.id}' (duplicate id)`)
          continue
        }
        const absPath = normalizePath(wf.absPath)
        scanned.workflows.push({
          id: wf.id,
          absPath,
          relativePath: basename(absPath),
          description: wf.description,
        })
        seenWf.add(wf.id)
      }

      return scanned
    }

    let lastScanned: ScannedRegistry = await scanFunctionsWithExtensions()

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
        if (!pythonPathRewrite.has(fn.absPath)) {
          const rel = `${fn.id.replace(/::/g, '/')}.py`.replace(/[^a-zA-Z0-9/_\-.]/g, '_')
          pythonPathRewrite.set(fn.absPath, rel)
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
    addServerHandler({ route: '/_iii/stream/**', handler: resolve('./runtime/nitro/routes/stream-proxy') })
    addServerHandler({ route: '/_iii/browser', handler: resolve('./runtime/nitro/routes/browser-proxy') })

    // Server auto-imports
    addServerImports([
      { from: resolve('./runtime/nitro/utils/useIii'), name: 'useIii' },
      { from: resolve('./runtime/nitro/utils/useIii'), name: 'useIiiHealth' },
      { from: resolve('./runtime/nitro/utils/defineFunction'), name: 'defineFunction' },
      { from: resolve('./runtime/nitro/utils/defineWorkflow'), name: 'defineWorkflow' },
    ])

    // #nvent/server virtual module — single import for defineFunction, useIii, Logger, etc.
    nuxt.options.alias['#nvent/server'] = resolve('./runtime/nitro/server')

    // Client-side composables
    addImports([
      { from: resolve('./runtime/app/composables/useIiiStream'), name: 'useIiiStream' },
      { from: resolve('./runtime/app/composables/useIii'), name: 'useIii' },
    ])

    // Client-side plugin (connects iii-browser-sdk)
    addPlugin({ src: resolve('./runtime/app/plugins/iii.client'), mode: 'client' })

    // -------------------------------------------------------------------------
    // Dev mode
    // -------------------------------------------------------------------------
    if (nuxt.options.dev) {
      // Write pyrightconfig.json so any pyright-aware editor (VS Code/Pylance,
      // neovim, etc.) auto-resolves the venv and function paths without manual setup.
      if (!skipPython && opts.functions?.python?.devPath) {
        writePyrightConfig({
          rootDir: nuxt.options.rootDir,
          devPath: opts.functions.python.devPath,
          includePaths: layerInfos.map(l => join(l.serverDir, functionsDir)),
        })
      }

      const binDir = join(nventDir, 'bin')

      if (managed && mode === 'local') {
        // Download binaries (idempotent — skipped when already at the right version).
        let binaryPath: string | undefined
        let consoleBinaryPath: string | undefined
        try {
          binaryPath = await ensureIiiEngine({ binDir, version, logLevel })
          consoleBinaryPath = iiiOpts.console
            ? await ensureIiiConsole({ binDir, version: consoleCfg.version ?? version, logLevel })
            : undefined
        }
        catch (err: any) {
          console.error('[nvent] III engine installation failed — skipping engine start. Error:')
          if (err && err.stack) console.error(err.stack)
          else console.error(JSON.stringify(err, Object.getOwnPropertyNames(err)))
          if (failOnInstallFailure) {
            console.error('[nvent] failOnInstallFailure enabled — aborting startup.')
            process.exit(1)
          }
          // Do not throw — continue Nuxt startup without engine.
        }

        if (binaryPath) {
          // Start the engine in the Nuxt process so it survives Nitro hot-reloads.
          const nventConfigPath = join(nventDir, 'config.yaml')
          writeIiiConfig(nventConfigPath, engineCfg)
          const engine = createEngineManager({
            binaryPath,
            configPath: nventConfigPath,
            httpPort: engineCfg.httpPort,
            wsPort: engineCfg.wsPort,
            workingDir: nventDir,
            logLevel,
          })
          try {
            await engine.start()
            nuxt.hook('close', async () => { await engine.stop() })
          }
          catch (err: any) {
            console.error('[nvent] Failed to start iii engine — continuing without engine. Error:')
            if (err && err.stack) console.error(err.stack)
            else console.error(JSON.stringify(err, Object.getOwnPropertyNames(err)))
            if (failOnInstallFailure) {
              console.error('[nvent] failOnInstallFailure enabled — aborting startup.')
              process.exit(1)
            }
          }

          // Start the console UI if configured.
          if (consoleBinaryPath) {
            const consolePort = consoleCfg.port ?? 3113
            const consoleManager = new ConsoleManager({
              binaryPath: consoleBinaryPath,
              port: consolePort,
              enginePort: engineCfg.httpPort,
              bridgePort: engineCfg.wsPort,
              flow: consoleCfg.flow ?? true,
              logLevel,
            })
            try {
              await consoleManager.start()
              nuxt.hook('close', async () => { await consoleManager.stop() })

              // Register the console as a Nuxt DevTools tab (iframe).
              addCustomTab({
                name: 'nvent-console',
                title: 'nvent',
                icon: 'carbon:flow',
                view: {
                  type: 'iframe',
                  src: `http://localhost:${consolePort}`,
                },
              })
            }
            catch (err: any) {
              console.error('[nvent] Failed to start iii console UI — continuing. Error:')
              console.error(err && err.message ? err.message : err)
            }
          }
        }
      }

      if (!skipPython) {
        

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
        lastScanned = await scanFunctionsWithExtensions()
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
        let binaryPath: string | undefined
        let consoleBinaryPath: string | undefined
        try {
          binaryPath = await ensureIiiEngine({ binDir, version, logLevel })
          consoleBinaryPath = iiiOpts.console
            ? await ensureIiiConsole({ binDir, version: consoleCfg.version ?? version, logLevel })
            : undefined
        }
        catch (err: any) {
          console.warn('[nvent] Could not download iii engine for build embedding — skipping binary copy. Error:')
          console.warn(err && err.message ? err.message : err)
        }

        if (binaryPath) {
          ;(nuxt.hook as any)('nitro:build:public-assets', async (nitro: any) => {
            const outputNventDir = join(nitro.options.output.dir, 'nvent')
            const outputBinDir = join(outputNventDir, 'bin')
            mkdirSync(outputBinDir, { recursive: true })
            copyFileSync(binaryPath, join(outputBinDir, basename(binaryPath)))
            if (consoleBinaryPath) copyFileSync(consoleBinaryPath, join(outputBinDir, basename(consoleBinaryPath)))
            writeFileSync(join(outputNventDir, 'config.yaml'), engineConfigYaml, 'utf-8')
            console.log('[nvent] Engine binaries + config copied to .output/nvent/')
          })
        }
      }

      if (!skipPython) {
        ;(nuxt.hook as any)('nitro:build:public-assets', async (nitro: any) => {
          const outputNventDir = join(nitro.options.output.dir, 'nvent')
          const workersDir = join(outputNventDir, 'workers')
          mkdirSync(workersDir, { recursive: true })
          copyFileSync(PYTHON_RUNTIME_SRC, join(workersDir, '_runtime.py'))
          copyFileSync(PYTHON_NVENT_HELPER_SRC, join(workersDir, 'nvent.py'))

          for (const fn of lastScanned.pythonFunctions) {
            let relativeDest: string | undefined
            for (const layer of layerInfos) {
              const fnDir = join(layer.serverDir, functionsDir)
              if (fn.absPath.startsWith(fnDir)) {
                relativeDest = relative(fnDir, fn.absPath)
                break
              }
            }
            relativeDest ||= pythonPathRewrite?.get(fn.absPath) ?? `${fn.id.replace(/::/g, '/')}.py`
            const dest = join(outputNventDir, 'functions', relativeDest)
            mkdirSync(join(dest, '..'), { recursive: true })
            copyFileSync(fn.absPath, dest)
          }
          console.log('[nvent] Python worker files copied to .output/nvent/')
        })
      }
    }
  },
})
