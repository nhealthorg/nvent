<template>
  <div :class="ui.root">
    <component
      :is="item.clickable !== false ? 'button' : 'div'"
      v-for="item in visibleItems"
      :key="item.value"
      :type="item.clickable !== false ? 'button' : undefined"
      :class="itemClasses(item)"
      @click="item.clickable !== false ? $emit('update:modelValue', item.value) : undefined"
    >
      <!-- Status Icon or All Icon -->
      <div
        class="flex-shrink-0"
        :class="item.step.showAllIndicator ? '' : 'mt-0.5'"
      >
        <div
          v-if="item.step.showAllIndicator"
          class="w-6 h-6 rounded-full flex items-center justify-center bg-gray-100 dark:bg-gray-800"
        >
          <UIcon
            name="i-lucide-layers"
            class="w-3 h-3 text-gray-600 dark:text-gray-400"
          />
        </div>
        <div
          v-else-if="item.step.isLoopGroup"
          class="w-8 h-8 rounded-md flex items-center justify-center bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-200 dark:border-cyan-800"
        >
          <UIcon
            name="i-heroicons-arrow-path-rounded-square-20-solid"
            class="w-4 h-4 text-cyan-700 dark:text-cyan-300"
          />
        </div>
        <div
          v-else
          class="w-8 h-8 rounded-full flex items-center justify-center"
          :class="getStepStatusBg(item.step.status)"
        >
          <UIcon
            :name="getStepStatusIcon(item.step.status)"
            class="w-4 h-4"
            :class="getStepStatusIconColor(item.step.status)"
          />
        </div>
      </div>

      <!-- Step Details -->
      <div class="flex-1 min-w-0 ml-3">
        <div class="flex items-center gap-2">
          <h4 class="text-sm font-medium text-gray-900 dark:text-gray-100">
            {{ getStepDisplayName(item.step) }}
          </h4>
          <UBadge
            v-if="item.step.isLoopGroup"
            size="xs"
            color="info"
            variant="soft"
          >
            For Block
          </UBadge>
          <UBadge
            v-if="item.step.inLoopGroup"
            size="xs"
            color="info"
            variant="subtle"
            class="flex items-center gap-1"
          >
            <UIcon
              name="i-heroicons-arrow-path-rounded-square-20-solid"
              class="w-3 h-3"
            />
            <span>{{ item.step.loopGroupId ? `In ${String(item.step.loopGroupId).toUpperCase()}` : 'In Loop' }}</span>
          </UBadge>
          <UBadge
            v-if="isVarStep(item.step)"
            size="xs"
            color="success"
            variant="soft"
            class="flex items-center gap-1"
          >
            <UIcon
              name="i-lucide-variable"
              class="w-3 h-3"
            />
            <span>Var</span>
          </UBadge>
          <UBadge
            v-if="item.step.isLoopGroup"
            size="xs"
            :color="getLoopModeColor(item.step.loopMode)"
            variant="outline"
          >
            {{ getLoopModeLabel(item.step.loopMode) }}
          </UBadge>
          <!-- Await Badge with Type Icon -->
          <UBadge
            v-if="isAwaitStepKey(item.step.key)"
            size="xs"
            :color="getAwaitBadgeColor(item.step.status)"
            variant="subtle"
            class="flex items-center gap-1"
          >
            <UIcon
              :name="getAwaitTypeIcon(item.step.awaitType)"
              class="w-3 h-3"
            />
            <span>{{ getAwaitTypeLabel(item.step.awaitType) }}</span>
          </UBadge>
        </div>
          <div
            v-if="item.step.isLoopGroup"
            class="mt-2 rounded-md border border-cyan-200/80 dark:border-cyan-800/60 bg-cyan-50/60 dark:bg-cyan-900/10 p-2.5"
          >
            <div
              v-if="item.step.loopOver"
              class="mt-1 text-[10px] text-cyan-700/90 dark:text-cyan-300/90 font-mono truncate"
              :title="item.step.loopOver"
            >
              over {{ item.step.loopOver }}
            </div>
            <div
              v-if="item.step.loopPipeline"
              class="mt-1 text-[10px] text-cyan-800/90 dark:text-cyan-200/90 font-mono truncate"
              :title="item.step.loopPipeline"
            >
              {{ item.step.loopPipeline }}
            </div>

            <div
              v-if="Number.isFinite(Number(item.step.loopItemsTotal)) && Number(item.step.loopItemsTotal) > 0"
              class="mt-2 grid grid-cols-2 gap-1.5 text-[10px]"
            >
              <div class="rounded border border-cyan-200/70 dark:border-cyan-800/60 bg-white/70 dark:bg-cyan-950/20 px-1.5 py-1">
                <div class="text-cyan-700/80 dark:text-cyan-300/80 uppercase tracking-wide">Items</div>
                <div class="text-cyan-900 dark:text-cyan-100 font-semibold">
                  {{ item.step.loopItemsDone || 0 }}/{{ item.step.loopItemsTotal || 0 }} done
                </div>
              </div>
              <div class="rounded border border-cyan-200/70 dark:border-cyan-800/60 bg-white/70 dark:bg-cyan-950/20 px-1.5 py-1">
                <div class="text-cyan-700/80 dark:text-cyan-300/80 uppercase tracking-wide">Active</div>
                <div class="text-cyan-900 dark:text-cyan-100 font-semibold">
                  <span v-if="item.step.loopActiveIndex === null || item.step.loopActiveIndex === undefined">n/a</span>
                  <span v-else>#{{ item.step.loopActiveIndex }}</span>
                </div>
              </div>
            </div>

            <div
              v-if="Number(item.step.loopItemsRunning || 0) > 0 || Number(item.step.loopItemsFailed || 0) > 0 || Number(item.step.loopItemsPending || 0) > 0"
              class="mt-1 text-[10px] text-cyan-800/85 dark:text-cyan-200/85"
            >
              running {{ item.step.loopItemsRunning || 0 }} • pending {{ item.step.loopItemsPending || 0 }} • failed {{ item.step.loopItemsFailed || 0 }}
            </div>

            <div
              v-if="getLoopChildren(item).length > 0"
              class="mt-2 space-y-1.5"
            >
              <button
                type="button"
                class="w-full text-left rounded border px-2.5 py-2 transition-colors border-cyan-300/80 dark:border-cyan-700 bg-cyan-100/70 dark:bg-cyan-900/30 hover:bg-cyan-200/80 dark:hover:bg-cyan-900/50"
                :class="props.modelValue === item.value ? 'ring-1 ring-cyan-500/80' : ''"
                @click.stop="$emit('update:modelValue', item.value)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs font-semibold text-cyan-900 dark:text-cyan-100">Gesamte Loop filtern</span>
                  <UBadge size="xs" color="info" variant="soft">Loop Filter</UBadge>
                </div>
              </button>

              <button
                v-for="child in getLoopChildren(item)"
                :key="child.value"
                type="button"
                class="w-full text-left rounded border px-2.5 py-2 transition-colors"
                :class="loopChildClasses(child)"
                @click.stop="$emit('update:modelValue', child.value)"
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="min-w-0 flex items-center gap-2">
                    <UIcon
                      :name="getStepStatusIcon(child.step.status)"
                      class="w-3.5 h-3.5 flex-shrink-0"
                      :class="getStepStatusIconColor(child.step.status)"
                    />
                    <span class="truncate text-xs font-medium text-cyan-900 dark:text-cyan-100">
                      {{ getStepDisplayName(child.step) }}
                    </span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span
                      class="text-[10px] capitalize"
                      :class="getStepStatusTextColor(child.step.status)"
                    >
                      {{ child.step.status || 'pending' }}
                    </span>
                  </div>
                </div>
              </button>
            </div>

            <div
              v-if="item.step.canInspectResult"
              class="mt-3 flex justify-end"
            >
              <UButton
                icon="i-lucide-file-json"
                size="xs"
                variant="ghost"
                color="cyan"
                label="Loop results"
                @click.stop="emit('inspect-step-result', item.value)"
              />
            </div>
          </div>
        <div
            v-if="item.step.inLoopGroup && item.step.loopOver"
          class="mt-1 text-[11px] text-gray-500 dark:text-gray-400 font-mono truncate"
          :title="item.step.loopOver"
        >
            in {{ String(item.step.loopGroupId || 'loop').toUpperCase() }} over {{ item.step.loopOver }}
        </div>
        <div
            v-if="!item.step.showAllIndicator && !item.step.isLoopGroup"
          class="flex items-center gap-3 mt-1 text-xs text-gray-500"
        >
          <span
            class="capitalize"
            :class="getStepStatusTextColor(item.step.status)"
          >
            {{ item.step.status || 'pending' }}
          </span>
          <span
            v-if="item.step.retries && item.step.retries > 0"
            class="flex items-center gap-1 text-amber-500"
          >
            <UIcon
              name="i-lucide-rotate-ccw"
              class="w-3 h-3"
            />
            <span>{{ item.step.retries }} {{ item.step.retries === 1 ? 'retry' : 'retries' }}</span>
          </span>
          <!-- Await Position Badge -->
          <UBadge
            v-if="isAwaitStepKey(item.step.key)"
            size="xs"
            color="neutral"
            variant="outline"
          >
            {{ getAwaitPositionLabel(item.step.key) }}
          </UBadge>
          <!-- Step Timeout Badge (only for regular steps, not await steps) -->
          <span
            v-if="item.step.stepTimeout && !isAwaitStepKey(item.step.key)"
            class="flex items-center gap-1"
            :title="`Step Execution Timeout: ${formatDuration(item.step.stepTimeout)}`"
          >
            <UIcon
              name="i-lucide-hourglass"
              class="w-3 h-3 opacity-60"
            />
            <span>{{ formatDuration(item.step.stepTimeout) }}</span>
          </span>
        </div>

        <!-- Additional Details (from description slot) -->
        <div
          v-if="!item.step.showAllIndicator && !item.step.isLoopGroup && (item.step.startedAt || item.step.completedAt || item.step.error || item.step.awaitType || item.step.canInspectResult)"
          class="mt-3 text-xs"
        >
          <!-- Timing Info -->
          <div
            v-if="item.step.startedAt || item.step.completedAt"
            class="flex items-center gap-4 text-xs text-gray-500"
          >
            <div
              v-if="item.step.startedAt"
              class="flex items-center gap-1"
            >
              <UIcon
                name="i-lucide-clock"
                class="w-3 h-3"
              />
              <span>{{ formatTime(item.step.startedAt) }}</span>
            </div>
            <div
              v-if="item.step.completedAt"
              class="flex items-center gap-1"
            >
              <UIcon
                name="i-lucide-check-circle"
                class="w-3 h-3"
              />
              <span>{{ formatTime(item.step.completedAt) }}</span>
            </div>
          </div>

          <!-- Error Message -->
          <div
            v-if="item.step.error"
            class="mt-2"
          >
            <div
              class="p-2 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded text-xs text-red-600 dark:text-red-400"
              :title="String(item.step.error || '')"
            >
              <div class="flex items-start gap-1">
                <UIcon
                  name="i-lucide-alert-circle"
                  class="w-3 h-3 flex-shrink-0 mt-0.5"
                />
                <p class="line-clamp-2 break-all">
                  {{ item.step.error }}
                </p>
              </div>
            </div>
          </div>

          <!-- Await Config Details -->
          <div
            v-if="item.step.awaitType && (item.step.awaitConfig || item.step.awaitData)"
            class="mt-2 p-2.5 rounded-md border"
            :class="getAwaitConfigBgClass(item.step.status)"
          >
            <div class="flex flex-col gap-2">
              <!-- Primary Info -->
              <div class="flex items-center gap-2">
                <UIcon
                  :name="getAwaitTypeIcon(item.step.awaitType)"
                  class="w-3.5 h-3.5"
                  :class="getAwaitIconColor(item.step.status)"
                />
                <span
                  class="font-medium"
                  :class="getAwaitTextColor(item.step.status)"
                >
                  {{ getAwaitTypeLabel(item.step.awaitType) }} Pattern
                </span>
              </div>

              <!-- Configuration Details -->
              <div class="space-y-1.5 text-xs">
                <!-- Webhook specific -->
                <div
                  v-if="item.step.awaitType === 'webhook'"
                  class="space-y-1"
                >
                  <div
                    v-if="item.step.awaitConfig?.method || item.step.awaitData?.method"
                    class="flex items-center gap-1.5"
                  >
                    <UIcon
                      name="i-lucide-git-branch"
                      class="w-3 h-3 opacity-60"
                    />
                    <span class="opacity-75">Method:</span>
                    <UBadge
                      size="xs"
                      :color="getMethodBadgeColor(item.step.awaitData?.method || item.step.awaitConfig?.method)"
                      variant="subtle"
                    >
                      {{ item.step.awaitData?.method || item.step.awaitConfig?.method }}
                    </UBadge>
                  </div>
                  <div
                    v-if="item.step.awaitData?.webhookUrl"
                    class="flex items-start gap-1.5"
                  >
                    <UIcon
                      name="i-lucide-link"
                      class="w-3 h-3 opacity-60 mt-0.5"
                    />
                    <span class="opacity-75">URL:</span>
                    <div class="flex-1 flex items-start gap-1">
                      <code class="px-1.5 py-0.5 bg-black/5 dark:bg-white/5 rounded text-[10px] flex-1 break-all">{{ item.step.awaitData.webhookUrl }}</code>
                      <button
                        type="button"
                        class="flex-shrink-0 p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded transition-colors"
                        :title="copiedUrl === item.step.awaitData.webhookUrl ? 'Copied!' : 'Copy URL'"
                        @click.stop="copyToClipboard(item.step.awaitData.webhookUrl)"
                      >
                        <UIcon
                          :name="copiedUrl === item.step.awaitData.webhookUrl ? 'i-lucide-check' : 'i-lucide-copy'"
                          class="w-3 h-3"
                          :class="copiedUrl === item.step.awaitData.webhookUrl ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-60'"
                        />
                      </button>
                    </div>
                  </div>
                  <div
                    v-else-if="item.step.awaitConfig?.path"
                    class="flex items-start gap-1.5"
                  >
                    <UIcon
                      name="i-lucide-route"
                      class="w-3 h-3 opacity-60 mt-0.5"
                    />
                    <span class="opacity-75">Path:</span>
                    <code class="px-1.5 py-0.5 bg-black/5 dark:bg-white/5 rounded text-[10px] flex-1">{{ item.step.awaitConfig.path }}</code>
                  </div>
                </div>

                <!-- Event specific -->
                <div
                  v-if="item.step.awaitType === 'event'"
                  class="space-y-1"
                >
                  <div
                    v-if="item.step.awaitConfig?.event || item.step.awaitData?.eventName"
                    class="flex items-center gap-1.5"
                  >
                    <UIcon
                      name="i-lucide-zap"
                      class="w-3 h-3 opacity-60"
                    />
                    <span class="opacity-75">Event:</span>
                    <code class="px-1.5 py-0.5 bg-black/5 dark:bg-white/5 rounded text-[10px]">{{ item.step.awaitData?.eventName || item.step.awaitConfig?.event }}</code>
                  </div>
                  <div
                    v-if="item.step.awaitConfig?.filterKey || item.step.awaitData?.filterKey"
                    class="flex items-center gap-1.5"
                  >
                    <UIcon
                      name="i-lucide-filter"
                      class="w-3 h-3 opacity-60"
                    />
                    <span class="opacity-75">Filter:</span>
                    <code class="px-1.5 py-0.5 bg-black/5 dark:bg-white/5 rounded text-[10px]">{{ item.step.awaitData?.filterKey || item.step.awaitConfig?.filterKey }}</code>
                  </div>
                </div>

                <!-- Time specific -->
                <div
                  v-if="item.step.awaitType === 'time' && item.step.awaitConfig?.delay"
                  class="space-y-1"
                >
                  <div class="flex items-center gap-1.5">
                    <UIcon
                      name="i-lucide-timer"
                      class="w-3 h-3 opacity-60"
                    />
                    <span class="opacity-75">Delay:</span>
                    <span class="font-medium">{{ formatDuration(item.step.awaitConfig.delay) }}</span>
                  </div>
                  <div
                    v-if="item.step.scheduledTriggerAt"
                    class="flex items-center gap-1.5"
                  >
                    <UIcon
                      name="i-lucide-calendar-clock"
                      class="w-3 h-3 opacity-60"
                    />
                    <span class="opacity-75">Triggers at:</span>
                    <span class="font-medium">{{ formatScheduledTime(item.step.scheduledTriggerAt) }}</span>
                  </div>
                </div>

                <!-- Schedule specific -->
                <div
                  v-if="item.step.awaitType === 'schedule' && item.step.awaitConfig?.cron"
                  class="space-y-1"
                >
                  <div class="flex items-center gap-1.5">
                    <UIcon
                      name="i-lucide-calendar-cog"
                      class="w-3 h-3 opacity-60"
                    />
                    <span class="opacity-75">Cron:</span>
                    <code class="px-1.5 py-0.5 bg-black/5 dark:bg-white/5 rounded text-[10px]">{{ item.step.awaitConfig.cron }}</code>
                  </div>
                  <div
                    v-if="item.step.scheduledTriggerAt"
                    class="flex items-center gap-1.5"
                  >
                    <UIcon
                      name="i-lucide-calendar-check"
                      class="w-3 h-3 opacity-60"
                    />
                    <span class="opacity-75">Next trigger:</span>
                    <span class="font-medium">{{ formatScheduledTime(item.step.scheduledTriggerAt) }}</span>
                  </div>
                </div>

                <!-- Timeout -->
                <div
                  v-if="item.step.awaitConfig?.timeout || item.step.awaitData?.timeout"
                  class="flex items-center gap-1.5"
                >
                  <UIcon
                    name="i-lucide-hourglass"
                    class="w-3 h-3 opacity-60"
                  />
                  <span class="opacity-75">Timeout:</span>
                  <span class="font-medium">{{ formatDuration(item.step.awaitData?.timeout || item.step.awaitConfig?.timeout) }}</span>
                </div>

                <!-- Timeout Action -->
                <div
                  v-if="item.step.awaitConfig?.timeoutAction || item.step.awaitData?.timeoutAction"
                  class="flex items-center gap-1.5"
                >
                  <UIcon
                    name="i-lucide-shield-alert"
                    class="w-3 h-3 opacity-60"
                  />
                  <span class="opacity-75">On Timeout:</span>
                  <UBadge
                    size="xs"
                    :color="getTimeoutActionColor(item.step.awaitData?.timeoutAction || item.step.awaitConfig?.timeoutAction)"
                    variant="subtle"
                  >
                    {{ item.step.awaitData?.timeoutAction || item.step.awaitConfig?.timeoutAction }}
                  </UBadge>
                </div>
              </div>
            </div>
          </div>

          <!-- Result Button -->
          <div
            v-if="item.step.canInspectResult"
            class="mt-2 flex justify-end"
          >
            <UButton
              icon="i-lucide-file-json"
              size="xs"
              variant="ghost"
              color="gray"
              label="Result"
              @click.stop="emit('inspect-step-result', item.value)"
            />
          </div>
        </div>
      </div>
    </component>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { tv } from 'tailwind-variants'
