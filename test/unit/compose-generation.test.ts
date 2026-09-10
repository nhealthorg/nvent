import { describe, expect, it } from 'vitest'
import { generateWorkerComposeYaml } from '../../packages/nvent/src/iii/compose'

function makeBaseOptions() {
  return {
    nventVersion: '1.0.2',
    iiiVersion: 'iii/v0.23.0',
    daemonNamespace: 'default',
    projectNamespace: 'default',
    engineUrl: 'ws://localhost:49134',
    wsPort: 49134,
    streamPort: 3112,
    includeState: true,
    includeQueue: true,
    includeCron: true,
    includePubsub: false,
    includeHttp: false,
    includeStream: true,
    includeConsole: true,
  } as const
}

describe('compose generation package versions', () => {
  it('uses latest for package workers by default', () => {
    const yaml = generateWorkerComposeYaml(makeBaseOptions())

    expect(yaml).toContain('worker: package://api.workers.iii.dev/state')
    expect(yaml).toContain('worker: package://api.workers.iii.dev/queue')
    expect(yaml).toContain('worker: package://api.workers.iii.dev/cron')
    expect(yaml).toContain('worker: package://api.workers.iii.dev/console')
    expect(yaml).toContain('version: latest')
    expect(yaml).not.toContain('version: 0.23.0')
  })

  it('applies explicit compose packageVersions map', () => {
    const yaml = generateWorkerComposeYaml({
      ...makeBaseOptions(),
      packageVersions: {
        state: '1.2.3',
        queue: 'v2.0.0',
        cron: 'iii/v3.1.4',
        console: 'latest',
      },
    })

    expect(yaml).toContain('state:\n    worker: package://api.workers.iii.dev/state\n    version: 1.2.3')
    expect(yaml).toContain('queue:\n    worker: package://api.workers.iii.dev/queue\n    version: 2.0.0')
    expect(yaml).toContain('cron:\n    worker: package://api.workers.iii.dev/cron\n    version: 3.1.4')
    expect(yaml).toContain('console:\n    worker: package://api.workers.iii.dev/console\n    version: latest')
  })
})
