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
        | { type: 'kv'; storeMethod?: 'file_based' | 'in_memory'; filePath?: string; saveIntervalMs?: number }
        | { type: 'redis'; redisUrl?: string }
        | { type: 'bridge'; bridgeUrl: string }
    }
    /**
     * Queue module configuration.
     * Named queues must be declared here for the iii engine to route messages through them.
     */
    queue?: {
      adapter?:
        | {
            type: 'builtin'
            storeMethod?: 'file_based' | 'in_memory'
            filePath?: string
            saveIntervalMs?: number
            maxAttempts?: number
            backoffMs?: number
            concurrency?: number
            pollIntervalMs?: number
            /** Processing order. 'concurrent' (parallel) or 'fifo' (sequential). Default: 'concurrent' */
            mode?: 'concurrent' | 'fifo'
          }
        | { type: 'redis'; redisUrl?: string }
        | {
            type: 'rabbitmq'
            amqpUrl?: string
            maxAttempts?: number
            prefetchCount?: number
            /** 'standard' or 'quorum' (HA replicated). Default: 'standard' */
            queueMode?: 'standard' | 'quorum'
          }
        | { type: 'bridge'; bridgeUrl: string }
      queueConfigs?: Record<string, {
        type?: 'standard' | 'fifo'
        concurrency?: number
        /** Alias of maxRetries */
        retries?: number
        maxRetries?: number
        /** Alias of backoffMs */
        backoff?: number
        backoffMs?: number
        /** Optional visibility timeout / lease timeout if supported by the engine */
        visibilityTimeoutMs?: number
        leaseTimeoutMs?: number
        /** Optional dead-letter / fallback queue names if supported by the engine */
        deadLetterQueue?: string
        fallbackQueue?: string
        /** FIFO only: field in the payload used to group messages */
        messageGroupField?: string
      }>
    }
    /** Cron module adapter configuration */
    cron?: {
      adapter?:
        | { type: 'kv'; lockTtlMs?: number; lockIndex?: string; storeMethod?: 'file_based' | 'in_memory'; filePath?: string; saveIntervalMs?: number }
        | { type: 'redis'; redisUrl?: string }
    }
    /** WebSocket Stream module configuration */
    stream?: {
      host?: string
      authFunction?: string | null
      adapter?:
        | { type: 'kv'; storeMethod?: 'file_based' | 'in_memory'; filePath?: string; saveIntervalMs?: number }
        | { type: 'redis'; redisUrl?: string }
        | { type: 'bridge'; bridgeUrl: string }
    }
    /** REST API module extra settings */
    restApi?: {
      host?: string
      defaultTimeout?: number
      concurrencyRequestLimit?: number
      /** CORS configuration for browser clients */
      cors?: {
        /** Origins allowed to make requests. Use '*' for any, or list specific domains. */
        allowedOrigins?: string[]
        /** HTTP methods permitted for cross-origin requests. */
        allowedMethods?: string[]
      }
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
      /** Advanced sampling rules — override samplingRatio for matched operations. */
      sampling?: {
        default?: number
        parentBased?: boolean
        rules?: Array<{ operation?: string; service?: string; rate: number }>
        rateLimit?: { maxTracesPerSecond?: number }
      }
      /** Alert rules — trigger a webhook or function when a metric crosses a threshold. */
      alerts?: Array<{
        name: string
        metric: string
        threshold: number
        operator: '>' | '>=' | '<' | '<=' | '==' | '!='
        windowSeconds: number
        enabled?: boolean
        cooldownSeconds?: number
        action: { type: 'webhook'; url: string } | { type: 'function'; path: string }
      }>
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
    /** PubSub worker — topic-based event fanout across functions. */
    pubsub?: {
      adapter?:
        | { type: 'local' }
        | { type: 'redis'; redisUrl?: string }
    }
    /**
     * HTTP Functions worker — enables outbound HTTP calls from the engine.
     * Required for functions registered with HttpInvocationConfig.
     */
    httpFunctions?: {
      security?: {
        /** URL patterns allowed for outbound requests. Use '*' to allow all. */
        urlAllowlist?: string[]
        /** Block requests to private/internal IP ranges (SSRF prevention). Default: true */
        blockPrivateIps?: boolean
        /** Require HTTPS for all outbound requests. Default: true */
        requireHttps?: boolean
      }
    }
    /**
     * Additional iii-worker-manager instance with RBAC.
     * nvent uses this automatically when browser SDK is enabled.
     * Can also be configured manually for custom auth scenarios.
     */
    workerManager?: {
      rbac?: {
        /** Port for the RBAC worker manager. Default: 49135 */
        port?: number
        /** Function ID called on every WebSocket upgrade for auth. */
        authFunctionId?: string
        /** Functions the connecting worker is allowed to invoke (patterns supported). */
        exposeFunctions?: string[]
        /** Function invoked before each handler — enrich or audit requests. */
        middlewareFunctionId?: string
        /** Allow workers to register their own function handlers. Default: true */
        allowFunctionRegistration?: boolean
        /** Allow workers to register new trigger types. Default: false */
        allowTriggerTypeRegistration?: boolean
        /** Prefix prepended to every function the worker registers. */
        functionRegistrationPrefix?: string
        /** TTL for signed browser auth tokens generated by the Nuxt proxy. Default: 120 */
        tokenTtlSeconds?: number
        /** Allow browser connections without a custom resolver returning user context. Default: true */
        allowAnonymous?: boolean
        /** Optional path (relative to project root) to a custom browser auth resolver module. */
        authResolverPath?: string
      }
    }
    /**
     * Bridge client workers — connects this engine to remote iii instances.
     * Each entry creates an `iii-bridge` worker in the config.
     */
    bridge?: Array<{
      url: string
      serviceId: string
      serviceName?: string
      expose?: Array<{ localFunction: string; remoteFunction?: string }>
      forward?: Array<{ localFunction: string; remoteFunction: string; timeoutMs?: number }>
    }>
    /**
     * Exec workers — spawns external processes alongside the engine.
     * Each entry creates an `iii-exec` worker in the config.
     */
    exec?: Array<{
      watch?: string[]
      exec: string[]
    }>
    /** Anonymous usage telemetry. Set enabled: false to opt out. */
    telemetry?: {
      enabled?: boolean
      apiKey?: string
      sdkApiKey?: string
      heartbeatIntervalSecs?: number
    }
  }
  functions?: {
    /** Directory under server/ where functions are, relative to serverDir (default: 'functions') */
    dir?: string
    /**
     * Function ID prefix for this layer's functions.
     * Set in a layer's `nuxt.config.ts` to namespace its functions.
     * Priority: this value → `$meta.name` → package.json name → directory name.
     * Set to `''` (empty string) to explicitly opt out of any prefix.
     * Has no effect in the root project (always un-prefixed).
     * Example: 'myorg::auth'
     */
    prefix?: string
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
  app?: {
    /** Enable the nvent app UI and its built-in route. Default: true */
    enabled?: boolean
    /** Route path for the nvent app. Default: '/_nvent' */
    routePath?: string
    /**
     * Layout to use for the nvent app route.
     * Set to false for no layout, or a string to use a named layout.
     * Default: false
     */
    layout?: string | false
  }
}