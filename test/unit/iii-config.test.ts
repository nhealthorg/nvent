import { describe, expect, it } from 'vitest'
import { generateIiiConfigYaml } from '../../packages/nvent/src/iii/config'

describe('iii queue configuration', () => {
  it('does not emit durable queue configs for Redis', () => {
    const yaml = generateIiiConfigYaml({
      wsPort: 49134,
      httpPort: 3111,
      streamPort: 3112,
      modules: { queue: true },
      queue: {
        adapter: { name: 'redis', config: { redis_url: 'redis://localhost:6379' } },
        queue_configs: { default: { type: 'standard', concurrency: 1 } },
      },
    })

    expect(yaml).toContain('name: redis')
    expect(yaml).not.toContain('queue_configs:')
  })

  it('emits durable queue configs for builtin storage', () => {
    const yaml = generateIiiConfigYaml({
      wsPort: 49134,
      httpPort: 3111,
      streamPort: 3112,
      modules: { queue: true },
      queue: {
        adapter: { name: 'builtin' },
        queue_configs: { default: { type: 'standard', concurrency: 1 } },
      },
    })

    expect(yaml).toContain('queue_configs:')
  })
})