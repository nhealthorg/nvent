import { describe, expect, it } from 'vitest'
import { buildComposeArgs } from '../../packages/nvent/src/runtime/nitro/utils/compose'

describe('compose manager arguments', () => {
  it('passes the frozen flag for locked managed startup', () => {
    expect(buildComposeArgs({
      daemonNamespace: 'default',
      engineUrl: '',
      upOnStart: true,
      frozen: true,
      composeFilePath: '/app/.output/nvent/worker-compose.yaml',
    })).toEqual([
      'compose',
      '--namespace',
      'default',
      '--up',
      '--file',
      '/app/.output/nvent/worker-compose.yaml',
      '--frozen',
    ])
  })

  it('does not pass the frozen flag when disabled', () => {
    expect(buildComposeArgs({
      daemonNamespace: 'default',
      engineUrl: '',
      upOnStart: true,
      frozen: false,
      composeFilePath: 'worker-compose.yaml',
    })).not.toContain('--frozen')
  })
})