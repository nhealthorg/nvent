import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerNodeFunctions } from './node'

vi.mock('#imports', () => ({ useRuntimeConfig: () => ({}) }))

afterEach(() => vi.useRealTimers())

async function registeredHandler(completionFailures = 0) {
  let handler: (input: unknown) => Promise<unknown> = async () => undefined
  const trigger = vi.fn(async (request: any) => {
    if (request.function_id === 'nworkflow::node-completed' && completionFailures-- > 0) {
      throw new Error('transport unavailable')
    }
    return {}
  })
  const businessHandler = vi.fn(async () => ({ executionId: 'execution', stepId: 'step' }))
  const client = {
    getConnectionState: () => 'connected',
    trigger,
    registerFunction: (_id: string, callback: typeof handler) => { handler = callback },
  }
  await registerNodeFunctions(client as never, [{
    id: 'execute-step', handler: businessHandler, triggers: [],
  }])
  return { handler, trigger, businessHandler }
}

const input = {
  _workflow: { run_id: 'run', node_uid: 'step', attempt: 2 },
  input: { executionId: 'execution' },
}

describe('workflow completion delivery', () => {
  it('reports the successful result with attempt identity and an RPC deadline', async () => {
    const { handler, trigger } = await registeredHandler()
    expect(await handler(input)).toEqual({ executionId: 'execution', stepId: 'step' })
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({
      function_id: 'nworkflow::node-completed', timeoutMs: 10_000,
      payload: expect.objectContaining({ run_id: 'run', node_uid: 'step', attempt: 2,
        result: { executionId: 'execution', stepId: 'step' } }),
    }))
  })

  it('does not acknowledge successful business work when completion delivery fails', async () => {
    vi.useFakeTimers()
    const { handler, trigger, businessHandler } = await registeredHandler(4)
    const result = expect(handler(input)).rejects.toThrow('Workflow completion delivery failed')
    await vi.runAllTimersAsync()
    await result
    expect(businessHandler).toHaveBeenCalledTimes(1)
    expect(trigger.mock.calls.filter(([request]) => request.function_id === 'nworkflow::node-completed')).toHaveLength(4)
  })

  it('retries a transient completion failure without executing business work again', async () => {
    vi.useFakeTimers()
    const { handler, trigger, businessHandler } = await registeredHandler(1)
    const result = expect(handler(input)).resolves.toEqual({ executionId: 'execution', stepId: 'step' })
    await vi.runAllTimersAsync()
    await result
    expect(businessHandler).toHaveBeenCalledTimes(1)
    expect(trigger.mock.calls.filter(([request]) => request.function_id === 'nworkflow::node-completed')).toHaveLength(2)
  })
})