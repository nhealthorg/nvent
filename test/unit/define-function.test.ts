import { describe, expect, it } from 'vitest'
import { defineFunction } from '../../packages/nvent/src/runtime/nitro/utils/defineFunction'
import { normalizeModuleToFnInfo } from '../../packages/nvent/src/runtime/nitro/utils/workers/node'

describe('defineFunction trigger namespace validation', () => {
  it('allows builtin triggers without trigger_namespace', () => {
    expect(() => defineFunction({
      triggers: [{ type: 'http', config: { api_path: '/health', http_method: 'GET' } }],
      handler: async () => ({ ok: true }),
    })).not.toThrow()
  })

  it('accepts plain http function config without hook fields', () => {
    const fn = defineFunction({
      description: 'Returns a greeting message',
      triggers: [
        { type: 'http', config: { api_path: 'greet', http_method: 'GET', input: { name: 'string' } } },
      ],
      handler: async (req) => {
        const name = (req as any).query_params?.name ?? 'world'
        return { message: `Hello, ${name}!` }
      },
    })

    expect(fn.description).toBe('Returns a greeting message')
    expect(fn.triggers?.[0]?.type).toBe('http')
  })

  it('allows builtin triggers with trigger_namespace=default', () => {
    expect(() => defineFunction({
      triggers: [{ type: 'stream', trigger_namespace: 'default', config: { id: 'events' } }],
      handler: async () => ({ ok: true }),
    })).not.toThrow()
  })

  it('rejects builtin triggers with non-default trigger_namespace', () => {
    expect(() => defineFunction({
      triggers: [{ type: 'cron', trigger_namespace: 'workflows', config: { expression: '*/5 * * * *' } }],
      handler: async () => ({ ok: true }),
    })).toThrow(/must use trigger_namespace='default'/)
  })

  it('requires trigger_namespace for custom trigger types', () => {
    expect(() => defineFunction({
      triggers: [{ type: 'kafka', config: { topic: 'orders' } }],
      handler: async () => ({ ok: true }),
    })).toThrow(/requires trigger_namespace/)
  })

  it('accepts custom trigger types with explicit trigger_namespace', () => {
    expect(() => defineFunction({
      triggers: [{ type: 'kafka', trigger_namespace: 'infra', config: { topic: 'orders' } }],
      handler: async () => ({ ok: true }),
    })).not.toThrow()
  })

  it('keeps trigger_namespace when normalizing module definitions', () => {
    const def = defineFunction({
      triggers: [{ type: 'kafka', trigger_namespace: 'infra', config: { topic: 'orders' } }],
      handler: async () => ({ ok: true }),
    })

    const normalized = normalizeModuleToFnInfo({ default: def }, 'orders::ingest', '/tmp/orders.ts')

    expect(normalized?.triggers[0]?.trigger_namespace).toBe('infra')
  })
})
