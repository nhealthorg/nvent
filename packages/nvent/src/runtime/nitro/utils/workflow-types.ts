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
}

export interface NodeCheckpoint {
  state: NodeState
  pending_at: number
  completed_at?: number
  result_ref?: string
  retries: number
  worker_name?: string
}

export interface WorkflowRunRecord {
  run_id: string
  workflow_name?: string
  def_ref: string
  status: RunStatus
  step: number
  created_at: number
  updated_at: number
  input: any
  result?: any
  nodes: Record<string, NodeCheckpoint>
  fanout_src: Record<string, string[]>
  stream_ids: string[]
  state_keys_map: Record<string, boolean>
  workflow_trace_id?: string
}