import { twMerge } from 'tailwind-merge'
import type { ClassValue } from 'tailwind-variants'
import {
  formatDuration,
  formatScheduledTime,
  formatTimeAgo,
  getAwaitBadgeColor,
  getAwaitConfigBgClass,
  getAwaitIconColor,
  getAwaitPositionLabel,
  getAwaitTextColor,
  getAwaitTypeIcon,
  getAwaitTypeLabel,
  getLoopModeColor,
  getLoopModeLabel,
  getMethodBadgeColor,
  getStepDisplayName,
  getStepStatusBg,
  getStepStatusIcon,
  getStepStatusIconColor,
  getStepStatusTextColor,
  getTimeoutActionColor,
  isAwaitStepKey,
  isVarStep,
} from './step-selector.utils'

const props = defineProps<{
  modelValue: string
  items: Array<{
    value: string
    label: string
    step: any
    clickable?: boolean
  }>
  ui?: {
    root?: ClassValue
    item?: ClassValue
    itemSelected?: ClassValue
    itemBase?: ClassValue
  }
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'inspect-step-result': [stepKey: string]
}>()

// Copy to clipboard functionality
const copiedUrl = ref<string | null>(null)

const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
    copiedUrl.value = text
    setTimeout(() => {
      copiedUrl.value = null
    }, 2000)
  }
  catch (err) {
    console.error('Failed to copy:', err)
  }
}

