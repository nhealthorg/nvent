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
      version: 'iii/v0.21.6',
      failOnInstallFailure: true,
      mode: 'local',
      console: true,
      logLevel: 'warn',
      observability: {
        level: 'info',
        logsEnabled: true,
        logsExporter: 'memory',
        exporter: 'memory',
      },
      workerManager: {
        rbac: {
          port: 49135,
          exposeFunctions: [
            'match("pipeline::*")',
          ],
        },
      },
      workflow: {
        observabilityRetentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
      queue: {
        queueConfigs: {
          default: {
            concurrency: 4,
          },
          heartbeat: {
            type: 'standard',
            concurrency: 1,
            maxRetries: 1,
          },
        }
      },
      state: {
      }
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
