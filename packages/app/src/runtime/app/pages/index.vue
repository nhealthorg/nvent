<template>
    <NUtilsComponentRouter
      v-slot="{ component }"
      :routes="routes"
      :base="base"
      :mode="mode"
  >
    <NUtilsComponentShell
      :orientation="orientation"
      :items="navItems"
      :active-match="activeMatch"
      :page-offset="pageOffset"
    >
      <template v-if="showLeading" #leading>
        <div class="px-4 py-3 border-gray-200 dark:border-gray-800 flex items-center gap-2.5">
          <div class="flex items-center justify-center w-7 h-7 rounded-lg bg-primary-100 dark:bg-primary-900/40 shrink-0">
            <UIcon name="i-lucide-scan-line" class="w-4 h-4 text-primary-600 dark:text-primary-400" />
          </div>
          <span class="text-sm font-semibold tracking-tight">NVENT</span>
        </div>
      </template>

      <template #trailing>
        <div class="mt-auto px-3 py-3 border-t border-gray-200 dark:border-gray-800">
            <!-- TODO -->
        </div>
      </template>

      <component :is="component" />
    </NUtilsComponentShell>
  </NUtilsComponentRouter>

  <!-- Confirm Modal from nutils -->
  <NUtilsConfirmModal />
</template>

<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import Workers from './workers.vue'
import Workflows from './workflows/index.vue'
import WorkflowRuns from './workflows/runs.vue'
import WorkflowRun from './workflows/[id].vue'

withDefaults(defineProps<{
  /**
   * The query/hash key (or memory namespace) used by the component router.
   * Change this when embedding multiple component-routed apps on the same page.
   * @default 'view'
   */
  base?: string
  /**
   * How the component router persists the current route.
   * - 'query'  — URL query param (default, shareable URLs)
   * - 'hash'   — URL hash fragment
   * - 'memory' — in-memory only (no URL change, ideal for embedded use)
   */
  mode?: 'query' | 'hash' | 'memory'
  /**
   * The layout orientation of the component shell.
   * - 'horizontal' — Navigation bar at the top (default)
   * - 'vertical'   — Navigation sidebar on the left
   * @default 'horizontal'
   */
  orientation?: 'horizontal' | 'vertical'
  /**
   * How navigation items are matched against the current route.
   * - 'prefix' — matches if route starts with item path (default)
   * - 'exact'  — matches only exact path
   * @default 'prefix'
   */
  activeMatch?: 'exact' | 'prefix'
  /**
   * The offset applied to the shell container height (e.g., for fixed headers).
   * Can be a string (CSS value) or number (in pixels).
   * @default 0
   */
  pageOffset?: string | number
  /**
   * Whether to show the leading slot (branding/logo area).
   * @default true
   */
  showLeading?: boolean
}>(), {
  base: 'view',
  mode: 'query',
  orientation: 'horizontal',
  activeMatch: 'exact',
  pageOffset: 0,
  showLeading: true,
})

const navItems: NavigationMenuItem[][] = [
  [
    { label: 'Workflows', icon: 'i-lucide-workflow', path: '/workflows' } as any,
    { label: 'Workers', icon: 'i-lucide-server', path: '/workers' } as any,
  ]
]

const routes = {
  '/workflows': Workflows,
  '/workflows/runs': WorkflowRuns,
  '/workflows/runs/:id': WorkflowRun,
  '/workers': Workers,
}

// Consumer mode: read the current router context from inside this page
// Shell and pages will consume the router via useComponentRouter() in consumer mode
</script>
