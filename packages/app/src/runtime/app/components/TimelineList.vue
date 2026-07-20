<template>
  <div
    :class="heightClass"
    class="overflow-y-auto overflow-x-hidden"
  >
    <UTimeline
      v-if="timelineItems && timelineItems.length"
      :items="timelineItems"
      size="xs"
      class="px-6 py-4"
    >
      <!-- Custom indicator slot to show icons -->
      <template #indicator="{ item }">
        <UIcon
          :name="item.icon || 'i-lucide-circle'"
          class="size-4"
        />
      </template>

      <!-- Custom title slot to include kind badge and subject -->
      <template #title="{ item }">
        <div class="min-w-0 space-y-2">
          <div
            v-if="item.groupLabel"
            class="flex items-center gap-2"
          >
            <div class="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
            <span class="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">
              {{ item.groupLabel }}
            </span>
            <div class="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
          </div>
          <div class="flex items-center gap-2 min-w-0">
            <span
              :class="eventTypeColor(item.eventType)"
              class="font-mono text-xs px-2 py-1 rounded font-medium flex-shrink-0"
            >
              {{ item.eventType }}
            </span>
            <span
              v-if="item.stepName"
              class="text-xs text-gray-600 dark:text-gray-300 truncate"
            >
              {{ item.stepName }}
            </span>
          </div>
        </div>
      </template>

      <!-- Custom description slot for rich content -->
      <template #description="{ item }">
        <!-- Special rendering for log events -->
        <div
          v-if="item.eventType === 'log'"
          :class="[
            hasMetadata(item.eventData) ? 'p-3 rounded-lg border mt-2' : 'mt-1 p-3 rounded-lg border',
            logSurfaceClass(item?.eventData?.level),
          ]"
          class="space-y-2"
        >
          <div class="flex items-start gap-2">
            <UBadge
              :color="levelColor(item?.eventData?.level)"
              variant="solid"
              size="xs"
              class="capitalize mt-0.5 flex-shrink-0"
            >
              {{ item?.eventData?.level || 'info' }}
            </UBadge>
            <span class="text-xs text-gray-900 dark:text-gray-100 flex-1 break-words line-clamp-3">
              {{ item?.eventData?.message || '' }}
            </span>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400">
            <span v-if="item?.eventData?.serviceName" class="rounded bg-white/70 dark:bg-black/20 px-2 py-0.5">{{ item.eventData.serviceName }}</span>
            <span v-if="item?.eventData?.traceId" class="font-mono rounded bg-white/70 dark:bg-black/20 px-2 py-0.5">trace {{ shortId(item.eventData.traceId) }}</span>
            <span v-if="item?.eventData?.spanId" class="font-mono rounded bg-white/70 dark:bg-black/20 px-2 py-0.5">span {{ shortId(item.eventData.spanId) }}</span>
          </div>
          <!-- Show metadata in accordion if exists -->
          <div v-if="hasMetadata(item.eventData)">
            <UAccordion
              :items="[{
                label: 'Metadata',
                icon: 'i-lucide-info',
                defaultOpen: false,
                content: item.eventData,
              }]"
              :ui="{
                trigger: 'text-[10px] py-1',
                leadingIcon: 'size-3 text-blue-500 dark:text-blue-400',
                label: 'text-[10px]',
                item: 'border-0 mt-1',
              }"
            >
              <template #content="{ item: accordionItem }">
                <pre class="text-xs bg-gray-50 dark:bg-gray-800 rounded p-2 overflow-y-auto max-h-60 text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-words">{{ prettyMetadata(accordionItem.content) }}</pre>
              </template>
            </UAccordion>
          </div>
        </div>

        <!-- Special rendering for await events -->
        <div
          v-else-if="isAwaitEvent(item.eventType)"
          class="text-sm mt-2"
        >
          <div
            v-if="item.eventData"
            class="space-y-1 p-2 rounded border bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700"
          >
            <div
              v-if="item.eventData.awaitType"
              class="flex items-start gap-2"
            >
              <span class="text-xs text-gray-500 dark:text-gray-400 min-w-[60px] flex-shrink-0">Type:</span>
              <UBadge
                color="blue"
                variant="subtle"
                size="xs"
                class="capitalize"
              >
                {{ item.eventData.awaitType }}
              </UBadge>
            </div>
            <div
              v-if="item.eventData.position"
              class="flex items-start gap-2"
            >
              <span class="text-xs text-gray-500 dark:text-gray-400 min-w-[60px] flex-shrink-0">Position:</span>
              <UBadge
                color="neutral"
                variant="subtle"
                size="xs"
                class="capitalize"
              >
                {{ item.eventData.position }}
              </UBadge>
            </div>
            <div
              v-if="item.eventData.triggerName"
              class="flex items-start gap-2"
            >
              <span class="text-xs text-gray-600 dark:text-gray-300 font-semibold min-w-[60px] flex-shrink-0">Trigger:</span>
              <span class="text-xs text-gray-700 dark:text-gray-300 font-mono">{{ item.eventData.triggerName }}</span>
            </div>
            <div
              v-if="item.eventData.triggerData"
              class="mt-1"
            >
              <UAccordion
                :items="[{
                  label: 'Trigger Data',
                  icon: 'i-lucide-braces',
                  defaultOpen: false,
                  content: item.eventData.triggerData,
                }]"
                :ui="{
                  trigger: 'text-[10px] py-1',
                  leadingIcon: 'size-3 text-purple-500 dark:text-purple-400',
                  label: 'text-[10px]',
                  item: 'border-0 mt-0',
                }"
              >
                <template #content="{ item: accordionItem }">
                  <pre class="text-xs bg-gray-50 dark:bg-gray-800 rounded p-2 overflow-y-auto max-h-60 text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-words">{{ pretty(accordionItem.content) }}</pre>
                </template>
              </UAccordion>
            </div>
            <div
              v-if="item.eventData.duration"
              class="flex items-start gap-2"
            >
              <span class="text-xs text-gray-600 dark:text-gray-300 font-semibold min-w-[60px] flex-shrink-0">Duration:</span>
              <span class="text-xs text-gray-700 dark:text-gray-300">{{ item.eventData.duration }}ms</span>
            </div>
          </div>
        </div>

        <!-- Special rendering for flow events -->
        <div
          v-else-if="isFlowEvent(item.eventType)"
          class="text-sm mt-2"
        >
          <div
            v-if="item.eventData && (item.eventData.input || item.eventData.output || item.eventData.error)"
            class="space-y-1 p-2 rounded border bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700"
          >
            <div
              v-if="item.eventData.input"
              class="mt-1"
            >
              <UAccordion
                :items="[{
                  label: 'Input',
                  icon: 'i-lucide-arrow-down-to-line',
                  defaultOpen: false,
                  content: item.eventData.input,
                }]"
                :ui="{
                  trigger: 'text-[10px] py-1',
                  leadingIcon: 'size-3 text-green-500 dark:text-green-400',
                  label: 'text-[10px]',
                  item: 'border-0 mt-0',
                }"
              >
                <template #content="{ item: accordionItem }">
                  <pre class="text-xs bg-gray-50 dark:bg-gray-800 rounded p-2 overflow-y-auto max-h-60 text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-words">{{ pretty(accordionItem.content) }}</pre>
                </template>
              </UAccordion>
            </div>
            <div
              v-if="item.eventData.output"
              class="mt-1"
            >
              <UAccordion
                :items="[{
                  label: 'Output',
                  icon: 'i-lucide-arrow-up-from-line',
                  defaultOpen: false,
                  content: item.eventData.output,
                }]"
                :ui="{
                  trigger: 'text-[10px] py-1',
                  leadingIcon: 'size-3 text-blue-500 dark:text-blue-400',
                  label: 'text-[10px]',
                  item: 'border-0 mt-0',
                }"
              >
                <template #content="{ item: accordionItem }">
                  <pre class="text-xs bg-gray-50 dark:bg-gray-800 rounded p-2 overflow-y-auto max-h-60 text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-words">{{ pretty(accordionItem.content) }}</pre>
                </template>
              </UAccordion>
            </div>
            <div
              v-if="item.eventData.error"
              class="mt-1"
            >
              <UAccordion
                :items="[{
                  label: 'Error Details',
                  icon: 'i-lucide-alert-circle',
                  defaultOpen: true,
                  content: item.eventData.error,
                }]"
                :ui="{
                  trigger: 'text-[10px] py-1 text-red-600 dark:text-red-400',
                  leadingIcon: 'size-3 text-red-500 dark:text-red-400',
                  label: 'text-[10px]',
                  item: 'border-0 mt-0',
                }"
              >
                <template #content="{ item: accordionItem }">
                  <pre class="text-xs bg-red-50 dark:bg-red-900/20 rounded p-2 overflow-y-auto max-h-60 text-red-700 dark:text-red-300 font-mono whitespace-pre-wrap break-words">{{ pretty(accordionItem.content) }}</pre>
                </template>
              </UAccordion>
            </div>
          </div>
        </div>

        <!-- Special rendering for emit events -->
        <div
          v-else-if="isEmitEvent(item.eventType)"
          class="mt-2"
        >
          <div
            v-if="item.eventData && item.eventData.payload"
            class="p-2 rounded border bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700"
          >
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs text-gray-500 dark:text-gray-400">Event:</span>
              <UBadge
                color="primary"
                variant="solid"
                size="xs"
              >
                {{ item.eventData.name || 'unknown' }}
              </UBadge>
            </div>
            <UAccordion
              v-if="item.eventData.payload"
              :items="[{
                label: 'Payload',
                icon: 'i-lucide-package',
                defaultOpen: false,
                content: item.eventData.payload,
              }]"
              :ui="{
                trigger: 'text-[10px] py-1',
                leadingIcon: 'size-3 text-emerald-500 dark:text-emerald-400',
                label: 'text-[10px]',
                item: 'border-0 mt-0',
              }"
            >
              <template #content="{ item: accordionItem }">
                <pre class="text-xs bg-gray-50 dark:bg-gray-800 rounded p-2 overflow-y-auto max-h-60 text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-words">{{ pretty(accordionItem.content) }}</pre>
              </template>
            </UAccordion>
          </div>
          <div
            v-else-if="item.eventData"
            class="flex items-center gap-2 mt-1"
          >
            <span class="text-xs text-gray-500 dark:text-gray-400">Event:</span>
            <UBadge
              color="primary"
              variant="solid"
              size="xs"
            >
              {{ item.eventData.name || 'unknown' }}
            </UBadge>
          </div>
        </div>

        <!-- Special rendering for stream events -->
        <div
          v-else-if="isStreamEvent(item.eventType)"
          class="mt-2"
        >
          <div class="space-y-2 p-2 rounded border bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-gray-500 dark:text-gray-400">Stream:</span>
              <UBadge
                color="neutral"
                variant="solid"
                size="xs"
                class="font-mono"
              >
                {{ item.eventData?.streamName || 'unknown' }}
              </UBadge>
              <UBadge
                :color="item.eventType === 'stream.delete' ? 'error' : 'primary'"
                variant="subtle"
                size="xs"
              >
                {{ item.eventType === 'stream.delete' ? 'delete' : 'publish' }}
              </UBadge>
            </div>

            <div class="flex flex-wrap gap-2 text-[10px] text-gray-500 dark:text-gray-400">
              <span v-if="item.eventData?.nodeUid" class="rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 font-mono">node {{ item.eventData.nodeUid }}</span>
              <span v-if="item.eventData?.functionId" class="rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 font-mono">fn {{ item.eventData.functionId }}</span>
              <span v-if="item.eventData?.itemId" class="rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 font-mono">item {{ item.eventData.itemId }}</span>
              <span v-if="item.eventData?.runId" class="rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 font-mono">group {{ item.eventData.runId }}</span>
            </div>

            <div v-if="item.eventData?.preview" class="text-xs text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">
              {{ item.eventData.preview }}
            </div>

            <div v-else-if="item.eventData">
              <UAccordion
                :items="[{ label: 'Event Data', icon: 'i-lucide-braces', defaultOpen: false, content: item.eventData }]"
                :ui="{
                  trigger: 'text-[10px] py-1',
                  leadingIcon: 'size-3 text-gray-500 dark:text-gray-400',
                  label: 'text-[10px]',
                  item: 'border-0 mt-1',
                }"
              >
                <template #content="{ item: accordionItem }">
                  <pre class="text-xs bg-gray-50 dark:bg-gray-800 rounded p-2 overflow-y-auto max-h-60 text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-words">{{ pretty(accordionItem.content) }}</pre>
                </template>
              </UAccordion>
            </div>
          </div>
        </div>

        <!-- Default rendering with accordion -->
        <div
          v-else-if="item.eventData && Object.keys(item.eventData).length > 0"
          class="mt-2"
        >
          <UAccordion
            :items="[{
              label: 'Event Data',
              icon: 'i-lucide-braces',
              defaultOpen: false,
              content: item.eventData,
            }]"
            :ui="{
              trigger: 'text-[10px] py-1',
              leadingIcon: 'size-3 text-gray-500 dark:text-gray-400',
              label: 'text-[10px]',
              item: 'border-0 mt-1',
            }"
          >
            <template #content="{ item: accordionItem }">
              <pre class="text-xs bg-gray-50 dark:bg-gray-800 rounded p-2 overflow-y-auto max-h-60 text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-words">{{ pretty(accordionItem.content) }}</pre>
            </template>
          </UAccordion>
        </div>
      </template>
    </UTimeline>
    <div
      v-else
      class="h-full w-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500"
    >
      <UIcon
        name="i-lucide-inbox"
        class="w-12 h-12 mb-3 opacity-50"
      />
      <span class="text-sm">No events yet.</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from '#imports'
