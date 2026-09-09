import { stringifyYAML } from 'confbox'
import type { ComposeEngineWorkerOverrides } from './compose-advanced'

export type WorkflowWorkerSource = 'path' | 'package'

export interface ComposeWorkflowWorkerOptions {
  containerName?: string
  source?: WorkflowWorkerSource
  packageName?: string
  packageVersion?: string
  startupTimeout?: string
}

export interface ComposeGenerationOptions {
  nventVersion: string
  iiiVersion: string
  daemonNamespace: string
  projectNamespace: string
  engineUrl: string
  wsPort: number
  streamPort: number
  browserPort?: number
  stateConfig?: Record<string, unknown>
  queueConfig?: Record<string, unknown>
  cronConfig?: Record<string, unknown>
  pubsubConfig?: Record<string, unknown>
  httpConfig?: Record<string, unknown>
  streamConfig?: Record<string, unknown>
  includeState: boolean
  includeQueue: boolean
  includeCron: boolean
  includePubsub: boolean
  includeHttp: boolean
  includeStream: boolean
  includeConsole: boolean
  startupTimeout?: string
  stopTimeout?: string
  engineWorkerOverrides?: ComposeEngineWorkerOverrides
  consoleVersion?: string
  consoleConfig?: Record<string, unknown>
  workflowWorker?: ComposeWorkflowWorkerOptions
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function deepMergeRecord(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = out[key]
    if (isObjectRecord(baseValue) && isObjectRecord(overrideValue)) {
      out[key] = deepMergeRecord(baseValue, overrideValue)
      continue
    }
    out[key] = overrideValue
  }
  return out
}

function normalizeNamespace(input: string | undefined, fallback: string): string {
  const value = String(input || '').trim()
  return value.length > 0 ? value : fallback
}

function createWorkflowContainer(worker: ComposeWorkflowWorkerOptions | undefined) {
  const containerName = (worker?.containerName || 'workflow').trim() || 'workflow'
  const source = worker?.source ?? 'path'
  const startupTimeout = worker?.startupTimeout ?? '60s'

  if (source === 'package') {
    const packageName = (worker?.packageName || '@nvent-addon/workflow-worker').trim()
    const entry: Record<string, unknown> = {
      worker: `package://${packageName}`,
      startup_timeout: startupTimeout,
    }
    if (worker?.packageVersion?.trim()) {
      entry.version = worker.packageVersion.trim()
    }
    return { containerName, entry }
  }

  return {
    containerName,
    entry: {
      worker: 'path://./workers/workflow',
      working_dir: '.',
      startup_timeout: startupTimeout,
      scripts: {
        run: './bin/workflow --url "$III_URL"',
      },
    },
  }
}

