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
  HttpRequest,
} from './utils/defineFunction'

export { useIii, useIiiHealth } from './utils/useIii'

// Re-export the full iii SDK surface so users only need one import
export { Logger, registerWorker, TriggerAction } from 'iii-sdk'
export type { ISdk, InitOptions, TriggerConfig as IiiTriggerConfig } from 'iii-sdk'
