import { describe, expect, it } from 'vitest'
import { classifyComposeStartupError, ComposeStartupError } from '../../packages/nvent/src/runtime/nitro/utils/compose'

describe('compose startup error mapping', () => {
  it('maps invalid namespace errors', () => {
    expect(classifyComposeStartupError('Invalid namespace: foo')).toBe('INVALID_NAMESPACE')
  })

  it('maps engine startup timeout errors', () => {
    expect(classifyComposeStartupError('engine startup timeout while waiting for worker-manager')).toBe('ENGINE_STARTUP_TIMEOUT')
  })

  it('maps managed endpoint mismatch errors', () => {
    expect(classifyComposeStartupError('managed engine endpoint mismatch')).toBe('MANAGED_ENGINE_ENDPOINT_MISMATCH')
  })

  it('maps generic startup timeout errors', () => {
    expect(classifyComposeStartupError('compose up timeout after 120000ms')).toBe('STARTUP_TIMEOUT')
  })

  it('maps port collisions to project did not start', () => {
    expect(classifyComposeStartupError('Address already in use (os error 98)')).toBe('PROJECT_DID_NOT_START')
  })

  it('falls back to generic compose up failed', () => {
    expect(classifyComposeStartupError('something unexpected happened')).toBe('COMPOSE_UP_FAILED')
  })

  it('renders compose startup error message with code and hint', () => {
    const err = new ComposeStartupError('STARTUP_TIMEOUT', 'Compose startup failed.', 'Increase timeout.', 'compose up timeout')
    expect(err.message).toContain('[STARTUP_TIMEOUT]')
    expect(err.message).toContain('hint: Increase timeout.')
    expect(err.message).toContain('detail: compose up timeout')
  })
})
