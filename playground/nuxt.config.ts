export default defineNuxtConfig({
  compatibilityDate: '2026-07-17',

  modules: [
    '@nuxt/ui',
    'nvent',
    '@nvent-addon/app'
  ],

  devtools: {
    enabled: true,
  },

  css: ['~/assets/css/main.css'],

  colorMode: {
    preference: 'light',
  },
  
  vite: {
  },

  nitro: {
    // In pnpm monorepos, transitive deps like `unhead` are not hoisted into
    // the playground's node_modules, so Nitro's dependency tracer fails to
    // copy them to .output/server/node_modules. Inlining them bundles the
    // package directly into the server chunk instead.
    externals: {
      inline: ['unhead'],
    },
  },

  nvent: {
    iii: {
      version: 'iii/v0.24.3',
      failOnInstallFailure: true,
      compose: {
        managed: true,
        logLevel: 'trace',
      },
      ade: true,
      harness: true,
      workers: {
        // Route the built-in llama.cpp provider through the local llama-swap API.
        'llm-router': {
          worker: 'package://api.workers.iii.dev/llm-router',
          config_override: {
            default_provider: 'llamacpp',
            providers: {
              llamacpp: {
                api_url: process.env.LLAMA_SWAP_API_URL || 'http://localhost:9292/upstream/Gemma3-4b/v1/chat/completions',
              },
            },
          },
        },
      },
      containers: {
        'provider-llamacpp': {
          worker: 'package://provider-llamacpp',
          version: '0.3.8',
          start_after: ['llm-router', 'state'],
        },
      },
      logLevel: 'info',
      observability: {
        level: 'warn',
        logsEnabled: true,
        logsExporter: 'memory',
        exporter: 'memory',
      },
      workerManager: {
        rbac: {
          port: 49135,
          exposeFunctions: [
            'match("test-wf*")',
          ],
        },
      },
      workflow: {
        adapter: {
          type: 'redis',
          redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
        },
        config: {
          observabilityRetentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
          redisGlobalLogTraceIndex: true,
          idempotencyTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
        },
      },
      state: {
        adapter: {
          type: 'redis',
          redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
        }
      },
      stream: {
        adapter: {
          type: 'redis',
          redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
        }
      },
    },
    functions: {
      dir: 'functions',
      python: {
        devPath: '.venv/bin/python3',
      }
    },
    app: {
      enabled: true,
    },
  },
})
