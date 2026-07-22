import {
  defineNuxtModule,
  createResolver,
  addImportsDir,
  addComponent,
  addComponentsDir,
  addServerScanDir,
  addPlugin,
  extendPages,
} from '@nuxt/kit'
import defu from 'defu'
import type {} from '@nuxt/schema'
import { readFileSync } from 'node:fs'

const resolver = createResolver(import.meta.url)
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

interface ModuleOptions {
  /**
   * Enable the built-in route at /_nvent
   * @default true
   */
  route?: boolean
  /**
   * Custom route path for the Nvent app
   * @default '/_nvent'
   */
  routePath?: string
  /**
   * Layout to use for the route page
   * Set to false to use no layout (standalone page)
   * Set to a string to use a specific layout from your app
   * @default false
   */
  layout?: string | false
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nventapp',
    version: packageJson.version,
    configKey: 'nventapp',
  },
  defaults: {
    route: true,
    routePath: '/_nvent',
    layout: false,
  },
  moduleDependencies: {
    '@nuxt/ui': {
      version: '>=4',
    },
    '@nhealth/nutils': {},
  },
  async setup(options, nuxt) {
    const { resolve } = resolver

    // Make module options available at runtime
    nuxt.options.runtimeConfig.public.nventapp = defu(
      nuxt.options.runtimeConfig.public.nventapp as any,
      {
        routePath: options.routePath,
      },
    )

    // Add vueflow CSS
    nuxt.options.css = nuxt.options.css || []
    nuxt.options.css.push(resolve('./runtime/app/assets/vueflow.css'))

    // Add shared utilities for both app and server
    addImportsDir(resolve('./runtime/shared/utils'))

    addImportsDir(resolve('./runtime/app/composables'))

    // Scan server directory for auto-imports
    addServerScanDir(resolve('./runtime/server'))

    addPlugin({
      src: resolve('./runtime/app/plugins/vueflow.client'),
      mode: 'client',
    })
    addComponentsDir({
      path: resolve('./runtime/app/components'),
      prefix: 'Nvent',
    })

    // Register as global component (for manual use like <NventApp />)
    addComponent({
      name: 'NventApp',
      filePath: resolve('./runtime/app/pages/index.vue'),
      global: true,
    })

    // Add route if enabled
    if (options.route !== false) {
      extendPages((pages) => {
        pages.push({
          name: 'nvent-app',
          path: options.routePath || '/_nvent',
          file: resolve('./runtime/app/pages/index.vue'),
          meta: {
            layout: options.layout === false ? false : options.layout,
          },
        })
      })
    }
    nuxt.hook('vite:extendConfig', (config, { isClient }) => {
      config.optimizeDeps = config.optimizeDeps || {}
      config.optimizeDeps.include = config.optimizeDeps.include || []
      config.optimizeDeps.include.push(
        '@vue/devtools-core',
        '@vue/devtools-kit',
        'vanilla-jsoneditor',
        '@vue-flow/core',
        '@vue-flow/controls',
        '@vue-flow/minimap',
        '@vue-flow/background',
        'tailwind-merge',
        'tailwind-variants',
        'iii-browser-sdk',
        'vue-router',
      )

      config.optimizeDeps.exclude = config.optimizeDeps.exclude || []
      if (!config.optimizeDeps.exclude.includes('vue-demi')) {
        config.optimizeDeps.exclude.push('vue-demi')
      }

      config.resolve = config.resolve || {}
      config.resolve.alias = config.resolve.alias || {}
      if (Array.isArray(config.resolve.alias)) {
        config.resolve.alias.push({ find: 'vue-demi', replacement: 'vue-demi/lib/v3/index.mjs' })
      } else {
        config.resolve.alias['vue-demi'] = 'vue-demi/lib/v3/index.mjs'
      }

      config.resolve.dedupe = config.resolve.dedupe || []
      if (!config.resolve.dedupe.includes('vue')) {
        config.resolve.dedupe.push('vue')
      }
    })
  },
})
