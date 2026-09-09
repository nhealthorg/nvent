/**
 * nvent Module — iii engine integration
 *
 * This is the new module entrypoint for nvent v1.x built on the iii engine.
 * No backward compatibility with previous adapter-based config.
 *
 * What this module does:
 * 1. Installs the iii engine binary locally if missing
 * 2. Generates worker-compose.yaml from nvent options
 * 3. Starts/stops the iii compose daemon in dev mode
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
} from '@nuxt/kit'
import { readFileSync, copyFileSync, mkdirSync, writeFileSync, existsSync, chmodSync, statSync, utimesSync, cpSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { addCustomTab } from '@nuxt/devtools-kit'
import { ensureIiiEngine, ensureIiiWorker, assertSupportedIiiVersion } from './iii/install'
import {
  buildEngineConfig,
} from './iii/config'
import { generateWorkerComposeYaml } from './iii/compose'
import { resolveExtendedFunctionAbsPath } from './iii/extendedFunctionPath'
import { mergeExtendedQueueConfigs, type NventExtendedQueueDefinition } from './iii/extendedQueues'
import type { NventIiiOptions } from './types'
import { scanFunctions, generateIiiRegistryTemplate, type ScannedRegistry, type PythonPathRewrite, type LayerInfo } from './iii/registry'
import { installNventPyToSitePackages, installPythonRequirements, writePyrightConfig, ensurePythonVenv, installPythonPackages } from './iii/python'
import { PythonWorkersOrchestrator } from './runtime/nitro/utils/workers/python'
import { WorkflowWorkerManager, resolveWorkflowBinaryFromPackageRoot } from './runtime/nitro/utils/workers/workflow'
import { createComposeManager } from './runtime/nitro/utils/compose'
import { printNventStartupReport } from './runtime/nitro/utils/startup-report'

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

function getWorkflowBinaryName(): string {
  return process.platform === 'win32' ? 'workflow.exe' : 'workflow'
}

async function resolveAvailablePort(preferredPort: number, host = '127.0.0.1', maxAttempts = 25): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferredPort + i
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.once('listening', () => {
          server.close(() => resolve())
        })
        server.listen(port, host)
      })
      return port
    }
    catch {
      // Port is occupied; keep scanning only as a fallback.
    }
  }
  return preferredPort
}

function pickFirstExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] ?? ''
}

function stageWorkflowBinary(targetBinDir: string, packageRootDir: string): string | undefined {
  try {
    const source = resolveWorkflowBinaryFromPackageRoot(packageRootDir)
    if (!source) return undefined
    if (!existsSync(source)) return undefined
    
    mkdirSync(targetBinDir, { recursive: true })
    const target = join(targetBinDir, getWorkflowBinaryName())

    // Check if the target is already modern and exists before copying.
    // This prevents "Text file busy" errors if the engine is already running 
    // or another process has the binary open.
    if (existsSync(target)) {
      try {
        const sourceStat = statSync(source)
        const targetStat = statSync(target)
        // If the binary is current (size AND mtime), skip the copy.
        if (sourceStat.size === targetStat.size && sourceStat.mtimeMs === targetStat.mtimeMs) {
          return target
        }
      } catch {
        // Fallback to copy if stat fails
      }
    }

    try {
      copyFileSync(source, target)
    }
    catch (err: any) {
      // Another still-running process may execute this file during a quick dev restart.
      // Reuse the existing binary instead of failing the whole managed startup.
      if (err?.code === 'ETXTBSY' && existsSync(target)) {
        return target
      }
      throw err
    }
    utimesSync(target, statSync(source).atime, statSync(source).mtime)
    if (process.platform !== 'win32') {
      chmodSync(target, 0o755)
    }
    return target
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[nvent] workflow worker binary could not be staged to .nvent/bin: ${message}`)
    return undefined
  }
}

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
    const workflowPackageRoot = pickFirstExistingPath([
      resolve('../../workflow-worker'),
      resolve(nuxt.options.rootDir, '../packages/workflow-worker'),
      resolve(nuxt.options.rootDir, '../../packages/workflow-worker'),
    ])
    const workflowRustRoot = pickFirstExistingPath([
      resolve('../../../workers/workflow'),
      resolve(nuxt.options.rootDir, '../workers/workflow'),
      resolve(nuxt.options.rootDir, '../../workers/workflow'),
    ])

    // -------------------------------------------------------------------------
    // Options
    // -------------------------------------------------------------------------
    const userConfig = (nuxt.options as any)[meta.configKey] ?? {}
    const opts: NventIiiOptions = { ...userConfig, ...options }
    const iiiOpts = opts.iii ?? {}

    const functionsDir = opts.functions?.dir ?? 'functions'
    const workflowsDir = opts.workflows?.dir ?? 'workflows'
    const defaultWsPort = 49134
    const defaultHttpPort = 3111
    const defaultStreamPort = 3112
    const defaultConsolePort = 3113

    const rawPythonPath = opts.functions?.python?.devPath ?? '.venv/bin/python3'
    const pythonBin = isAbsolute(rawPythonPath) ? rawPythonPath : join(nuxt.options.rootDir, rawPythonPath)
    const skipPython = opts.functions?.python?.skip ?? false
    const consoleCfg = typeof iiiOpts.console === 'object' ? iiiOpts.console : {}

    const configuredWsPort = iiiOpts.wsPort
    const configuredHttpPort = iiiOpts.httpPort
    const configuredStreamPort = iiiOpts.streamPort
    const configuredConsolePort = consoleCfg.port

    const resolvedWsPort = configuredWsPort ?? await resolveAvailablePort(defaultWsPort)
    const resolvedHttpPort = configuredHttpPort ?? await resolveAvailablePort(defaultHttpPort)
    const resolvedStreamPort = configuredStreamPort ?? await resolveAvailablePort(defaultStreamPort)
    const resolvedConsolePort = configuredConsolePort ?? await resolveAvailablePort(defaultConsolePort)
    const wsUrl = iiiOpts.wsUrl ?? `ws://localhost:${resolvedWsPort}`
    const composeOpts = iiiOpts.compose ?? {}
    const namespaceOpts = iiiOpts.namespace ?? {}
    const namespaceMode = namespaceOpts.mode ?? 'single'
    const namespaceDefault = (namespaceOpts.default ?? 'default').trim() || 'default'
    const namespaceMap = namespaceOpts.map ?? {}
    const composeDaemonNamespace = (composeOpts.daemonNamespace ?? namespaceDefault).trim() || namespaceDefault
    const composeProjectNamespace = namespaceMode === 'mapped'
      ? ((namespaceMap.compose ?? namespaceDefault).trim() || namespaceDefault)
      : namespaceDefault

    // Compose is the only runtime path in iii 0.23+.
    const managed = composeOpts.managed ?? true
    const composeUpOnStart = composeOpts.upOnStart ?? true
    const composeLogLevel = composeOpts.logLevel ?? 'info'
    const composeCompactLogs = composeOpts.compactLogs ?? true
    const composeWaitForUp = composeOpts.waitForUp ?? true
    const composeUpTimeoutMs = composeOpts.upTimeoutMs ?? 120_000
    const composeWorkflowWorkerSource = composeOpts.workflowWorkerSource ?? 'path'
    const composeFileName = (composeOpts.file ?? 'worker-compose.yaml').trim() || 'worker-compose.yaml'

    const version = iiiOpts.version ?? 'latest'
    assertSupportedIiiVersion(version)
    const logLevel = iiiOpts.logLevel ?? 'warn'
    const failOnInstallFailure = iiiOpts.failOnInstallFailure ?? false

    const packageRootDir = workflowPackageRoot
    // Nuxt-native runtime root: dev under .nuxt, build staging under node_modules/.nvent.
    const nventDir = nuxt.options.dev
      ? join(nuxt.options.buildDir, 'nvent')
      : join(nuxt.options.rootDir, 'node_modules', '.nvent')
    const nventBinDir = join(nventDir, 'bin')
    const stagedWorkflowBinary = stageWorkflowBinary(nventBinDir, packageRootDir)

    // Instantiate the WorkflowWorkerManager to allow iii config generation to use it.
    // Prefer a stable, relocatable command path from nvent's artifact bin dir.
    new WorkflowWorkerManager(
      wsUrl,
      workflowRustRoot,
      packageRootDir,
      iiiOpts.workflow,
      stagedWorkflowBinary ? join('.', 'bin', getWorkflowBinaryName()) : undefined,
    )

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

    const engineCfg = buildEngineConfig({
      ...iiiOpts,
      wsPort: resolvedWsPort,
      httpPort: resolvedHttpPort,
      streamPort: resolvedStreamPort,
    }, mergedQueues.queueConfigs)
    // Compose source-of-truth for iii 0.23+ runtime orchestration.
    mkdirSync(nventDir, { recursive: true })
    // Remove legacy layout artifacts from old engine-first paths.
    rmSync(join(nventDir, 'compose'), { recursive: true, force: true })
    rmSync(join(nventDir, 'config.yaml'), { force: true, recursive: false })
    rmSync(join(nventDir, 'iii-config.yaml'), { force: true, recursive: false })

    const composeYaml = generateWorkerComposeYaml({
      nventVersion: meta.version,
      iiiVersion: version,
      daemonNamespace: composeDaemonNamespace,
      projectNamespace: composeProjectNamespace,
      engineUrl: wsUrl,
      wsPort: engineCfg.wsPort,
      streamPort: engineCfg.streamPort,
      browserPort: engineCfg.workerManagerRbac?.port,
      stateConfig: engineCfg.state as Record<string, unknown> | undefined,
      queueConfig: engineCfg.queue as Record<string, unknown> | undefined,
      cronConfig: engineCfg.cron as Record<string, unknown> | undefined,
      pubsubConfig: engineCfg.pubsub as Record<string, unknown> | undefined,
      httpConfig: engineCfg.httpFunctions as Record<string, unknown> | undefined,
      streamConfig: engineCfg.stream as Record<string, unknown> | undefined,
      includeState: engineCfg.modules.state !== false,
      includeQueue: engineCfg.modules.queue !== false,
      includeCron: engineCfg.modules.cron !== false,
      includePubsub: engineCfg.modules.pubsub === true,
      includeHttp: engineCfg.modules.httpFunctions === true,
      includeStream: engineCfg.modules.stream !== false,
      includeConsole: !!iiiOpts.console,
      consoleVersion: consoleCfg.version,
      consoleConfig: iiiOpts.console ? { http_port: resolvedConsolePort } : undefined,
      workflowWorker: {
        source: composeWorkflowWorkerSource,
        containerName: composeOpts.workflowWorkerContainerName,
        packageName: composeOpts.workflowWorkerPackageName,
        packageVersion: composeOpts.workflowWorkerPackageVersion,
        startupTimeout: composeOpts.workflowStartupTimeout,
      },
    })
    const composeFilePath = join(nventDir, composeFileName)
    writeFileSync(composeFilePath, composeYaml, 'utf-8')

    if (composeWorkflowWorkerSource === 'path') {
      mkdirSync(join(nventDir, 'workers', 'workflow'), { recursive: true })
    }

    if (composeWorkflowWorkerSource === 'path' && !stagedWorkflowBinary) {
      const message = '[nvent] Compose workflow worker source is path, but workflow binary could not be staged. Managed runtime requires a valid workflow binary.'
      if (failOnInstallFailure || managed) {
        throw new Error(message)
      }
      console.warn(message)
    }

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
        version,
        modules: engineCfg.modules,
        logLevel,
        namespace: {
          mode: namespaceMode,
          default: namespaceDefault,
          map: {
            app: namespaceMap.app ?? namespaceDefault,
            workflows: namespaceMap.workflows ?? namespaceDefault,
            browser: namespaceMap.browser ?? namespaceDefault,
            compose: namespaceMap.compose ?? namespaceDefault,
          },
        },
        compose: {
          managed,
          upOnStart: composeUpOnStart,
          daemonNamespace: composeDaemonNamespace,
          projectNamespace: composeProjectNamespace,
          file: composeFileName,
          workflowWorkerSource: composeWorkflowWorkerSource,
          workerComposeYaml: composeYaml,
        },
        browserAuthFunctionId: iiiOpts.workerManager?.rbac?.authFunctionId ?? 'nvent::browser::auth',
        browserAuth: {
          // Signed, short-lived token is minted by /_iii/browser and validated by nvent::browser::auth.
          secret: process.env.NVENT_BROWSER_AUTH_SECRET ?? randomUUID(),
          tokenTtlSeconds: iiiOpts.workerManager?.rbac?.tokenTtlSeconds ?? 120,
          allowAnonymous: iiiOpts.workerManager?.rbac?.allowAnonymous ?? true,
          authResolverPath: iiiOpts.workerManager?.rbac?.authResolverPath,
        },
      },
      python: {
        runtimeContent: skipPython ? '' : readFileSync(PYTHON_RUNTIME_SRC, 'utf-8'),
        nventHelperContent: skipPython ? '' : readFileSync(PYTHON_NVENT_HELPER_SRC, 'utf-8'),
        skip: skipPython,
        extraPaths: (opts.functions?.python?.extraPaths ?? []).map((p) => {
          // In production, we assume they are copied into 'libs/' relative to .output/nvent/
          if (nuxt.options.dev) {
            return isAbsolute(p) ? p : join(nuxt.options.rootDir, p)
          }
          return join('libs', basename(p))
        }),
      },
      console: {
        enabled: !!iiiOpts.console,
        version: consoleCfg.version ?? '',
        port: resolvedConsolePort,
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
          runtime: 'nodejs',
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
          runtime: 'python',
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
          runtime: 'nodejs',
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
    nuxt.options.alias['#nvent/types'] = resolve('./runtime/nitro/utils/workflow-types')
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

    // Ensure types are available for aliases
    nuxt.hook('prepare:types', ({ references }) => {
      references.push({ path: resolve('./runtime/nitro/utils/workflow-types.ts') })
    })

    // Client-side composables
    addImports([
      { from: resolve('./runtime/app/composables/useIiiStream'), name: 'useIiiStream' },
      { from: resolve('./runtime/app/composables/useIii'), name: 'useIii' },
      { from: resolve('./runtime/app/composables/useWorkflowStream'), name: 'useWorkflowStream' },
      { from: resolve('./runtime/app/composables/useWorkflow'), name: 'useWorkflow' },
    ])

    // Client-side plugin (connects iii-browser-sdk)
    addPlugin({ src: resolve('./runtime/app/plugins/iii.client'), mode: 'client' })

    // -------------------------------------------------------------------------
    // Dev mode
    // -------------------------------------------------------------------------
    if (nuxt.options.dev) {
      // Write pyrightconfig.json so any pyright-aware editor (VS Code/Pylance,
      // neovim, etc.) auto-resolves the venv and function paths without manual setup.
      if (!skipPython && rawPythonPath.includes('/bin/python')) {
        writePyrightConfig({
          rootDir: nuxt.options.rootDir,
          devPath: rawPythonPath,
          includePaths: layerInfos.map(l => join(l.serverDir, functionsDir)),
          extraPaths: opts.functions?.python?.extraPaths,
        })
      }

      const binDir = join(nventDir, 'bin')

      if (managed) {
        printNventStartupReport({
          wsUrl,
          httpPort: resolvedHttpPort,
          httpHost: iiiOpts.httpHost ?? 'localhost',
          streamPort: resolvedStreamPort,
          consolePort: resolvedConsolePort,
          consoleEnabled: !!iiiOpts.console,
          composeNamespace: composeDaemonNamespace,
          composeFilePath,
        })

        // Download binaries (idempotent — skipped when already at the right version).
        let binaryPath: string | undefined
        let workerBinaryPath: string | undefined
        try {
          binaryPath = await ensureIiiEngine({ binDir, version, logLevel })
          workerBinaryPath = await ensureIiiWorker({ binDir, version, logLevel })
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
          try {
            const compose = createComposeManager({
              binaryPath,
              composeFilePath,
              daemonNamespace: composeDaemonNamespace,
              upOnStart: composeUpOnStart,
              composeStateDir: join(nventDir, '.compose-state'),
              resetNamespaceStateOnStart: true,
              logLevel: composeLogLevel,
              compactLogs: composeCompactLogs,
              waitForUp: composeWaitForUp,
              upTimeoutMs: composeUpTimeoutMs,
              workingDir: nventDir,
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
            nuxt.hook('close', async () => { await stopCompose() })
          }
          catch (err: any) {
            console.error('[nvent] Failed to start iii compose daemon — continuing without managed runtime. Error:')
            if (err && err.stack) console.error(err.stack)
            else console.error(JSON.stringify(err, Object.getOwnPropertyNames(err)))
            if (failOnInstallFailure) {
              console.error('[nvent] failOnInstallFailure enabled — aborting startup.')
              process.exit(1)
            }
          }

          // Console is started via compose container when enabled.
          if (iiiOpts.console) {
            const consolePort = resolvedConsolePort
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
        }
      }

      if (!skipPython) {
    // 1. Ensure venv exists if devPath is a venv path.
    await ensurePythonVenv(pythonBin, logLevel)

    // 2. Install nvent.py helper into site-packages for IDE support
    installNventPyToSitePackages(pythonBin, readFileSync(PYTHON_NVENT_HELPER_SRC, 'utf-8'))

    // 3. Install Python requirements on dev startup.
    for (const reqPath of [
          join(nuxt.options.rootDir, 'requirements.txt'),
          join(nuxt.options.rootDir, 'server', 'requirements.txt'),
        ]) {
          await installPythonRequirements(reqPath, pythonBin, logLevel)
        }

        // 3. Install explicit requirements from config + always iii-sdk
        const extraReqs = ['iii-sdk', ...(opts.functions?.python?.requirements ?? [])]
        await installPythonPackages(extraReqs, pythonBin, logLevel)

        // 4. Resolve extra paths for PYTHONPATH
        const pythonExtraPaths = (opts.functions?.python?.extraPaths ?? [])
          .map(p => isAbsolute(p) ? p : join(nuxt.options.rootDir, p))

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
          pythonExtraPaths,
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
      ;(nuxt.hook as any)('nitro:build:public-assets', async (nitro: any) => {
        const outputNventDir = join(nitro.options.output.dir, 'nvent')
        rmSync(join(outputNventDir, 'compose'), { recursive: true, force: true })
        rmSync(join(outputNventDir, 'config.yaml'), { force: true, recursive: false })
        rmSync(join(outputNventDir, 'iii-config.yaml'), { force: true, recursive: false })
        mkdirSync(outputNventDir, { recursive: true })
        writeFileSync(join(outputNventDir, composeFileName), composeYaml, 'utf-8')
      })

      if (managed) {
        // Download binaries at build time so they can be embedded in the image.
        const binDir = join(nuxt.options.rootDir, 'node_modules', '.nvent', 'bin')
        let binaryPath: string | undefined
        let workerBinaryPath: string | undefined
        try {
          binaryPath = await ensureIiiEngine({ binDir, version, logLevel })
          workerBinaryPath = await ensureIiiWorker({ binDir, version, logLevel })
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
            if (workerBinaryPath) copyFileSync(workerBinaryPath, join(outputBinDir, basename(workerBinaryPath)))
            if (stagedWorkflowBinary && existsSync(stagedWorkflowBinary)) {
              const workflowTarget = join(outputBinDir, getWorkflowBinaryName())
              copyFileSync(stagedWorkflowBinary, workflowTarget)
              if (process.platform !== 'win32') {
                chmodSync(workflowTarget, 0o755)
              }
            }
            if (composeWorkflowWorkerSource === 'path') {
              mkdirSync(join(outputNventDir, 'workers', 'workflow'), { recursive: true })
            }
            console.log('[nvent] Engine binaries copied to .output/nvent/')
          })
        }
      }

      if (!skipPython) {
        ;(nuxt.hook as any)('nitro:build:public-assets', async (nitro: any) => {
          const outputNventDir = join(nitro.options.output.dir, 'nvent')
          const workersDir = join(outputNventDir, 'workers')
          const outputRequirementsDir = join(outputNventDir, 'requirements')
          mkdirSync(workersDir, { recursive: true })
          mkdirSync(outputRequirementsDir, { recursive: true })
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

          const requirementsCandidates: Array<{ src: string, name: string }> = [
            { src: join(nuxt.options.rootDir, 'requirements.txt'), name: 'requirements.txt' },
            { src: join(nuxt.options.rootDir, 'server', 'requirements.txt'), name: 'server-requirements.txt' },
          ]

          for (const req of requirementsCandidates) {
            if (!existsSync(req.src)) continue
            let content = readFileSync(req.src, 'utf-8')
            const extras = opts.functions?.python?.extraPaths ?? []
            if (extras.length > 0) {
              content += '\n\n# nvent extraPaths (auto-added during build)\n'
              for (const p of extras) {
                // We use relative path to the copied directory in .output/nvent/
                // requirements.txt is in .output/nvent/requirements/
                // libs are in .output/nvent/libs/
                // So path is ../libs/<basename>
                content += `../libs/${basename(p)}\n`
              }
            }
            writeFileSync(join(outputRequirementsDir, req.name), content, 'utf-8')
          }

          // Copy extraPaths to .output/nvent/libs/
          const libsDir = join(outputNventDir, 'libs')
          for (const p of (opts.functions?.python?.extraPaths ?? [])) {
            const abs = isAbsolute(p) ? p : join(nuxt.options.rootDir, p)
            if (existsSync(abs)) {
              mkdirSync(libsDir, { recursive: true })
              const dest = join(libsDir, basename(p))
              if (statSync(abs).isDirectory()) {
                cpSync(abs, dest, { recursive: true })
              }
              else {
                copyFileSync(abs, dest)
              }
            }
          }

          console.log('[nvent] Python worker files + extraPaths copied to .output/nvent/')
        })
      }
    }
  },
})