function normalizePackageVersion(input: string | undefined, fallback: string): string {
  const raw = (input ?? fallback).trim()
  if (!raw) return 'latest'
  if (raw === 'latest') return raw
  return raw.replace(/^iii\//, '').replace(/^v/, '')
}

function createConsoleContainer(options: ComposeGenerationOptions) {
  if (!options.includeConsole) return null
  const version = normalizePackageVersion(options.consoleVersion, 'latest')
  const entry: Record<string, unknown> = {
    worker: 'package://api.workers.iii.dev/console',
    version,
    config_name: 'console',
  }
  if (options.consoleConfig && Object.keys(options.consoleConfig).length > 0) {
    entry.config_override = options.consoleConfig
  }
  return {
    containerName: 'console',
    entry,
  }
}

function createDefaultServiceContainers(options: ComposeGenerationOptions): Record<string, Record<string, unknown>> {
  const version = normalizePackageVersion(undefined, 'latest')
  const containers: Record<string, Record<string, unknown>> = {}

  if (options.includeState) {
    const entry: Record<string, unknown> = {
      worker: 'package://api.workers.iii.dev/state',
      version,
    }
    if (options.stateConfig && Object.keys(options.stateConfig).length > 0) {
      entry.config_override = options.stateConfig
    }
    containers.state = entry
  }

  if (options.includeQueue) {
    const entry: Record<string, unknown> = {
      worker: 'package://api.workers.iii.dev/queue',
      version,
    }
    if (options.queueConfig && Object.keys(options.queueConfig).length > 0) {
      entry.config_override = options.queueConfig
    }
    containers.queue = entry
  }

  if (options.includeCron) {
    const entry: Record<string, unknown> = {
      worker: 'package://api.workers.iii.dev/cron',
      version,
    }
    if (options.cronConfig && Object.keys(options.cronConfig).length > 0) {
      entry.config_override = options.cronConfig
    }
    containers.cron = entry
  }

  if (options.includePubsub) {
    const entry: Record<string, unknown> = {
      worker: 'package://api.workers.iii.dev/pubsub',
      version,
    }
    if (options.pubsubConfig && Object.keys(options.pubsubConfig).length > 0) {
      entry.config_override = options.pubsubConfig
    }
    containers.pubsub = entry
  }

  if (options.includeHttp) {
    const entry: Record<string, unknown> = {
      worker: 'package://api.workers.iii.dev/http',
      version,
    }
    if (options.httpConfig && Object.keys(options.httpConfig).length > 0) {
      entry.config_override = options.httpConfig
    }
    containers.http = entry
  }

  return containers
}

export function generateWorkerComposeYaml(options: ComposeGenerationOptions): string {
  const daemonNamespace = normalizeNamespace(options.daemonNamespace, 'default')
  const projectNamespace = normalizeNamespace(options.projectNamespace, daemonNamespace)

  const workflowContainer = createWorkflowContainer(options.workflowWorker)
  const consoleContainer = createConsoleContainer(options)
  const defaultServiceContainers = createDefaultServiceContainers(options)

  const engineWorkers: Record<string, Record<string, unknown>> = {
    configuration: {
      adapter: {
        name: 'fs',
        config: {
          directory: './config',
        },
      },
      ttl_seconds: 0,
    },
    'iii-worker-manager': {
      host: '127.0.0.1',
      port: options.wsPort,
    },
    'iii-http-functions': {},
    'iii-sandbox': {
      auto_install: true,
    },
  }

  if (options.browserPort) {
    engineWorkers['iii-worker-manager#rbac'] = {
      host: '127.0.0.1',
      port: options.browserPort,
    }
  }

  if (options.includeStream) {
    const streamCfg: Record<string, unknown> = {
      ...(options.streamConfig ?? {}),
    }
    if (streamCfg.port == null) {
      streamCfg.port = options.streamPort
    }
    engineWorkers['iii-stream'] = streamCfg
  }

  if (options.engineWorkerOverrides) {
    for (const [workerName, workerOverride] of Object.entries(options.engineWorkerOverrides)) {
      if (!workerOverride) continue
      const current = engineWorkers[workerName]
      engineWorkers[workerName] = isObjectRecord(current)
        ? deepMergeRecord(current, workerOverride)
        : workerOverride
    }
  }

  const containers: Record<string, Record<string, unknown>> = {
    ...defaultServiceContainers,
    [workflowContainer.containerName]: workflowContainer.entry as Record<string, unknown>,
  }

  if (consoleContainer) {
    containers[consoleContainer.containerName] = consoleContainer.entry as Record<string, unknown>
  }

  const composeDoc = {
    namespace: projectNamespace,
    startup_timeout: options.startupTimeout ?? '60s',
    stop_timeout: options.stopTimeout ?? '10s',
    engine: {
      url: options.engineUrl,
      workers: engineWorkers,
    },
    containers,
  }

  const metadataHeader = [
    '# Auto-generated by nvent - do not edit manually',
    `# generator: nvent@${options.nventVersion}`,
    '# schemaVersion: 1',
    `# iiiMinVersion: ${options.iiiVersion}`,
    `# composeDaemonNamespace: ${daemonNamespace}`,
    '',
  ].join('\n')

  return `${metadataHeader}${stringifyYAML(composeDoc)}`
}
