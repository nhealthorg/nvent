<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Header -->
    <div class="border-b border-gray-200 dark:border-gray-800 px-6 py-4 shrink-0">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Dashboard
          </h1>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Overview of your Nuxt Queue system
          </p>
        </div>
        <div
          class="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"
        >
          <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Live</span>
        </div>
      </div>
    </div>

    <!-- Main Content -->
    <div class="flex-1 min-h-0 overflow-y-auto p-6">
      <div class="max-w-7xl mx-auto space-y-6">
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
</script>
