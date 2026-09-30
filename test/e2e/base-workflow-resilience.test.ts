import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type RunStatus = {
  status?: string
  result?: unknown
}

type StartedRun = {
  run_id?: string
  runId?: string
}

const waitForTerminal = async (runId: string): Promise<RunStatus> => {
  let status: RunStatus = {}
  for (let attempt = 0; attempt < 80; attempt++) {
    status = await $fetch<RunStatus>(`/api/test/workflow-resilience/status/${runId}`)
    if (status.status === 'completed' || status.status === 'failed') return status
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return status
}

const startRun = async (patientId: string): Promise<StartedRun> => {
  let lastError: unknown
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      return await $fetch<StartedRun>('/api/test/cohort-pipeline', {
        method: 'POST',
        body: { patientId },
      })
    }
    catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  throw lastError
}

describe('workflow resilience', async () => {
  await setup({
    rootDir: resolve(process.cwd(), 'test/fixtures/base'),
    server: true,
  })

  it('completes a workflow from a fresh worker boot without manual recovery', async () => {
    const started = await startRun(`resilience-boot-${Date.now()}`)
    const runId = started.run_id || started.runId
    expect(runId).toEqual(expect.any(String))

    const status = await waitForTerminal(runId as string)
    expect(status.status).toBe('completed')
  }, 120000)

  it('recovers a running workflow when sweep is explicitly re-driven', async () => {
    const started = await startRun(`resilience-sweep-${Date.now()}`)
    const runId = started.run_id || started.runId
    expect(runId).toEqual(expect.any(String))

    await $fetch('/api/test/workflow-resilience/recover', { method: 'POST' })

    const status = await waitForTerminal(runId as string)
    expect(status.status).toBe('completed')
  }, 120000)

  it('keeps progress when a sweep runs before node completion is delivered', async () => {
    const started = await startRun(`resilience-delayed-${Date.now()}`)
    const runId = started.run_id || started.runId
    expect(runId).toEqual(expect.any(String))

    await new Promise(resolve => setTimeout(resolve, 250))
    await $fetch('/api/test/workflow-resilience/recover', { method: 'POST' })

    const status = await waitForTerminal(runId as string)
    expect(status.status).toBe('completed')
  }, 120000)

  it('ignores duplicate completion events after a run is terminal', async () => {
    const started = await startRun(`resilience-duplicate-${Date.now()}`)
    const runId = started.run_id || started.runId
    expect(runId).toEqual(expect.any(String))

    const before = await waitForTerminal(runId as string)
    expect(before.status).toBe('completed')

    await $fetch('/api/test/workflow-resilience/replay-completion', {
      method: 'POST',
      body: {
        run_id: runId,
        node_uid: 'load-records',
        attempt: 0,
        result: { replayed: true },
      },
    })

    const after = await $fetch<RunStatus>(`/api/test/workflow-resilience/status/${runId}`)
    expect(after.status).toBe('completed')
    expect(after.result).toEqual(before.result)
  }, 120000)
})
