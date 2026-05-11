/**
 * iii Engine Config Generator
 *
 * Generates the iii-config.yaml that the engine process reads at startup.
 * Maps nvent module options to the iii engine config format.
 *
 * Reference: https://iii.dev/docs/how-to/configure-engine
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { stringifyYAML } from 'confbox'
import type { NventIiiOptions } from './options'

// ---------------------------------------------------------------------------
// Adapter configs
// ---------------------------------------------------------------------------

export interface KvStoreAdapterConfig {
  /** 'file_based' persists to disk, 'in_memory' is ephemeral. Default: 'file_based' */
  store_method?: 'file_based' | 'in_memory'
  /** Path for file_based storage. Default: './.data/<module>_store' */
  file_path?: string
  /** How often (ms) to flush dirty data to disk. Default: 5000 */
  save_interval_ms?: number
}

export interface RedisAdapterConfig {
  /** Redis connection URL. Falls back to REDIS_URL env var. */
  redis_url?: string
}

export interface RabbitMQAdapterConfig {
  /** AMQP connection URL. Falls back to AMQP_URL env var. */
  amqp_url?: string
  max_attempts?: number
  prefetch_count?: number
  /** 'standard' or 'quorum' (HA replicated). Default: 'standard' */
  queue_mode?: 'standard' | 'quorum'
}

export interface BridgeAdapterConfig {
  /** WebSocket URL of another iii engine instance. */
  bridge_url: string
}

export interface BuiltinQueueAdapterConfig extends KvStoreAdapterConfig {
  max_attempts?: number
  backoff_ms?: number
  concurrency?: number
  poll_interval_ms?: number
  /** 'concurrent' (parallel) or 'fifo' (sequential). Default: 'concurrent' */
  mode?: 'concurrent' | 'fifo'
}

export interface CronKvAdapterConfig extends KvStoreAdapterConfig {
  lock_ttl_ms?: number
  lock_index?: string
}

// ---------------------------------------------------------------------------
// Named queue config
// ---------------------------------------------------------------------------

export interface NamedQueueConfig {
  type?: 'standard' | 'fifo'
  concurrency?: number
  max_retries?: number
  backoff_ms?: number
  visibility_timeout_ms?: number
  lease_timeout_ms?: number
  dead_letter_queue?: string
  fallback_queue?: string
  /** FIFO only: field in the payload used to group messages */
  message_group_field?: string
}

// ---------------------------------------------------------------------------
// Module-level adapter discriminated unions
// ---------------------------------------------------------------------------

export type StateAdapter =
  | { name: 'kv'; config?: KvStoreAdapterConfig }
  | { name: 'redis'; config: RedisAdapterConfig }
  | { name: 'bridge'; config: BridgeAdapterConfig }

export type QueueAdapter =
  | { name: 'builtin'; config?: BuiltinQueueAdapterConfig }
  | { name: 'redis'; config: RedisAdapterConfig }
  | { name: 'rabbitmq'; config: RabbitMQAdapterConfig }
  | { name: 'bridge'; config: BridgeAdapterConfig }

export type CronAdapter =
  | { name: 'kv'; config?: CronKvAdapterConfig }
  | { name: 'redis'; config: RedisAdapterConfig }

export type StreamAdapter =
  | { name: 'kv'; config?: KvStoreAdapterConfig }
  | { name: 'redis'; config: RedisAdapterConfig }
  | { name: 'bridge'; config: BridgeAdapterConfig }

export type PubSubAdapter =
  | { name: 'local' }
  | { name: 'redis'; config: RedisAdapterConfig }

// ---------------------------------------------------------------------------
// Module configs
// ---------------------------------------------------------------------------

export interface RestApiModuleConfig {
  port?: number
  /** Network interface to bind. Default: '0.0.0.0' */
  host?: string
  default_timeout?: number
  concurrency_request_limit?: number
  cors?: { allowed_origins?: string[]; allowed_methods?: string[] }
}

