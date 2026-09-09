export interface ComposeEngineWorkerOverrides {
  configuration?: Record<string, unknown>
  'iii-worker-manager'?: Record<string, unknown>
  'iii-worker-manager#rbac'?: Record<string, unknown>
  'iii-http-functions'?: Record<string, unknown>
  'iii-stream'?: Record<string, unknown>
  'iii-sandbox'?: Record<string, unknown>
}

export interface ResolvedComposeEngineAdvanced {
  startupTimeout?: string
  stopTimeout?: string
  workers?: ComposeEngineWorkerOverrides
}

const ALLOWED_ENGINE_KEYS = new Set(['startupTimeout', 'stopTimeout', 'workers'])
const ALLOWED_WORKER_KEYS = new Set([
  'configuration',
  'iii-worker-manager',
  'iii-worker-manager#rbac',
  'iii-http-functions',
  'iii-stream',
  'iii-sandbox',
])

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function assertAllowedKeys(input: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`[nvent] Unsupported ${path} field '${key}'. Allowed fields: ${Array.from(allowed).sort().join(', ')}`)
    }
  }
}

function normalizeTimeout(value: unknown, fieldPath: string): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`[nvent] ${fieldPath} must be a string (for example '60s').`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`[nvent] ${fieldPath} must not be empty.`)
  }

  return trimmed
}

function normalizeWorkers(value: unknown): ComposeEngineWorkerOverrides | undefined {
  if (value == null) return undefined
  if (!isObjectRecord(value)) {
    throw new Error('[nvent] nvent.iii.compose.engine.workers must be an object.')
  }

  assertAllowedKeys(value, ALLOWED_WORKER_KEYS, 'nvent.iii.compose.engine.workers')

  const normalized: ComposeEngineWorkerOverrides = {}
  for (const [workerName, workerConfig] of Object.entries(value)) {
    if (workerConfig == null) continue
    if (!isObjectRecord(workerConfig)) {
      throw new Error(`[nvent] nvent.iii.compose.engine.workers.${workerName} must be an object.`)
    }
    ;(normalized as Record<string, unknown>)[workerName] = workerConfig
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function resolveComposeEngineAdvanced(input: unknown): ResolvedComposeEngineAdvanced {
  if (input == null) {
    return {}
  }

  if (!isObjectRecord(input)) {
    throw new Error('[nvent] nvent.iii.compose.engine must be an object when provided.')
  }

  assertAllowedKeys(input, ALLOWED_ENGINE_KEYS, 'nvent.iii.compose.engine')

  return {
    startupTimeout: normalizeTimeout(input.startupTimeout, 'nvent.iii.compose.engine.startupTimeout'),
    stopTimeout: normalizeTimeout(input.stopTimeout, 'nvent.iii.compose.engine.stopTimeout'),
    workers: normalizeWorkers(input.workers),
  }
}
