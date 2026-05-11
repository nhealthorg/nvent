export interface NventExtendedQueueDefinition {
  /** Queue name used by TriggerAction.Enqueue({ queue }) */
  name: string
  type?: 'standard' | 'fifo'
  concurrency?: number
  /** Alias of maxRetries */
  retries?: number
  maxRetries?: number
  /** Alias of backoffMs */
  backoff?: number
  backoffMs?: number
  /** Optional visibility timeout / lease timeout if supported by the engine */
  visibilityTimeoutMs?: number
  leaseTimeoutMs?: number
  /** Optional dead-letter / fallback queue names if supported by the engine */
  deadLetterQueue?: string
  fallbackQueue?: string
  messageGroupField?: string
}

export type NventQueueConfig = {
  type?: 'standard' | 'fifo'
  concurrency?: number
  retries?: number
  maxRetries?: number
  backoff?: number
  backoffMs?: number
  visibilityTimeoutMs?: number
  leaseTimeoutMs?: number
  deadLetterQueue?: string
  fallbackQueue?: string
  messageGroupField?: string
}

export interface MergeExtendedQueuesResult {
  queueConfigs: Record<string, NventQueueConfig>
  /** Duplicate queue names skipped from extension payload (first definition wins). */
  duplicates: string[]
}

/**
 * Merge base queue configs with extended queues from hooks.
 * Deterministic order: base queues first, then extension payload order.
 * Duplicate policy: first wins, later definitions are ignored.
 */
export function mergeExtendedQueueConfigs(
  baseQueueConfigs?: Record<string, NventQueueConfig>,
  extendedQueues: NventExtendedQueueDefinition[] = [],
): MergeExtendedQueuesResult {
  const queueConfigs: Record<string, NventQueueConfig> = {
    ...(baseQueueConfigs ?? {}),
  }
  const duplicates: string[] = []

  for (const q of extendedQueues) {
    if (!q?.name) continue
    if (Object.prototype.hasOwnProperty.call(queueConfigs, q.name)) {
      duplicates.push(q.name)
      continue
    }
    queueConfigs[q.name] = {
      type: q.type,
      concurrency: q.concurrency,
      retries: q.retries,
      maxRetries: q.maxRetries,
      backoff: q.backoff,
      backoffMs: q.backoffMs,
      visibilityTimeoutMs: q.visibilityTimeoutMs,
      leaseTimeoutMs: q.leaseTimeoutMs,
      deadLetterQueue: q.deadLetterQueue,
      fallbackQueue: q.fallbackQueue,
      messageGroupField: q.messageGroupField,
    }
  }

  return { queueConfigs, duplicates }
}
