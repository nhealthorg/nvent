import { describe, expect, it } from 'vitest'
import { resolveComposeEngineAdvanced } from '../../packages/nvent/src/iii/compose-advanced'

describe('compose engine advanced whitelist', () => {
  it('accepts supported fields and worker names', () => {
    const resolved = resolveComposeEngineAdvanced({
      startupTimeout: '75s',
      stopTimeout: '15s',
      workers: {
        'iii-stream': { port: 3112, auth_function: 'auth::stream' },
        'iii-worker-manager': { host: '127.0.0.1' },
      },
    })

    expect(resolved.startupTimeout).toBe('75s')
    expect(resolved.stopTimeout).toBe('15s')
    expect(resolved.workers?.['iii-stream']).toEqual({ port: 3112, auth_function: 'auth::stream' })
  })

  it('rejects unknown top-level compose.engine fields', () => {
    expect(() => resolveComposeEngineAdvanced({
      startupTimeout: '60s',
      unknownField: true,
    })).toThrow(/Unsupported nvent\.iii\.compose\.engine field/)
  })

  it('rejects unknown worker names', () => {
    expect(() => resolveComposeEngineAdvanced({
      workers: {
        kafka: { topic: 'orders' },
      },
    })).toThrow(/Unsupported nvent\.iii\.compose\.engine\.workers field/)
  })

  it('rejects non-object worker override values', () => {
    expect(() => resolveComposeEngineAdvanced({
      workers: {
        'iii-stream': 'bad',
      },
    })).toThrow(/must be an object/)
  })
})
