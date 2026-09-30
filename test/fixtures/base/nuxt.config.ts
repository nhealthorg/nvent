// This file is required for @nuxt/test-utils to recognize this as a valid Nuxt app
import NventModule from '../../../packages/nvent/src/module'

export default defineNuxtConfig({
  modules: [NventModule],
  nvent: {
    iii: {
      version: 'iii/v0.24.3',
      failOnInstallFailure: true,
      compose: {
        managed: true,
        logLevel: 'warn',
        daemonNamespace: 'default',
      },
      namespace: {
        mode: 'single',
        default: 'default',
      },
      ade: false,
      harness: false,
      workflow: {
        adapter: {
          type: 'memory',
        },
      },
    },
    dir: 'functions',
    ui: false,
    queue: {
      adapter: 'memory',
      worker: {
        concurrency: 2,
        autorun: true,
      },
    },
    stream: {
      adapter: 'memory',
    },
    store: {
      adapter: 'memory',
      prefix: 'nq-test',
    },
  },
})