export interface StateModuleConfig {
  adapter?: StateAdapter
}

export interface QueueModuleConfig {
  adapter?: QueueAdapter
  queue_configs?: Record<string, NamedQueueConfig>
}

export interface CronModuleConfig {
  adapter?: CronAdapter
}

export interface StreamModuleConfig {
  port?: number
  host?: string
  auth_function?: string | null
  adapter?: StreamAdapter
}

export interface OtelModuleConfig {
  /** Master switch for all observability. Default: true */
  enabled?: boolean
  service_name?: string
  service_version?: string
  service_namespace?: string
  /**
   * Trace export destination.
   * - 'memory': queryable via iii API (used by the iii console)
   * - 'otlp': send to external collector
   * - 'both': memory + otlp
   * Default: 'memory'
   */
  exporter?: 'memory' | 'otlp' | 'both'
  /** OTLP collector endpoint. Required when exporter is 'otlp' or 'both'. */
  endpoint?: string
  sampling_ratio?: number
  memory_max_spans?: number
  metrics_enabled?: boolean
  /** Default: 'memory' */
  metrics_exporter?: 'memory' | 'otlp'
  metrics_retention_seconds?: number
  metrics_max_count?: number
  logs_enabled?: boolean
  /** Default: 'both' */
  logs_exporter?: 'memory' | 'otlp' | 'both'
  logs_max_count?: number
  logs_retention_seconds?: number
  logs_batch_size?: number
  logs_flush_interval_ms?: number
  logs_sampling_ratio?: number
  logs_console_output?: boolean
  /** Advanced sampling rules — override sampling_ratio for matched operations. */
  sampling?: {
    default?: number
    parent_based?: boolean
    rules?: Array<{ operation?: string; service?: string; rate: number }>
    rate_limit?: { max_traces_per_second?: number }
  }
  /** Alert rules triggered when metrics cross thresholds. */
  alerts?: Array<{
    name: string
    metric: string
    threshold: number
    operator: '>' | '>=' | '<' | '<=' | '==' | '!='
    window_seconds: number
    enabled?: boolean
    cooldown_seconds?: number
    action: { type: 'webhook'; url: string } | { type: 'function'; path: string }
  }>
  /** Engine console log level */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  /** Console output format */
  format?: 'default' | 'json'
}

export interface PubSubModuleConfig {
  adapter?: PubSubAdapter
}

export interface HttpFunctionsModuleConfig {
  security?: {
    url_allowlist?: string[]
    block_private_ips?: boolean
    require_https?: boolean
  }
}

export interface WorkerManagerRbacConfig {
  auth_function_id?: string
  expose_functions?: string[]
  middleware_function_id?: string
  allow_function_registration?: boolean
  allow_trigger_type_registration?: boolean
  function_registration_prefix?: string
}

export interface WorkerManagerModuleConfig {
  port: number
  rbac?: WorkerManagerRbacConfig
}

export interface BridgeClientConfig {
  url: string
  service_id: string
  service_name?: string
  expose?: Array<{ local_function: string; remote_function?: string }>
  forward?: Array<{ local_function: string; remote_function: string; timeout_ms?: number }>
}

export interface ExecModuleConfig {
  watch?: string[]
  exec: string[]
}

export interface TelemetryModuleConfig {
  enabled?: boolean
  api_key?: string
  sdk_api_key?: string
  heartbeat_interval_secs?: number
}

// ---------------------------------------------------------------------------
// Top-level engine config
// ---------------------------------------------------------------------------

