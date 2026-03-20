import { log } from "node:console";

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

  nvent: {
    iii: {
      version: 'latest',
      mode: 'local',
      console: true,
      logLevel: 'warn',
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
