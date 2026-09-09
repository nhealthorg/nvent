import { describe, expect, it } from 'vitest'
import { resolveNamespaceSettings, resolveNamespaceMap } from '../../packages/nvent/src/iii/namespace'

describe('nvent namespace config', () => {
  it('uses a single default namespace for all roles', () => {
    const result = resolveNamespaceSettings({ mode: 'single', default: 'default' })

    expect(result.mode).toBe('single')
    expect(result.defaultNamespace).toBe('default')
    expect(result.map).toEqual({
      app: 'default',
      workflows: 'default',
      browser: 'default',
      compose: 'default',
    })
    expect(result.daemonNamespace).toBe('default')
    expect(result.projectNamespace).toBe('default')
  })

  it('keeps mapped namespaces explicit per role', () => {
    const result = resolveNamespaceSettings({
      mode: 'mapped',
      default: 'default',
      map: {
        app: 'app',
        workflows: 'workflows',
        browser: 'browser',
        compose: 'compose',
      },
    })

    expect(result.mode).toBe('mapped')
    expect(result.map).toEqual({
      app: 'app',
      workflows: 'workflows',
      browser: 'browser',
      compose: 'compose',
    })
    expect(result.daemonNamespace).toBe('default')
    expect(result.projectNamespace).toBe('compose')
  })

  it('falls back to the default namespace when a mapped role is empty', () => {
    const result = resolveNamespaceSettings({
      mode: 'mapped',
      default: 'shared',
      map: { app: '', workflows: 'workflows', browser: '', compose: 'compose' },
    })

    expect(result.map).toEqual({
      app: 'shared',
      workflows: 'workflows',
      browser: 'shared',
      compose: 'compose',
    })
  })

  it('rejects unsupported namespace modes', () => {
    expect(() => resolveNamespaceSettings({ mode: 'invalid' as any, default: 'default' })).toThrow(/Unsupported namespace mode/)
  })

  it('resolves the namespace map without mutating the original config', () => {
    const input = { mode: 'mapped', default: 'default', map: { app: 'app' } }
    const value = resolveNamespaceMap(input)

    expect(value).toEqual({
      app: 'app',
      workflows: 'default',
      browser: 'default',
      compose: 'default',
    })
    expect(input.map).toEqual({ app: 'app' })
  })
})