export interface IiiEngineConfig {
  /** WebSocket port for workers (default: 49134) */
  wsPort: number
  /** HTTP API port for registered endpoints (default: 3111) */
  httpPort: number
  /** WebSocket port for the Stream module (default: 3112) */
  streamPort: number
  /** Enable/disable optional modules */
  modules: {
    state?: boolean
    queue?: boolean
    cron?: boolean
    observability?: boolean
    stream?: boolean
    pubsub?: boolean
    httpFunctions?: boolean
    exec?: boolean
    telemetry?: boolean
  }
  /** Per-module detailed configuration */
  restApi?: RestApiModuleConfig
  state?: StateModuleConfig
  queue?: QueueModuleConfig
  cron?: CronModuleConfig
  stream?: StreamModuleConfig
  observability?: OtelModuleConfig
  pubsub?: PubSubModuleConfig
  httpFunctions?: HttpFunctionsModuleConfig
  /** Additional worker-manager with RBAC (for browser workers) */
  workerManagerRbac?: WorkerManagerModuleConfig
  /** Bridge client workers (iii-bridge entries) */
  bridge?: BridgeClientConfig[]
  /** Exec workers (iii-exec entries) */
  exec?: ExecModuleConfig[]
  /** Telemetry config */
  telemetry?: TelemetryModuleConfig
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export function defaultIiiEngineConfig(): IiiEngineConfig {
  return {
    wsPort: 49134,
    httpPort: 3111,
    streamPort: 3112,
    modules: {
      state: true,
      queue: true,
      cron: true,
      observability: true,
      stream: true,
    },
  }
}

// ---------------------------------------------------------------------------
// Default adapter factories — always use built-in / internal storage
// ---------------------------------------------------------------------------

function defaultStateAdapter(stateDir?: string): StateAdapter {
  return {
    name: 'kv',
    config: { store_method: 'file_based', file_path: stateDir ?? './.data/state_store' },
  }
}

function defaultQueueAdapter(queueDir?: string): QueueAdapter {
  return {
    name: 'builtin',
    config: { store_method: 'file_based', file_path: queueDir ?? './.data/queue_store' },
  }
}

function defaultCronAdapter(): CronAdapter {
  return {
    name: 'kv',
    config: { store_method: 'file_based', file_path: './.data/cron_store' },
  }
}

function defaultStreamAdapter(): StreamAdapter {
  return {
    name: 'kv',
    config: { store_method: 'file_based', file_path: './.data/stream_store' },
  }
}

// ---------------------------------------------------------------------------
// YAML generator
// ---------------------------------------------------------------------------

export function generateIiiConfigYaml(cfg: IiiEngineConfig): string {
  const workers: object[] = []

  // iii-worker-manager — sets the WebSocket port for SDK workers to connect
  workers.push({ name: 'iii-worker-manager', config: { port: cfg.wsPort } })

  // iii-http — always present
  const restApiConfig: Record<string, unknown> = {
    port: cfg.restApi?.port ?? cfg.httpPort,
  }
  if (cfg.restApi?.host) restApiConfig.host = cfg.restApi.host
  if (cfg.restApi?.default_timeout != null) restApiConfig.default_timeout = cfg.restApi.default_timeout
  if (cfg.restApi?.concurrency_request_limit != null) restApiConfig.concurrency_request_limit = cfg.restApi.concurrency_request_limit
  if (cfg.restApi?.cors) restApiConfig.cors = cfg.restApi.cors
  workers.push({ name: 'iii-http', config: restApiConfig })

  // iii-state
  if (cfg.modules.state !== false) {
    const adapter = cfg.state?.adapter ?? defaultStateAdapter()
    workers.push({ name: 'iii-state', config: { adapter } })
  }

  // iii-queue
  if (cfg.modules.queue !== false) {
    const adapter = cfg.queue?.adapter ?? defaultQueueAdapter()
    const queueModCfg: Record<string, unknown> = { adapter }
    const queueConfigs = cfg.queue?.queue_configs
    if (queueConfigs && Object.keys(queueConfigs).length > 0) {
      queueModCfg.queue_configs = queueConfigs
    }
    workers.push({ name: 'iii-queue', config: queueModCfg })
  }

  // iii-cron
  if (cfg.modules.cron !== false) {
    const adapter = cfg.cron?.adapter ?? defaultCronAdapter()
    workers.push({ name: 'iii-cron', config: { adapter } })
  }

  // iii-stream
  if (cfg.modules.stream !== false) {
    const streamCfg: Record<string, unknown> = {
      port: cfg.stream?.port ?? cfg.streamPort,
    }
    if (cfg.stream?.host) streamCfg.host = cfg.stream.host
    if (cfg.stream?.auth_function !== undefined) streamCfg.auth_function = cfg.stream.auth_function
    const streamAdapter = cfg.stream?.adapter ?? defaultStreamAdapter()
    streamCfg.adapter = streamAdapter
    workers.push({ name: 'iii-stream', config: streamCfg })
  }

  // OtelModule
  if (cfg.modules.observability !== false) {
    const oCfg = cfg.observability ?? {}
    const otelConfig: Record<string, unknown> = {
      enabled: oCfg.enabled ?? true,
      service_name: oCfg.service_name ?? 'nvent',
      exporter: oCfg.exporter ?? 'memory',
    }
    if (oCfg.service_version) otelConfig.service_version = oCfg.service_version
    if (oCfg.service_namespace) otelConfig.service_namespace = oCfg.service_namespace
    if (oCfg.endpoint) otelConfig.endpoint = oCfg.endpoint
    if (oCfg.sampling_ratio != null) otelConfig.sampling_ratio = oCfg.sampling_ratio
    if (oCfg.memory_max_spans != null) otelConfig.memory_max_spans = oCfg.memory_max_spans
    // Metrics
    if (oCfg.metrics_enabled != null) otelConfig.metrics_enabled = oCfg.metrics_enabled
    if (oCfg.metrics_exporter) otelConfig.metrics_exporter = oCfg.metrics_exporter
    if (oCfg.metrics_retention_seconds != null) otelConfig.metrics_retention_seconds = oCfg.metrics_retention_seconds
    if (oCfg.metrics_max_count != null) otelConfig.metrics_max_count = oCfg.metrics_max_count
    // Logs
    if (oCfg.logs_enabled != null) otelConfig.logs_enabled = oCfg.logs_enabled
    if (oCfg.logs_exporter) otelConfig.logs_exporter = oCfg.logs_exporter
    if (oCfg.logs_max_count != null) otelConfig.logs_max_count = oCfg.logs_max_count
    if (oCfg.logs_retention_seconds != null) otelConfig.logs_retention_seconds = oCfg.logs_retention_seconds
    if (oCfg.logs_batch_size != null) otelConfig.logs_batch_size = oCfg.logs_batch_size
    if (oCfg.logs_flush_interval_ms != null) otelConfig.logs_flush_interval_ms = oCfg.logs_flush_interval_ms
    if (oCfg.logs_sampling_ratio != null) otelConfig.logs_sampling_ratio = oCfg.logs_sampling_ratio
    if (oCfg.logs_console_output != null) otelConfig.logs_console_output = oCfg.logs_console_output
    if (oCfg.level) otelConfig.level = oCfg.level
    if (oCfg.format) otelConfig.format = oCfg.format
    if (oCfg.sampling) otelConfig.sampling = oCfg.sampling
    if (oCfg.alerts?.length) otelConfig.alerts = oCfg.alerts
    workers.push({ name: 'iii-observability', config: otelConfig })
  }

  // iii-pubsub
  if (cfg.modules.pubsub) {
    const pubsubCfg: Record<string, unknown> = {}
    if (cfg.pubsub?.adapter) pubsubCfg.adapter = cfg.pubsub.adapter
    workers.push({ name: 'iii-pubsub', config: Object.keys(pubsubCfg).length ? pubsubCfg : undefined })
  }

  // iii-http-functions
  if (cfg.modules.httpFunctions) {
    const hfCfg: Record<string, unknown> = {}
    if (cfg.httpFunctions?.security) hfCfg.security = cfg.httpFunctions.security
    workers.push({ name: 'iii-http-functions', config: Object.keys(hfCfg).length ? hfCfg : undefined })
  }

  // iii-bridge (one entry per configured bridge)
  for (const bridgeCfg of cfg.bridge ?? []) {
    workers.push({ name: 'iii-bridge', config: bridgeCfg })
  }

  // iii-exec (one entry per configured exec worker)
  for (const execCfg of cfg.exec ?? []) {
    workers.push({ name: 'iii-exec', config: execCfg })
  }

  // Second iii-worker-manager for RBAC (browser workers)
  if (cfg.workerManagerRbac) {
    workers.push({ name: 'iii-worker-manager', config: cfg.workerManagerRbac })
  }

  // iii-telemetry
  if (cfg.telemetry) {
    workers.push({ name: 'iii-telemetry', config: cfg.telemetry })
  }

  return `# Auto-generated by nvent — do not edit manually\n` + stringifyYAML({ workers })
}

/**
 * Writes the iii-config.yaml to the given path.
 */
export function writeIiiConfig(outputPath: string, cfg: IiiEngineConfig): void {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, generateIiiConfigYaml(cfg), 'utf-8')
}