import type { TimelineItem } from '@nuxt/ui'

const props = defineProps<{ items: any[], heightClass?: string }>()

const heightClass = computed(() => props.heightClass || 'h-96')

function eventTsMs(e: any): number {
  try {
    const ts = (e as any)?.ts
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts
    if (typeof ts === 'string') {
      const n = Number(ts)
      if (Number.isFinite(n)) return n
      const d = Date.parse(ts)
      if (!Number.isNaN(d)) return d
    }
    if (typeof e?.id === 'string' && e.id.includes('-')) {
      const n = Number(e.id.split('-')[0])
      if (Number.isFinite(n)) return n
    }
  }
  catch {
    // ignore
  }
  return Date.now()
}

function formatTs(e: any) {
  try {
    const t = eventTsMs(e)
    return new Date(t).toLocaleString()
  }
  catch {
    return ''
  }
}

function eventIcon(type: string) {
  if (!type) return 'i-lucide-circle'

  // Flow events
  if (type === 'flow.start') return 'i-lucide-play-circle'
  if (type === 'flow.completed') return 'i-lucide-check-circle-2'
  if (type === 'flow.failed') return 'i-lucide-x-circle'
  if (type === 'flow.cancel') return 'i-lucide-ban'

  // Step events
  if (type === 'step.started' || type === 'step.running') return 'i-lucide-arrow-right-circle'
  if (type === 'step.completed') return 'i-lucide-check-circle'
  if (type === 'step.failed') return 'i-lucide-alert-circle'
  if (type === 'step.retry') return 'i-lucide-rotate-cw'
  if (type === 'step.timeout') return 'i-lucide-clock'

  // Await events
  if (type === 'await.registered') return 'i-lucide-timer'
  if (type === 'await.resolved') return 'i-lucide-check-circle'
  if (type === 'await.timeout') return 'i-lucide-clock-alert'

  // Log events
  if (type === 'log') return 'i-lucide-file-text'

  // Stream events
  if (type === 'stream.publish') return 'i-lucide-waves'
  if (type === 'stream.delete') return 'i-lucide-trash-2'

  // Emit events
  if (type === 'emit') return 'i-lucide-zap'

  // Default
  return 'i-lucide-circle-dot'
}

