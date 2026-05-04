export default defineNuxtConfig({
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
    optimizeDeps: {
      include: [
        '@vue/devtools-core',
        '@vue/devtools-kit',
      ]
    }
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
      version: 'latest',
      mode: 'local',
      console: true,
      logLevel: 'warn',
      workerManager: {
        rbac: {
          port: 49135,
          exposeFunctions: [
            'match("pipeline::*")',
          ],
        },
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
