/**
 * #nvent/server — single entry point for server-side nvent + iii SDK access.
 *
 * Import everything you need from here in `server/functions/*.ts` files:
 *
 * ```ts
 * import { defineFunction, useIii, Logger, getContext } from '#nvent/server'
 * ```
 */

export { defineFunction } from './utils/defineFunction'
export { defineWorkflow } from './utils/defineWorkflow'
export * from './utils/workflow-types'
export type {
  FunctionDef,
  FunctionHandler,
  WorkflowFunctionOptions,
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
} from './utils/defineFunction'

export { useIii, useIiiHealth } from './utils/useIii'

// Re-export the full iii SDK surface so users only need one import
export { registerWorker, TriggerAction } from 'iii-sdk'
export { Logger } from '@iii-dev/helpers/observability'
export type { IIIClient, InitOptions } from 'iii-sdk'