// Convert raw events to timeline items
const timelineItems = computed(() => {
  const arr = Array.isArray(props.items) ? [...props.items] : []

  // Sort newest first
  arr.sort((a, b) => {
    const tb = eventTsMs(b)
    const ta = eventTsMs(a)
    if (tb !== ta) return tb - ta
    // fallback stable by id string desc
    const ai = String((a as any)?.id || '')
    const bi = String((b as any)?.id || '')
    return bi.localeCompare(ai)
  })

  let previousGroup = ''

  return arr.map((e) => {
    const currentGroup = String(e?.stepName || 'workflow')
    const groupLabel = currentGroup !== previousGroup ? currentGroup : undefined
    previousGroup = currentGroup

    return {
      date: formatTs(e),
      icon: eventIcon(e.type),
      eventType: e.type,
      stepName: e.stepName,
      eventData: e.data,
      groupLabel,
    } as TimelineItem & { eventType: string, stepName?: string, eventData?: any, groupLabel?: string }
  })
})

function shortId(value?: string): string {
  if (!value) return ''
  return value.length > 8 ? value.slice(0, 8) : value
}

function logSurfaceClass(level?: string) {
  switch ((level || '').toLowerCase()) {
    case 'debug':
      return 'bg-slate-50 dark:bg-slate-950/40 border-slate-200 dark:border-slate-800'
    case 'info':
      return 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900/60'
    case 'warn':
      return 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/60'
    case 'error':
      return 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/60'
    default:
      return 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700'
  }
}

