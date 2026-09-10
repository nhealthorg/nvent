import { useIii } from './useIii'
import { useNuxtApp } from '#imports'
import type { WorkflowStreamSubscription } from './useWorkflowStream'
import type { WorkflowRunResultResponse, WorkflowStatusResponse } from '../../nitro/utils/workflow-types'

export interface WorkflowRunHandle {
  run_id: string
  stream: WorkflowStreamSubscription
  raw: unknown
}

export interface WorkflowStatusOptions {
  include_result?: boolean
}

function waitForIiiConnected(
  iii: ReturnType<typeof useIii>,
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe: () => void = () => {}

    const finalize = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      unsubscribe()
      fn()
    }

    const timeoutId = setTimeout(() => {
      finalize(() => reject(new Error('[nvent] iii browser connection timeout. Check /_iii/browser WebSocket and RBAC auth.')))
    }, timeoutMs)

    unsubscribe = iii.addConnectionStateListener((state) => {
      if (state === 'connected') {
        finalize(resolve)
      }
      else if (state === 'failed') {
        finalize(() => reject(new Error('[nvent] iii browser connection failed. Check engine/browser worker status.')))
      }
    })
  })
}

async function resolveConnectedIii(attempts = 2): Promise<ReturnType<typeof useIii>> {
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const iii = useIii()

    try {
      await waitForIiiConnected(iii)
      return iii
    }
    catch (error) {
      lastError = error

      if (attempt >= attempts) break

      const nuxtApp = useNuxtApp() as unknown as {
        $resetIii?: (reason?: string) => Promise<unknown>
        $iiiManager?: { resetIii?: (reason?: string) => Promise<unknown> }
      }

      const reset = nuxtApp.$iiiManager?.resetIii ?? nuxtApp.$resetIii
      if (typeof reset === 'function') {
        await reset(`connect-attempt-${attempt}`)
        continue
      }

      break
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('[nvent] iii browser connection failed to recover.')
}

export function useWorkflow() {
  /**
   * Start a workflow run by its ID (e.g. 'pipeline/analyze').
   * Returns a handle including the run ID and stream subscription info.
   */
  async function run<TInput = unknown>(workflowId: string, input: TInput): Promise<WorkflowRunHandle> {
    const iii = await resolveConnectedIii(2)
    const res = await iii.trigger({
      function_id: workflowId,
      payload: input,
      timeoutMs: 15_000,
    })

    const body = res && typeof res === 'object' && 'body' in (res as Record<string, unknown>)
      ? (res as Record<string, unknown>).body
      : res
    const candidate = (body && typeof body === 'object' ? body : res) as Record<string, unknown> | null

    const runId = (
      candidate?.run_id
      ?? candidate?.runId
      ?? candidate?.id
    )

    if (typeof runId !== 'string' || !runId) {
      throw new Error(`Workflow '${workflowId}' failed to start: no run_id returned`)
    }

    const streamValue = candidate?.stream
    const stream = (
      streamValue
      && typeof streamValue === 'object'
      && typeof (streamValue as Record<string, unknown>).streamName === 'string'
      && typeof (streamValue as Record<string, unknown>).groupId === 'string'
    )
      ? {
          streamName: (streamValue as Record<string, unknown>).streamName as string,
          groupId: (streamValue as Record<string, unknown>).groupId as string,
        }
      : {
          streamName: 'nworkflow',
          groupId: runId,
        }

    return {
      run_id: runId,
      stream,
      raw: res,
    }
  }

  async function status(runId: string, options: WorkflowStatusOptions = {}): Promise<WorkflowStatusResponse | null> {
    const iii = await resolveConnectedIii(2)
    const res = await iii.trigger({
      function_id: 'nworkflow::status',
      payload: {
        run_id: runId,
        include_result: options.include_result ?? true,
      },
      timeoutMs: 15_000,
    })

    const body = res && typeof res === 'object' && 'body' in (res as Record<string, unknown>)
      ? (res as Record<string, unknown>).body
      : res

    if (body == null) return null
    return body as WorkflowStatusResponse
  }

  async function runResult(runId: string): Promise<WorkflowRunResultResponse> {
    const iii = await resolveConnectedIii(2)
    const res = await iii.trigger({
      function_id: 'nworkflow::run-result',
      payload: { run_id: runId },
      timeoutMs: 15_000,
    })

    const body = res && typeof res === 'object' && 'body' in (res as Record<string, unknown>)
      ? (res as Record<string, unknown>).body
      : res

    if (body && typeof body === 'object' && 'result' in (body as Record<string, unknown>)) {
      return body as WorkflowRunResultResponse
    }

    return { result: null }
  }

  return {
    run,
    status,
    runResult,
  }
}
