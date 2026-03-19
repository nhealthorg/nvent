/**
 * nvent module options
 *
 * Public API types for the nvent Nuxt module. Kept in a separate file so that
 * `iii/config.ts` can import them without creating a circular dependency with
 * `module.ts`.
 */

export interface NventIiiOptions {
  iii?: {
    /** Version of the iii engine to install. Default: 'latest' */
    version?: string
    /** 'local' uses a local binary, 'docker' uses Docker, 'remote' skips lifecycle management */
    mode?: 'local' | 'docker' | 'remote'
    /** WebSocket URL for workers to connect to (default: ws://localhost:49134) */
    wsUrl?: string
    /** HTTP port for iii REST API (default: 3111) */
    httpPort?: number
    /** HTTP host for iii REST API (default: 'localhost') */
    httpHost?: string
    /** WebSocket port for workers (default: 49134) */
    wsPort?: number
    /** WebSocket port for the Stream module (default: 3112) */
    streamPort?: number
    /** Whether nvent manages engine lifecycle. Default: true in dev, false in prod */
    managed?: boolean
    modules?: {
      state?: boolean
      queue?: boolean
      cron?: boolean
      observability?: boolean
      stream?: boolean
    }
    /** State module adapter configuration */
    state?: {
      adapter?:
        | { type: 'kv'; storeMethod?: 'file_based' | 'in_memory'; filePath?: string }
        | { type: 'redis'; redisUrl?: string }
    }
    /**
     * Queue module configuration.
     * Named queues must be declared here for the iii engine to route messages through them.
     */
    queue?: {
      adapter?:
        | { type: 'builtin'; storeMethod?: 'file_based' | 'in_memory'; filePath?: string }
        | { type: 'redis'; redisUrl?: string }
        | { type: 'rabbitmq'; amqpUrl?: string }
      queueConfigs?: Record<string, {
        type?: 'standard' | 'fifo'
        concurrency?: number
        maxRetries?: number
        backoffMs?: number
        /** FIFO only: field in the payload used to group messages */
        messageGroupField?: string
      }>
    }
    /** Cron module adapter configuration */
    cron?: {
      adapter?:
        | { type: 'kv' }
        | { type: 'redis'; redisUrl?: string }
    }
    /** WebSocket Stream module configuration */
    stream?: {
      host?: string
      authFunction?: string | null
      adapter?:
        | { type: 'kv'; storeMethod?: 'file_based' | 'in_memory'; filePath?: string }
        | { type: 'redis'; redisUrl?: string }
    }
    /** REST API module extra settings */
    restApi?: {
      host?: string
      defaultTimeout?: number
      concurrencyRequestLimit?: number
    }
    /** OtelModule (observability) configuration */
    observability?: {
      enabled?: boolean
      serviceName?: string
      serviceVersion?: string
      serviceNamespace?: string
      /**
       * Trace export destination.
       * 'memory' = queryable via iii API / console (default).
       * 'otlp'   = external collector (set endpoint too).
       * 'both'   = memory + otlp.
       */
      exporter?: 'memory' | 'otlp' | 'both'
      endpoint?: string
      samplingRatio?: number
      memoryMaxSpans?: number
      metricsEnabled?: boolean
      metricsExporter?: 'memory' | 'otlp'
      metricsRetentionSeconds?: number
      metricsMaxCount?: number
      logsEnabled?: boolean
      logsExporter?: 'memory' | 'otlp' | 'both'
      logsMaxCount?: number
      logsRetentionSeconds?: number
      logsBatchSize?: number
      logsFlushIntervalMs?: number
      logsSamplingRatio?: number
      logsConsoleOutput?: boolean
      level?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
      format?: 'default' | 'json'
    }
    /**
     * Minimum log level for iii engine output.
     * 'none' silences all output, 'error' shows only errors, 'warn' shows warnings + errors,
     * 'info' shows everything. Default: 'warn'
     */
    logLevel?: 'none' | 'error' | 'warn' | 'info'
    /**
     * Enable the iii-console web UI (separate binary, http://localhost:3113).
     * Pass `true` for defaults or an object to customise.
     */
    console?: boolean | {
      /** Version to install. Default: same as iii engine version */
      version?: string
      /** Port for the console web UI. Default: 3113 */
      port?: number
      /** Host for the console web UI. Default: 'localhost' */
      host?: string
      /** Enable the Flow visualization page */
      flow?: boolean
    }
  }
  functions?: {
    /** Directory under server/ where functions are, relative to serverDir (default: 'functions') */
    dir?: string
    python?: {
      /**
       * Path to the Python executable used **in development only** (e.g. a virtualenv).
       * Has no effect in production — set `NVENT_PYTHON_BIN` env var instead.
       * Default: 'python3'
       * Example: '.venv/bin/python3'
       */
      devPath?: string
      /**
       * Skip Python worker support entirely (no Python scanning, no workers started).
       * Useful when the project has no Python functions. Default: false
       */
      skip?: boolean
    }
  }
  console?: {
    /** Enable the nvent API proxy routes (/api/_nvent/...). Default: true */
    enabled?: boolean
    route?: string
  }
}

declare module '@nuxt/schema' {
  interface NuxtConfig {
    nvent?: NventIiiOptions
  }
  interface NuxtOptions {
    nvent?: NventIiiOptions
  }
}