function pretty(v: any) {
  try {
    return JSON.stringify(v, null, 2)
  }
  catch {
    return String(v)
  }
}

function levelColor(level?: string) {
  switch ((level || '').toLowerCase()) {
    case 'debug': return 'neutral'
    case 'info': return 'primary'
    case 'warn': return 'warning'
    case 'error': return 'error'
    default: return 'neutral'
  }
}

function eventTypeColor(type: string) {
  if (!type) return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'

  // Flow events
  if (type.startsWith('flow.')) {
    if (type === 'flow.start') return 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300'
    if (type === 'flow.completed') return 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300'
    if (type === 'flow.failed') return 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300'
    return 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300'
  }

  // Step events
  if (type.startsWith('step.')) {
    if (type === 'step.completed') return 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300'
    if (type === 'step.failed') return 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300'
    return 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'
  }

  // Await events
  if (type.startsWith('await.')) {
    if (type === 'await.resolved') return 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300'
    if (type === 'await.timeout') return 'bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300'
    return 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'
  }

  // Log events
  if (type === 'log') return 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300'

  // Stream events
  if (type === 'stream.publish') return 'bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-300'
  if (type === 'stream.delete') return 'bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300'

  // Emit events
  if (type === 'emit') return 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300'

  // Default
  return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
}

