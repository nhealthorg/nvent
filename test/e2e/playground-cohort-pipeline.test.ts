import { $fetch } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

describe('playground cohort pipeline', () => {
  async function runPipeline(patientId: string) {
    const started = await $fetch<{ run_id?: string, runId?: string }>('/api/test/cohort-pipeline', {
      method: 'POST',
      body: { patientId },
    })
    const runId = started.run_id || started.runId
    expect(runId).toEqual(expect.any(String))

    let status: any
    for (let attempt = 0; attempt < 30; attempt++) {
      status = await $fetch(`/api/test/cohort-pipeline/${runId}`)
      if (status?.status === 'completed' || status?.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    return status
  }

  it('runs child workflows and reduces parameter results after the baseline branch', async () => {
    const status = await runPipeline('patient-e2e')

    expect(status?.status).toBe('completed')
    expect(status?.result?.status).toBe('completed')
    expect(status?.result?.patient_id).toBe('patient-e2e')
    expect(status?.result?.baseline?.value).toBe('2024-01-15')
    expect(status?.result?.results).toHaveLength(2)
    expect(status?.result?.provenance?.steps).toEqual([
      'load-records',
      'resolve-baseline',
      'if-baseline-status',
      'parameter-extraction',
      'append-result',
      'build-snapshot',
    ])
  })

  it('takes the else branch when no baseline is available', async () => {
    const status = await runPipeline('patient-missing-baseline')

    expect(status?.status).toBe('completed')
    expect(status?.result?.status).toBe('skipped')
    expect(status?.result?.baseline?.status).toBe('missing')
    expect(status?.result?.results).toEqual([])
  })
})