// ---------------------------------------------------------------------------
// Module options → engine config (camelCase → snake_case)
// ---------------------------------------------------------------------------

type UserQueueConfigs = NonNullable<NonNullable<NonNullable<NventIiiOptions['iii']>['queue']>['queueConfigs']>

export function buildEngineConfig(
  iiiOpts: NonNullable<NventIiiOptions['iii']>,
  queueConfigsOverride?: UserQueueConfigs,
): IiiEngineConfig {
  const queueConfigs = queueConfigsOverride ?? iiiOpts.queue?.queueConfigs
  const hasQueueConfigs = queueConfigs != null && Object.keys(queueConfigs).length > 0

  return {
    ...defaultIiiEngineConfig(),
    wsPort: iiiOpts.wsPort ?? 49134,
    httpPort: iiiOpts.httpPort ?? 3111,
    streamPort: iiiOpts.streamPort ?? 3112,
    modules: { state: true, queue: true, cron: true, observability: true, stream: true, pubsub: false, httpFunctions: false, exec: false, telemetry: false, ...iiiOpts.modules },
    state: iiiOpts.state ? { adapter: mapStateAdapter(iiiOpts.state) } : undefined,
    queue: (iiiOpts.queue || hasQueueConfigs) ? {
      adapter: mapQueueAdapter(iiiOpts.queue?.adapter),
      queue_configs: hasQueueConfigs
        ? Object.fromEntries(
            Object.entries(queueConfigs!).map(([name, cfg]) => [
              name,
              {
                type: cfg.type,
                concurrency: cfg.concurrency,
                max_retries: cfg.maxRetries ?? cfg.retries,
                backoff_ms: cfg.backoffMs ?? cfg.backoff,
                visibility_timeout_ms: cfg.visibilityTimeoutMs,
                lease_timeout_ms: cfg.leaseTimeoutMs,
                dead_letter_queue: cfg.deadLetterQueue,
                fallback_queue: cfg.fallbackQueue,
                message_group_field: cfg.messageGroupField,
              },
            ]),
          )
        : undefined,
    } : undefined,
    cron: iiiOpts.cron ? { adapter: mapCronAdapter(iiiOpts.cron) } : undefined,
    stream: iiiOpts.stream ? {
      host: iiiOpts.stream.host,
      auth_function: iiiOpts.stream.authFunction,
      adapter: mapStreamAdapter(iiiOpts.stream),
    } : undefined,
    restApi: iiiOpts.restApi ? {
      host: iiiOpts.restApi.host,
      default_timeout: iiiOpts.restApi.defaultTimeout,
      concurrency_request_limit: iiiOpts.restApi.concurrencyRequestLimit,
      cors: iiiOpts.restApi.cors ? {
        allowed_origins: iiiOpts.restApi.cors.allowedOrigins,
        allowed_methods: iiiOpts.restApi.cors.allowedMethods,
      } : undefined,
    } : undefined,
    pubsub: iiiOpts.pubsub ? { adapter: mapPubSubAdapter(iiiOpts.pubsub) } : undefined,
    httpFunctions: iiiOpts.httpFunctions ? {
      security: iiiOpts.httpFunctions.security ? {
        url_allowlist: iiiOpts.httpFunctions.security.urlAllowlist,
        block_private_ips: iiiOpts.httpFunctions.security.blockPrivateIps,
        require_https: iiiOpts.httpFunctions.security.requireHttps,
      } : undefined,
    } : undefined,
    workerManagerRbac: iiiOpts.workerManager?.rbac ? {
      port: iiiOpts.workerManager.rbac.port ?? 49135,
      rbac: {
        auth_function_id: iiiOpts.workerManager.rbac.authFunctionId ?? 'nvent::browser::auth',
        expose_functions: iiiOpts.workerManager.rbac.exposeFunctions,
        middleware_function_id: iiiOpts.workerManager.rbac.middlewareFunctionId,
        allow_function_registration: iiiOpts.workerManager.rbac.allowFunctionRegistration,
        allow_trigger_type_registration: iiiOpts.workerManager.rbac.allowTriggerTypeRegistration,
        function_registration_prefix: iiiOpts.workerManager.rbac.functionRegistrationPrefix,
      },
    } : undefined,
    bridge: iiiOpts.bridge?.map(b => ({
      url: b.url,
      service_id: b.serviceId,
      service_name: b.serviceName,
      expose: b.expose?.map(e => ({ local_function: e.localFunction, remote_function: e.remoteFunction })),
      forward: b.forward?.map(f => ({ local_function: f.localFunction, remote_function: f.remoteFunction, timeout_ms: f.timeoutMs })),
    })),
    exec: iiiOpts.exec?.map(e => ({ watch: e.watch, exec: e.exec })),
    telemetry: iiiOpts.telemetry ? {
      enabled: iiiOpts.telemetry.enabled,
      api_key: iiiOpts.telemetry.apiKey,
      sdk_api_key: iiiOpts.telemetry.sdkApiKey,
      heartbeat_interval_secs: iiiOpts.telemetry.heartbeatIntervalSecs,
    } : undefined,
    observability: iiiOpts.observability ? {
      enabled: iiiOpts.observability.enabled,
      service_name: iiiOpts.observability.serviceName,
      service_version: iiiOpts.observability.serviceVersion,
      service_namespace: iiiOpts.observability.serviceNamespace,
      exporter: iiiOpts.observability.exporter,
      endpoint: iiiOpts.observability.endpoint,
      sampling_ratio: iiiOpts.observability.samplingRatio,
      memory_max_spans: iiiOpts.observability.memoryMaxSpans,
      metrics_enabled: iiiOpts.observability.metricsEnabled,
      metrics_exporter: iiiOpts.observability.metricsExporter,
      metrics_retention_seconds: iiiOpts.observability.metricsRetentionSeconds,
      metrics_max_count: iiiOpts.observability.metricsMaxCount,
      logs_enabled: iiiOpts.observability.logsEnabled,
      logs_exporter: iiiOpts.observability.logsExporter,
      logs_max_count: iiiOpts.observability.logsMaxCount,
      logs_retention_seconds: iiiOpts.observability.logsRetentionSeconds,
      logs_batch_size: iiiOpts.observability.logsBatchSize,
      logs_flush_interval_ms: iiiOpts.observability.logsFlushIntervalMs,
      logs_sampling_ratio: iiiOpts.observability.logsSamplingRatio,
      logs_console_output: iiiOpts.observability.logsConsoleOutput,
      sampling: iiiOpts.observability.sampling ? {
        default: iiiOpts.observability.sampling.default,
        parent_based: iiiOpts.observability.sampling.parentBased,
        rules: iiiOpts.observability.sampling.rules,
        rate_limit: iiiOpts.observability.sampling.rateLimit ? {
          max_traces_per_second: iiiOpts.observability.sampling.rateLimit.maxTracesPerSecond,
        } : undefined,
      } : undefined,
      alerts: iiiOpts.observability.alerts?.map(a => ({
        name: a.name,
        metric: a.metric,
        threshold: a.threshold,
        operator: a.operator,
        window_seconds: a.windowSeconds,
        enabled: a.enabled,
        cooldown_seconds: a.cooldownSeconds,
        action: a.action,
      })),
      level: iiiOpts.observability.level,
      format: iiiOpts.observability.format,
    } : undefined,
  }
}