function isFlowEvent(type: string) {
  return type?.startsWith('flow.') || type?.startsWith('step.')
}

function isAwaitEvent(type: string) {
  return type?.startsWith('await.')
}

function isEmitEvent(type: string) {
  return type === 'emit'
}

function isStreamEvent(type: string) {
  return type === 'stream.publish' || type === 'stream.delete'
}

function hasMetadata(eventData: any): boolean {
  if (!eventData || typeof eventData !== 'object') return false
  if (eventData.metadata && typeof eventData.metadata === 'object') {
    return Object.keys(eventData.metadata).length > 0
  }
  // Check if there's user-provided metadata beyond the auto-injected fields
  // 'value' is used when the 3rd param is a primitive (boolean, string, number, array)
  const autoInjectedKeys = ['message', 'level', 'msg', 'stepName', 'stepId', 'stepRunId', 'attempt', 'flowName', 'traceId', 'spanId', 'serviceName', 'workflow']
  const keys = Object.keys(eventData).filter(k => !autoInjectedKeys.includes(k))
  return keys.length > 0
}

function prettyMetadata(eventData: any): string {
  if (!eventData || typeof eventData !== 'object') return ''
  if (eventData.metadata && typeof eventData.metadata === 'object') {
    if (Object.keys(eventData.metadata).length === 0) return ''
    if (Object.keys(eventData.metadata).length === 1 && 'value' in eventData.metadata) {
      return pretty(eventData.metadata.value)
    }
    return pretty(eventData.metadata)
  }
  // Filter out message, level, and auto-injected step context fields
  // to show only the user-provided 3rd parameter metadata
  const { message, level, msg, stepName, stepId, stepRunId, attempt, flowName, traceId, spanId, serviceName, workflow, ...metadata } = eventData
  // If the only key is 'value', display the value directly for better UX
  if (Object.keys(metadata).length === 1 && 'value' in metadata) {
    return pretty(metadata.value)
  }
  return pretty(metadata)
}
</script>

<style scoped>
</style>
