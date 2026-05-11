import { describe, it, expect } from 'vitest'

import { mergeExtendedQueueConfigs } from '../../packages/nvent/src/iii/extendedQueues'
import { buildEngineConfig } from '../../packages/nvent/src/iii/config'

describe('extended queue registration', () => {
  it('merges extended queues and keeps first definition on duplicates', () => {
    const merged = mergeExtendedQueueConfigs(
      {
        existing: { concurrency: 2 },
      },
      [
        { name: 'fhir-terminology-import', concurrency: 1, maxRetries: 5 },
        { name: 'fhir-terminology-import', concurrency: 9 },
      ],
    )

    expect(merged.queueConfigs.existing?.concurrency).toBe(2)
    expect(merged.queueConfigs['fhir-terminology-import']?.concurrency).toBe(1)
    expect(merged.queueConfigs['fhir-terminology-import']?.maxRetries).toBe(5)
    expect(merged.duplicates).toEqual(['fhir-terminology-import'])
  })

  it('passes merged queue definitions to engine config queue_configs', () => {
    const merged = mergeExtendedQueueConfigs(undefined, [
      {
        name: 'fhir-terminology-import',
        concurrency: 1,
        retries: 3,
        backoff: 250,
        visibilityTimeoutMs: 30000,
        leaseTimeoutMs: 30000,
        deadLetterQueue: 'fhir-terminology-import-dlq',
      },
    ])

    const cfg = buildEngineConfig(
      {
        modules: { queue: true },
      },
      merged.queueConfigs,
    )

    const queueCfg = cfg.queue?.queue_configs?.['fhir-terminology-import']
    expect(queueCfg).toBeDefined()
    expect(queueCfg?.concurrency).toBe(1)
    expect(queueCfg?.max_retries).toBe(3)
    expect(queueCfg?.backoff_ms).toBe(250)
    expect(queueCfg?.visibility_timeout_ms).toBe(30000)
    expect(queueCfg?.lease_timeout_ms).toBe(30000)
    expect(queueCfg?.dead_letter_queue).toBe('fhir-terminology-import-dlq')
  })
})
