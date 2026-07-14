<template>
  <USlideover
    v-model:open="isOpen"
    title="Trigger Workflow"
    :description="workflow?.id"
  >
    <template #content>
      <div class="p-6 flex flex-col h-full bg-white dark:bg-zinc-950">
        <div class="flex items-center gap-4 mb-8">
          <div class="w-12 h-12 rounded-xl bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center text-orange-600 dark:text-orange-400">
            <UIcon name="i-lucide-zap" class="w-6 h-6" />
          </div>
          <div>
            <h3 class="text-lg font-bold text-zinc-900 dark:text-white">{{ workflow?.id }}</h3>
            <p class="text-sm text-zinc-500 dark:text-zinc-400">{{ workflow?.description || 'Manual trigger execution' }}</p>
          </div>
        </div>

        <!-- Input Form -->
        <div class="flex-1 overflow-y-auto space-y-6">
          <div v-if="hasSchema" class="space-y-4">
            <h4 class="text-xs font-bold text-zinc-400 uppercase tracking-wider">Input Configuration</h4>
            
            <div v-for="(field, key) in inputSchema" :key="key" class="space-y-1.5">
              <UFormField :label="String(key)">
                <template #hint v-if="field.type">
                  <span class="text-[10px] text-zinc-500 font-mono">{{ field.type }}</span>
                </template>
                
                <UInput
                  v-if="field.type === 'string' || !field.type"
                  v-model="payload[key]"
                  :placeholder="field.description || `Enter ${key}...`"
                  class="w-full"
                />
                
                <UInput
                  v-else-if="field.type === 'number'"
                  type="number"
                  v-model.number="payload[key]"
                  class="w-full"
                />
                
                <UCheckbox
                  v-else-if="field.type === 'boolean'"
                  v-model="payload[key]"
                  :label="field.description || 'Enable'"
                />
                
                <UTextarea
                  v-else-if="field.type === 'text'"
                  v-model="payload[key]"
                  :rows="4"
                  class="w-full"
                />
                
                <template #description v-if="field.description">
                  {{ field.description }}
                </template>
              </UFormField>
            </div>
          </div>

          <div v-else class="space-y-4">
            <div class="flex items-center justify-between">
              <h4 class="text-xs font-bold text-zinc-400 uppercase tracking-wider">JSON Input</h4>
              <UButton 
                size="xs" 
                variant="ghost" 
                color="neutral" 
                icon="i-lucide-braces"
                @click="payloadString = JSON.stringify(payload, null, 2)"
              >
                Prettify
              </UButton>
            </div>
            <UTextarea
              v-model="payloadString"
              :rows="12"
              class="font-mono text-xs w-full"
              placeholder="{ 'key': 'value' }"
              @blur="validateJson"
            />
            <p v-if="jsonError" class="text-xs text-red-500 font-medium">{{ jsonError }}</p>
          </div>
        </div>

        <!-- Action Footer -->
        <div class="pt-6 border-t border-zinc-200 dark:border-zinc-800 mt-auto flex items-center justify-between gap-3">
          <UButton 
            color="neutral" 
            variant="outline" 
            @click="isOpen = false"
            label="Cancel"
          />
          <UButton
            color="primary"
            icon="i-lucide-play"
            :loading="loading"
            label="Run Workflow"
            @click="handleTrigger"
          />
        </div>
      </div>
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'

const props = defineProps<{
  modelValue: boolean
  workflow: any
}>()

const emit = defineEmits(['update:modelValue', 'triggered'])

const isOpen = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

const loading = ref(false)
const payload = ref<Record<string, any>>({})
const payloadString = ref('{}')
const jsonError = ref<string | null>(null)

const hasSchema = computed(() => props.workflow?.request_format && Object.keys(props.workflow.request_format).length > 0)
const inputSchema = computed(() => props.workflow?.request_format || {})

// Initialize payload based on schema or empty
watch(() => props.workflow, (newWf) => {
  if (newWf) {
    const initial: any = {}
    if (newWf.request_format) {
      Object.entries(newWf.request_format).forEach(([key, spec]: [string, any]) => {
        initial[key] = spec.default !== undefined ? spec.default : (spec.type === 'boolean' ? false : '')
      })
    }
    payload.value = initial
    payloadString.value = JSON.stringify(initial, null, 2)
  }
}, { immediate: true })

function validateJson() {
  try {
    const parsed = JSON.parse(payloadString.value)
    payload.value = parsed
    jsonError.value = null
    return true
  } catch (e: any) {
    jsonError.value = `Invalid JSON: ${e.message}`
    return false
  }
}

async function handleTrigger() {
  if (!hasSchema.value && !validateJson()) return
  
  loading.value = true
  try {
    const finalPayload = hasSchema.value ? payload.value : JSON.parse(payloadString.value)
    
    // We call our new trigger endpoint
    const result: any = await $fetch('/api/_workflows/trigger', {
      method: 'POST',
      body: {
        workflowId: props.workflow.id,
        input: finalPayload
      }
    })
    
    emit('triggered', { workflowId: props.workflow.id, runId: result.run_id || result.invocation_id })
    isOpen.value = false
  } catch (e: any) {
    console.error('Failed to trigger workflow:', e)
  } finally {
    loading.value = false
  }
}
</script>
