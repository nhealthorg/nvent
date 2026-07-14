<template>
    <NUtilsComponentRouter
    v-slot="{ component }"
    :routes="routes"
    base="p"
    mode="query"
  >
    <NUtilsComponentShell
      orientation="horizontal"
      :items="navItems"
    >
      <template #leading>
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
import Dashboard from './dashboard.vue'
import Workers from './workers.vue'
import Workflows from './workflows/index.vue'
import WorkflowRuns from './workflows/runs.vue'
import WorkflowRun from './workflows/[id].vue'

const navItems: NavigationMenuItem[][] = [
  [
    { label: 'Dashboard', icon: 'i-lucide-layout-dashboard', path: '/' } as any,
    { label: 'Workflows', icon: 'i-lucide-workflow', path: '/workflows' } as any,
    { label: 'Workers', icon: 'i-lucide-server', path: '/workers' } as any,
  ]
]

const routes = {
  '/': Dashboard,
  '/workflows': Workflows,
  '/workflows/runs': WorkflowRuns,
  '/workflows/runs/:id': WorkflowRun,
  '/workers': Workers,
}

// Consumer mode: read the current router context from inside this page
// Shell and pages will consume the router via useComponentRouter() in consumer mode
</script>
