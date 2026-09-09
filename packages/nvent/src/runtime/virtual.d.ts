declare module '#nvent/iii-registry' {
  interface NodeFnInfo {
    id: string
    description?: string
    handler: (input: unknown, context: any) => Promise<unknown> | unknown
    triggers?: Array<{ type: string; function_id: string; config?: Record<string, unknown> }>
    absPath: string
    filePath: string
    runtime: 'nodejs' | 'python' | 'rust' | 'unknown'
    standalone?: boolean
    workflow?: boolean | Record<string, unknown>
    $workflow?: boolean
    request_format?: Record<string, unknown>
    response_format?: Record<string, unknown>
  }
  export const registry: {
    functions: NodeFnInfo[]
    workflows: NodeFnInfo[]
    triggers: Array<{ type: string; function_id: string; config?: Record<string, unknown> }>
  }
  export const pythonFunctions: NodeFnInfo[]
}

declare module '#nvent/server' {
  export { defineFunction } from './nitro/utils/defineFunction'
  export { defineWorkflow } from './nitro/utils/defineWorkflow'
  export * from './nitro/utils/workflow-types'
  export type {
    FunctionDef,
    FunctionHandler,
    TriggerConfig,
    HttpTriggerConfig,
    CronTriggerConfig,
    QueueTriggerConfig,
    StateTriggerConfig,
    StreamTriggerConfig,
    SubscribeTriggerConfig,
    LogTriggerConfig,
    CustomTriggerConfig,
    HookEventType,
    HookEventsInput,
    HttpRequest,
  } from './nitro/utils/defineFunction'
  export { useIii, useIiiHealth } from './nitro/utils/useIii'
  export { registerWorker, TriggerAction } from 'iii-sdk'
  export { Logger } from '@iii-dev/helpers/observability'
  export type { IIIClient, InitOptions} from 'iii-sdk'
}

declare module '#nvent/types' {
  export {
    RunStatus,
    NodeState,
    FunctionRuntime,
    WorkflowMetadata,
    NodeCheckpoint,
    WorkflowRunRecord,
  } from './nitro/utils/workflow-types'
}
