export enum RunStatus {
  Running = 'running',
  AwaitingNodes = 'awaiting_nodes',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum NodeState {
  Pending = 'pending',
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum FunctionRuntime {
  NodeJS = 'nodejs',
  Python = 'python',
  Rust = 'rust',
  Unknown = 'unknown',
}

export interface WorkflowMetadata {
  created_by_worker?: string
  name?: string
  description?: string
  tags?: string[]
  hooks?: {
    on_start?: WorkflowHookMetadataSpec
    on_end?: WorkflowHookMetadataSpec
    on_error?: WorkflowHookMetadataSpec
    on_delete?: WorkflowHookMetadataSpec
  }
}

export type WorkflowHookMetadataSpec = string | {
  function: string
  namespace?: string
  input?: Record<string, unknown>
}

export interface WorkflowOutputRef {
  from: string
}

export interface WorkflowFunctionSpec {
  id: string
  queue?: string
  runtime?: FunctionRuntime
}

export interface WorkflowFanoutSpec {
  over: string
  mode?: 'parallel' | 'sequential' | 'batch'
  batchSize?: number
  itemReturnType?: 'memory' | 'store'
}

export interface WorkflowNodeDef {
  label?: string
  function: WorkflowFunctionSpec
  depends_on?: string[]
  fanout?: WorkflowFanoutSpec
}

export interface WorkflowDef {
  version: number
  nodes: Record<string, WorkflowNodeDef>
  output: WorkflowOutputRef
  metadata?: WorkflowMetadata
}

export interface NodeCheckpoint {
  state: NodeState
  pending_at?: number
  completed_at?: number
  result_ref?: string
  result_error?: string
  retries: number
  worker_name?: string
}

export interface QueueReceiptRecord {
  id: string
  run_id: string
  node_uid: string
  function_id: string
  queue: string
  receipt_id: string
  attempt: number
  ts_unix_ms: number
}

export interface LoopStats {
  mode: 'parallel' | 'sequential' | 'batch' | string
  over: string
  expanded: boolean
  total_items: number
  completed_items: number
  running_items: number
  failed_items: number
  cancelled_items: number
  pending_items: number
  active_index?: number
}

export type ResultMode = 'memory' | 'store' | 'stream'
export type ResultAvailability = 'ready' | 'pruned' | 'pending'

export interface NodeResultModeMetadata {
  declared_mode: ResultMode
  effective_mode: ResultMode
  on_memory_fail?: 'store' | 'error'
}

export interface WorkflowStatusResponse {
  run_id: string
  status: RunStatus
  nodes: Record<string, NodeCheckpoint>
  node_errors?: Record<string, string>
  definition: WorkflowDef
  node_results?: Record<string, string>
  queue_receipts?: QueueReceiptRecord[]
  loop_stats?: Record<string, LoopStats>
  result_ref?: string
  store_key?: string
  output_result_mode_declared: ResultMode
  output_result_mode_effective: ResultMode
  output_on_memory_fail?: 'store' | 'error'
  node_result_modes?: Record<string, NodeResultModeMetadata>
  node_result_states?: Record<string, ResultAvailability>
  result?: any
  result_error?: string
  created_at: number
  updated_at: number
}

export interface WorkflowRunResultResponse {
  result: any | null
}

export interface WorkflowRunRecord {
  run_id: string
  workflow_name?: string
  def_ref: string
  status: RunStatus
  step: number
  created_at: number
  updated_at: number
  input_ref?: string
  result_ref?: string
  result_error?: string
  store_key?: string
  nodes: Record<string, NodeCheckpoint>
  fanout_src: Record<string, number>
  stream_ids: string[]
  state_keys_map: Record<string, boolean>
  workflow_trace_id?: string
}
