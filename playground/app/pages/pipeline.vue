<template>
  <div class="min-h-screen bg-gray-950 text-gray-100 p-8">
    <div class="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 class="text-2xl font-semibold mb-1">
          Workflow Stream Demo
        </h1>
        <p class="text-gray-400 text-sm">
          Start a workflow run and subscribe to nworkflow live events sent from workflow nodes.
        </p>
      </div>

      <!-- Input -->
      <div class="space-y-2">
        <label class="block text-sm text-gray-300">Input text</label>
        <textarea
          v-model="text"
          rows="5"
          placeholder="Type or paste any text…"
          class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <button
          :disabled="runPending || !text.trim()"
          class="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
          @click="startRun"
        >
          {{ runPending ? 'Starting…' : 'Start Workflow' }}
        </button>
      </div>

      <!-- Stream info badge -->
      <div v-if="runId" class="text-xs text-gray-500 font-mono">
        run: {{ runId }}
        <span
          :class="{
            'text-yellow-400': streamStatus === 'connecting',
            'text-green-400': streamStatus === 'connected',
            'text-gray-500': streamStatus === 'closed',
            'text-red-400': streamStatus === 'error',
          }"
          class="ml-2"
        >
          ● {{ streamStatus }}
        </span>
      </div>

      <!-- Live phase events -->
      <div v-if="phaseEvents.length" class="space-y-2">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Phase Events
        </h2>
        <ul class="space-y-1">
          <li
            v-for="(item, idx) in phaseEvents"
            :key="`phase-${idx}`"
            class="flex items-center gap-3 bg-gray-900 rounded-lg px-4 py-2 text-sm"
          >
            <span class="text-cyan-400 font-mono text-xs shrink-0">
              {{ item.step }}
            </span>
            <span class="text-gray-200">{{ item.status }}</span>
            <span v-if="item.count != null" class="ml-auto text-gray-100 font-mono text-xs">{{ item.count }}</span>
          </li>
        </ul>
      </div>

      <!-- Live progress events -->
      <div v-if="progressEvents.length" class="space-y-2">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Progress Events
        </h2>
        <ul class="space-y-1">
          <li
            v-for="(item, idx) in progressEvents"
            :key="`progress-${idx}`"
            class="flex items-center gap-3 bg-gray-900 rounded-lg px-4 py-2 text-sm"
          >
            <span class="text-indigo-400 font-mono text-xs shrink-0">
              progress
            </span>
            <span class="text-gray-200">{{ item.message }}</span>
            <span class="ml-auto text-green-400 text-xs">✓</span>
          </li>
        </ul>
      </div>

      <!-- Count events -->
      <div v-if="countEvents.length" class="space-y-2">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Count Events
        </h2>
        <ul class="space-y-1">
          <li
            v-for="(item, idx) in countEvents"
            :key="`count-${idx}`"
            class="flex items-center gap-3 bg-gray-900 rounded-lg px-4 py-2 text-sm"
          >
            <span class="text-indigo-400 font-mono text-xs shrink-0">
              count
            </span>
            <span class="text-gray-200">{{ item.message }}</span>
            <span class="ml-auto text-gray-100 font-mono text-xs">{{ item.count }}</span>
          </li>
        </ul>
      </div>

      <!-- Summary events -->
      <div v-if="summaryEvents.length" class="space-y-2">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Summary Events
        </h2>
        <ul class="space-y-1">
          <li
            v-for="(item, idx) in summaryEvents"
            :key="`summary-${idx}`"
            class="flex items-center gap-3 bg-gray-900 rounded-lg px-4 py-2 text-sm"
          >
            <span class="text-amber-400 font-mono text-xs shrink-0">
              summary
            </span>
            <span class="text-gray-200">finalCount={{ item.finalCount }}</span>
            <span class="ml-auto text-gray-400 text-xs">hasResult={{ item.hasResult ? 'yes' : 'no' }}</span>
          </li>
        </ul>
      </div>

      <!-- Event timeline -->
      <div v-if="timeline.length" class="space-y-2">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Timeline
        </h2>
        <ul class="space-y-1">
          <li
            v-for="(item, idx) in timeline"
            :key="`timeline-${idx}`"
            class="bg-gray-900 rounded-lg px-4 py-2 text-sm"
          >
            <span class="text-indigo-300 font-mono text-xs">{{ item.type }}</span>
            <span class="text-gray-300"> · {{ timelineLabel(item.data) }}</span>
          </li>
        </ul>
      </div>

      <div v-if="agentEvents.length" class="space-y-2">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Agent Part (namespaced)
        </h2>
        <ul class="space-y-1">
          <li
            v-for="(item, idx) in agentEvents"
            :key="`agent-${idx}`"
            class="bg-gray-900 rounded-lg px-4 py-2 text-sm"
          >
            <span class="text-teal-300 font-mono text-xs">{{ item.type }}</span>
            <span class="text-gray-300"> · {{ timelineLabel(item.data) }}</span>
          </li>
        </ul>
      </div>

      <div class="bg-gray-900 border border-gray-700 rounded-lg p-4 text-xs text-gray-300">
        This demo starts workflow <span class="font-mono">test-wf</span>. Live status is delivered from the canonical nworkflow stream via <span class="font-mono">ctx.workflow.stream.send(type, data)</span>; UI sections can subscribe by event type or namespaced part.
      </div>

      <!-- Error -->
      <div v-if="runError" class="bg-red-950 border border-red-700 rounded-lg px-4 py-3 text-sm text-red-300">
        {{ runError.message }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useWorkflow } from '#imports'
import { useWorkflowStream } from '#imports'

interface ProgressEvent {
  message: string
}

interface CountEvent {
  message: string
  count: number
}

interface PhaseEvent {
  step: string
  status: string
  count?: number
}

interface SummaryEvent {
  finalCount: number
  hasResult: boolean
}

const text = ref('')
const runId = ref<string | null>(null)
const runPending = ref(false)
const runError = ref<Error | null>(null)

const workflow = useWorkflow()
const stream = useWorkflowStream()

const streamStatus = stream.status
const phaseEvents = stream.listen<PhaseEvent>('phase')
const progressEvents = stream.listen<ProgressEvent>('progress')
const countEvents = stream.listen<CountEvent>('count')
const summaryEvents = stream.listen<SummaryEvent>('summary')
const agentEvents = stream.listenPart<Record<string, unknown>>('agents')
const timeline = computed(() => stream.events.value)

async function startRun() {
  runPending.value = true
  runError.value = null
  try {
    const started = await workflow.run('test-wf', { text: text.value })
    runId.value = started.run_id
    stream.subscribe(started.stream)
  }
  catch (e) {
    runError.value = e as Error
  }
  finally {
    runPending.value = false
  }
}

function timelineLabel(data: unknown): string {
  if (!data || typeof data !== 'object') return String(data ?? '')
  const d = data as Record<string, unknown>
  if (typeof d.message === 'string') return d.message
  if (typeof d.step === 'string' && typeof d.status === 'string') return `${d.step}:${d.status}`
  if (typeof d.finalCount === 'number') return `finalCount=${d.finalCount}`
  return JSON.stringify(d)
}
</script>