function mapStateAdapter(a: NonNullable<NventIiiOptions['iii']>['state']): StateAdapter | undefined {
  if (!a?.adapter) return undefined
  if (a.adapter.type === 'redis') return { name: 'redis', config: { redis_url: a.adapter.redisUrl } }
  if (a.adapter.type === 'bridge') return { name: 'bridge', config: { bridge_url: a.adapter.bridgeUrl } }
  return {
    name: 'kv',
    config: { store_method: a.adapter.storeMethod, file_path: a.adapter.filePath, save_interval_ms: a.adapter.saveIntervalMs },
  }
}

function mapQueueAdapter(a?: NonNullable<NonNullable<NventIiiOptions['iii']>['queue']>['adapter']): QueueAdapter | undefined {
  if (!a) return undefined
  if (a.type === 'redis') return { name: 'redis', config: { redis_url: a.redisUrl } }
  if (a.type === 'rabbitmq') return { name: 'rabbitmq', config: { amqp_url: a.amqpUrl, max_attempts: a.maxAttempts, prefetch_count: a.prefetchCount, queue_mode: a.queueMode } }
  if (a.type === 'bridge') return { name: 'bridge', config: { bridge_url: a.bridgeUrl } }
  return {
    name: 'builtin',
    config: {
      store_method: a.storeMethod,
      file_path: a.filePath,
      save_interval_ms: a.saveIntervalMs,
      max_attempts: a.maxAttempts,
      backoff_ms: a.backoffMs,
      concurrency: a.concurrency,
      poll_interval_ms: a.pollIntervalMs,
      mode: a.mode,
    },
  }
}

