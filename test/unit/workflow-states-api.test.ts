import { describe, expect, it, vi } from 'vitest'

vi.mock('#imports', () => ({
  createError: (value: any) => value,
  defineEventHandler: (handler: any) => handler,
  getQuery: () => ({}),
  useIii: () => ({ trigger: vi.fn() }),
}))

import { normalizeStateItems } from '../../packages/app/src/runtime/server/api/_workflows/states.get'

describe('normalizeStateItems', () => {
  it('accepts raw state arrays', () => {
    const states = normalizeStateItems([
      { key: 'count', value: 2 },
      { key: 'lastProcessed', value: '2026-07-20T10:00:00.000Z' },
    ])

    expect(states).toEqual([
      { key: 'count', value: 2 },
      { key: 'lastProcessed', value: '2026-07-20T10:00:00.000Z' },
    ])
  })

  it('accepts wrapped state payloads', () => {
    const states = normalizeStateItems({
      states: [
        { key: 'count', value: 2 },
        { key: 'lastProcessed', value: '2026-07-20T10:00:00.000Z' },
      ],
    })

    expect(states.map(item => item.key)).toEqual(['count', 'lastProcessed'])
    expect(states[0]?.value).toBe(2)
  })

  it('unwraps map-shaped responses', () => {
    const states = normalizeStateItems({
      'r_1:count': 3,
      'r_1:lastProcessed': '2026-07-20T10:00:00.000Z',
    })

    expect(states).toEqual([
      { key: 'r_1:count', value: 3 },
      { key: 'r_1:lastProcessed', value: '2026-07-20T10:00:00.000Z' },
    ])
  })
})