// Default UI configuration
const defaultUi = {
  root: 'space-y-3',
  itemBase: 'relative w-full flex items-start border rounded-lg text-sm p-3.5 transition-colors text-left',
  itemClickable: 'hover:bg-gray-50 dark:hover:bg-gray-900/50 cursor-pointer',
  itemNonClickable: 'bg-blue-50/50 dark:bg-blue-900/10 opacity-75 cursor-default',
  item: 'border-gray-200 dark:border-gray-800',
  itemSelected: 'border-primary bg-primary/5 dark:bg-primary/10',
}

// Merge user UI with default UI
const ui = computed(() => ({
  root: twMerge(defaultUi.root, props.ui?.root as string),
  itemBase: twMerge(defaultUi.itemBase, props.ui?.itemBase as string),
  itemClickable: defaultUi.itemClickable,
  itemNonClickable: defaultUi.itemNonClickable,
  item: props.ui?.item as string || defaultUi.item,
  itemSelected: props.ui?.itemSelected as string || defaultUi.itemSelected,
}))

// Create item variant using tailwind-variants
const itemVariants = computed(() => tv({
  base: ui.value.itemBase,
  variants: {
    selected: {
      true: ui.value.itemSelected,
      false: ui.value.item,
    },
    clickable: {
      true: ui.value.itemClickable,
      false: ui.value.itemNonClickable,
    },
  },
}))

// Compute classes for each item
const itemClasses = (item: any) => {
  const isClickable = item.clickable !== false
  return itemVariants.value({
    selected: isClickable && props.modelValue === item.value,
    clickable: isClickable,
  })
}

const visibleItems = computed(() => {
  return props.items.filter((item) => !shouldHideTopLevelItem(item))
})

function shouldHideTopLevelItem(item: any): boolean {
  return Boolean(item?.step?.inLoopGroup)
}

function getLoopChildren(groupItem: any): any[] {
  const groupId = groupItem?.step?.loopGroupId
  if (!groupId) return []
  return props.items.filter(item => item?.step?.inLoopGroup && item?.step?.loopGroupId === groupId)
}

function loopChildClasses(child: any): string {
  const isSelected = props.modelValue === child.value
  const base = 'border-cyan-200/70 dark:border-cyan-800/70 bg-white/70 dark:bg-cyan-950/20 hover:bg-cyan-100/70 dark:hover:bg-cyan-900/30'
  const selected = 'ring-1 ring-cyan-400/70 border-cyan-400 dark:border-cyan-600 bg-cyan-100/80 dark:bg-cyan-900/40'
  return isSelected ? `${base} ${selected}` : base
}

const formatTime = formatTimeAgo
</script>
