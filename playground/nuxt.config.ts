import { log } from "node:console";

export default defineNuxtConfig({
  modules: [
    '@nuxt/ui',
    'nvent',
  ],

  devtools: {
    enabled: true,
  },

  css: ['~/assets/css/main.css'],

  colorMode: {
    preference: 'light',
  },

  nvent: {
    iii: {
      version: 'latest',
      mode: 'local',
      console: true,
      logLevel: 'warn',
    },
    functions: {
      dir: 'functions/iii',
      python: '.venv/bin/python3',
    },
    console: {
      enabled: true,
    },
  },
})
