<template>
  <div class="min-h-screen bg-gray-950 text-gray-100 p-8">
    <div class="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 class="text-2xl font-semibold mb-1">
          Pipeline Demo
        </h1>
        <p class="text-gray-400 text-sm">
          Submit text, get a stream group ID, then subscribe via WebSocket to watch real-time progress.
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
          :disabled="callPending || !text.trim()"
          class="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
          @click="analyze"
        >
          {{ callPending ? 'Starting…' : 'Analyze' }}
        </button>
      </div>

      <!-- Stream info badge -->
      <div v-if="groupId" class="text-xs text-gray-500 font-mono">
        stream: pipeline / {{ groupId }}
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

      <!-- Live steps -->
      <div v-if="steps.length" class="space-y-2">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Progress
        </h2>
        <ul class="space-y-1">
          <li
            v-for="step in steps"
            :key="step.step"
            class="flex items-center gap-3 bg-gray-900 rounded-lg px-4 py-2 text-sm"
          >
            <span class="text-indigo-400 font-mono text-xs w-12 shrink-0">
              {{ step.step }}/{{ step.total }}
            </span>
            <span class="text-gray-200">{{ step.label }}</span>
            <span class="ml-auto text-green-400 text-xs">✓</span>
          </li>
        </ul>
      </div>

      <!-- Results panel -->
      <div v-if="result" class="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-3">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Results
        </h2>
        <dl class="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <template
            v-for="(val, key) in result"
            :key="key"
          >
            <dt class="text-gray-400">
              {{ humanKey(String(key)) }}
            </dt>
            <dd class="text-gray-100 font-mono">
              {{ val }}
            </dd>
          </template>
        </dl>
      </div>

      <!-- Error -->
      <div v-if="callError" class="bg-red-950 border border-red-700 rounded-lg px-4 py-3 text-sm text-red-300">
        {{ callError.message }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface StepMessage {
  step: number
  total: number
  label: string
  data: unknown
}

interface ResultMessage extends Record<string, unknown> {
  done: true
}

type StreamMessage = StepMessage | ResultMessage

const text = ref('')
const groupId = ref<string | null>(null)
const steps = ref<StepMessage[]>([])
const result = ref<Record<string, unknown> | null>(null)

const { call, pending: callPending, error: callError } = useFunctionCall<
  { text: string },
  { streamName: string; groupId: string }
>('pipeline/start')

const { messages, status: streamStatus, subscribe } = useNventStream<StreamMessage>()

// Process incoming WebSocket messages as new items appear in the stream group.
watch(messages, (all) => {
  steps.value = []
  result.value = null
  for (const msg of all) {
    if ('done' in msg && msg.done) {
      const { done: _done, ...stats } = msg as ResultMessage
      result.value = stats
    }
    else if ('step' in msg) {
      steps.value.push(msg as StepMessage)
    }
  }
})

async function analyze() {
  steps.value = []
  result.value = null
  groupId.value = null

  const res = await call({ text: text.value })
  groupId.value = res.groupId
  subscribe(res.streamName, res.groupId)
}

function humanKey(key: string) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())
}
</script>