function mapCronAdapter(a: NonNullable<NventIiiOptions['iii']>['cron']): CronAdapter | undefined {
  if (!a?.adapter) return undefined
  if (a.adapter.type === 'redis') return { name: 'redis', config: { redis_url: a.adapter.redisUrl } }
  return {
    name: 'kv',
    config: {
      lock_ttl_ms: a.adapter.lockTtlMs,
      lock_index: a.adapter.lockIndex,
      store_method: a.adapter.storeMethod,
      file_path: a.adapter.filePath,
      save_interval_ms: a.adapter.saveIntervalMs,
    },
  }
}

function mapStreamAdapter(a: NonNullable<NventIiiOptions['iii']>['stream']): StreamAdapter | undefined {
  if (!a?.adapter) return undefined
  if (a.adapter.type === 'redis') return { name: 'redis', config: { redis_url: a.adapter.redisUrl } }
  if (a.adapter.type === 'bridge') return { name: 'bridge', config: { bridge_url: a.adapter.bridgeUrl } }
  return {
    name: 'kv',
    config: { store_method: a.adapter.storeMethod, file_path: a.adapter.filePath, save_interval_ms: a.adapter.saveIntervalMs },
  }
}

function mapPubSubAdapter(a: NonNullable<NventIiiOptions['iii']>['pubsub']): PubSubAdapter | undefined {
  if (!a?.adapter) return undefined
  if (a.adapter.type === 'redis') return { name: 'redis', config: { redis_url: a.adapter.redisUrl } }
  return { name: 'local' }
}
