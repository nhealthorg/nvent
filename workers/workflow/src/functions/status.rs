use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    error::WorkflowError,
    state,
    types::{
        NodeCheckpoint, NodeMemoryFailPolicy, NodeResultReturnType, NodeResultSpec, NodeState,
        QueueReceiptRecord, RunStatus, WorkflowDef, WorkflowRunRecord,
    },
};

use super::Deps;

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

/// Read a single snapshot of a workflow run's status. For a long-running
/// pipeline, prefer `nworkflow::start` + a `notify` callback (pushed the outcome
/// once it's terminal) over polling this in a loop — each poll costs one of your
/// turns and a poll loop can exhaust your turn budget.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct StatusRequest {
    /// The `run_id` returned by `nworkflow::start`.
    pub run_id: String,
    /// Whether to resolve and return the full terminal run result payload.
    /// Set false for lightweight polling when outputs can be large.
    #[serde(default = "default_include_result")]
    pub include_result: bool,
}

fn default_include_result() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StatusResponse {
    pub run_id: String,
    pub status: RunStatus,
    /// Per-node state keyed by node uid.
    pub nodes: BTreeMap<String, NodeCheckpoint>,
    /// Errors for nodes that failed, keyed by node uid — e.g. "no provider
    /// registered for model …". Present so a caller can diagnose a `failed` run
    /// without digging into stored state. Omitted when no node carries an error.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_errors: BTreeMap<String, String>,
    /// The authored workflow definition (for UI visualization).
    pub definition: WorkflowDef,
    /// Nodes that have a stored result: node uid → result_ref.
    /// Fetch the value with `nworkflow::node-result { run_id, node_uid }`. Lets a
    /// caller recover partial work from a run that failed partway (the run-level
    /// `result` is only set on a Completed run). Omitted when empty.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_results: BTreeMap<String, String>,
    /// Queue enqueue receipts recorded for this run (for restart/cancel forensics).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queue_receipts: Vec<QueueReceiptRecord>,
    /// Per-loop execution metrics keyed by fanout node id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub loop_stats: BTreeMap<String, LoopStats>,
    /// Reference key for terminal run output in internal state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<String>,
    /// Store key for terminal result when output node uses `returnType: store`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_key: Option<String>,
    /// Output node result mode as authored in the workflow definition.
    pub output_result_mode_declared: NodeResultReturnType,
    /// Output node result mode after policy fallback (e.g. memory+onMemoryFail=store).
    pub output_result_mode_effective: NodeResultReturnType,
    /// Output node memory-fail policy, if configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_on_memory_fail: Option<NodeMemoryFailPolicy>,
    /// Per-node result mode metadata keyed by node uid.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_result_modes: BTreeMap<String, NodeResultModeMetadata>,
    /// Per-node result availability state keyed by node uid.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_result_states: BTreeMap<String, NodeResultAvailabilityState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Run-level failure summary (set when `status == failed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct NodeResultModeMetadata {
    pub declared_mode: NodeResultReturnType,
    pub effective_mode: NodeResultReturnType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_memory_fail: Option<NodeMemoryFailPolicy>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeResultAvailabilityState {
    Ready,
    Pruned,
    Pending,
}

fn node_result_mode_from_spec(spec: Option<&NodeResultSpec>) -> NodeResultModeMetadata {
    let declared_mode = spec
        .map(|result| result.return_type)
        .unwrap_or(NodeResultReturnType::Memory);
    let on_memory_fail = spec.and_then(|result| result.on_memory_fail);
    let effective_mode = if declared_mode == NodeResultReturnType::Memory
        && on_memory_fail == Some(NodeMemoryFailPolicy::Store)
    {
        NodeResultReturnType::Store
    } else {
        declared_mode
    };

    NodeResultModeMetadata {
        declared_mode,
        effective_mode,
        on_memory_fail,
    }
}

fn node_result_mode(definition: &WorkflowDef, node_uid: &str) -> NodeResultModeMetadata {
    let base_node = node_uid.split('#').next().unwrap_or(node_uid);
    let spec = definition
        .nodes
        .get(base_node)
        .and_then(|node| node.result.as_ref());
    node_result_mode_from_spec(spec)
}

fn node_result_state(
    cp: &NodeCheckpoint,
    mode: &NodeResultModeMetadata,
) -> NodeResultAvailabilityState {
    if cp.result_ref.is_some() {
        return NodeResultAvailabilityState::Ready;
    }

    if cp.state == NodeState::Done && mode.effective_mode == NodeResultReturnType::Memory {
        return NodeResultAvailabilityState::Pruned;
    }

    NodeResultAvailabilityState::Pending
}

fn collect_node_result_modes(
    definition: &WorkflowDef,
    record: &WorkflowRunRecord,
) -> BTreeMap<String, NodeResultModeMetadata> {
    let mut out = BTreeMap::new();
    for node_uid in record.nodes.keys() {
        out.insert(node_uid.clone(), node_result_mode(definition, node_uid));
    }
    out
}

fn collect_node_result_states(
    definition: &WorkflowDef,
    record: &WorkflowRunRecord,
) -> BTreeMap<String, NodeResultAvailabilityState> {
    let mut out = BTreeMap::new();
    for (node_uid, cp) in &record.nodes {
        let mode = node_result_mode(definition, node_uid);
        out.insert(node_uid.clone(), node_result_state(cp, &mode));
    }
    out
}

fn output_result_mode(definition: &WorkflowDef) -> NodeResultModeMetadata {
    let output_node = definition
        .output
        .from
        .strip_prefix("node:")
        .unwrap_or(&definition.output.from);

    let spec = definition
        .nodes
        .get(output_node)
        .and_then(|n| n.result.as_ref());

    node_result_mode_from_spec(spec)
}

fn derive_store_key(record: &WorkflowRunRecord, definition: &WorkflowDef) -> Option<String> {
    let output_uses_store =
        output_result_mode(definition).effective_mode == NodeResultReturnType::Store;

    if output_uses_store {
        record.result_ref.clone()
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct LoopStats {
    pub mode: String,
    pub over: String,
    pub expanded: bool,
    pub total_items: usize,
    pub completed_items: usize,
    pub running_items: usize,
    pub failed_items: usize,
    pub cancelled_items: usize,
    pub pending_items: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_index: Option<usize>,
}

fn collect_loop_stats(
    definition: &WorkflowDef,
    record: &WorkflowRunRecord,
) -> BTreeMap<String, LoopStats> {
    let mut out = BTreeMap::new();

    for (node_id, node_def) in &definition.nodes {
        let Some(fanout) = node_def.fanout.as_ref() else {
            continue;
        };

        let total_items = record.fanout_src.get(node_id).copied().unwrap_or(0);

        let mut completed_items = 0usize;
        let mut running_items = 0usize;
        let mut failed_items = 0usize;
        let mut cancelled_items = 0usize;
        let mut pending_items = 0usize;

        for idx in 0..total_items {
            let uid = format!("{}#{}", node_id, idx);
            match record.nodes.get(&uid).map(|cp| cp.state) {
                Some(NodeState::Done) => completed_items += 1,
                Some(NodeState::Running) => running_items += 1,
                Some(NodeState::Failed) => failed_items += 1,
                Some(NodeState::Cancelled) => cancelled_items += 1,
                Some(NodeState::Pending) | None => pending_items += 1,
            }
        }

        let active_index = if fanout.mode == Some(crate::types::FanoutMode::Sequential)
            || fanout.mode == Some(crate::types::FanoutMode::Batch)
        {
            (0..total_items).find(|idx| {
                let uid = format!("{}#{}", node_id, idx);
                !matches!(
                    record.nodes.get(&uid).map(|cp| cp.state),
                    Some(NodeState::Done)
                )
            })
        } else {
            None
        };

        out.insert(
            node_id.clone(),
            LoopStats {
                mode: match fanout.mode {
                    Some(crate::types::FanoutMode::Sequential) => "sequential".to_string(),
                    Some(crate::types::FanoutMode::Batch) => "batch".to_string(),
                    _ => "parallel".to_string(),
                },
                over: fanout.over.clone(),
                expanded: record.fanout_src.contains_key(node_id),
                total_items,
                completed_items,
                running_items,
                failed_items,
                cancelled_items,
                pending_items,
                active_index,
            },
        );
    }

    out
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

pub async fn handle(
    deps: &Deps,
    req: StatusRequest,
) -> Result<Option<StatusResponse>, WorkflowError> {
    let record = match state::get_run(&deps.iii, &req.run_id).await? {
        None => return Ok(None),
        Some(r) => r,
    };

    let definition = match state::get_def(&deps.iii, &record.def_ref).await? {
        None => {
            return Err(WorkflowError::State(format!(
                "Definition for run {} not found",
                req.run_id
            )))
        }
        Some(d) => d,
    };

    let node_errors: BTreeMap<String, String> = record
        .nodes
        .iter()
        .filter_map(|(node_uid, cp)| {
            cp.result_error
                .as_ref()
                .map(|e| (node_uid.clone(), e.clone()))
        })
        .collect();

    let node_results: BTreeMap<String, String> = record
        .nodes
        .iter()
        .filter_map(|(node_uid, cp)| {
            cp.result_ref
                .as_ref()
                .map(|r| (node_uid.clone(), r.clone()))
        })
        .collect();

    let queue_receipts = deps.internal_state.list_queue_receipts(&req.run_id).await?;
    let loop_stats = collect_loop_stats(&definition, &record);
    let output_mode = output_result_mode(&definition);
    let node_result_modes = collect_node_result_modes(&definition, &record);
    let node_result_states = collect_node_result_states(&definition, &record);
    let result = if req.include_result {
        match record.result_ref.as_deref() {
            Some(result_ref) => state::get_run_result(&deps.iii, result_ref).await?,
            None => None,
        }
    } else {
        None
    };
    let store_key = derive_store_key(&record, &definition);

    Ok(Some(StatusResponse {
        run_id: record.run_id,
        status: record.status,
        nodes: record.nodes,
        node_errors,
        definition,
        node_results,
        queue_receipts,
        loop_stats,
        result_ref: record.result_ref,
        store_key,
        output_result_mode_declared: output_mode.declared_mode,
        output_result_mode_effective: output_mode.effective_mode,
        output_on_memory_fail: output_mode.on_memory_fail,
        node_result_modes,
        node_result_states,
        result,
        result_error: record.result_error,
        created_at: record.created_at,
        updated_at: record.updated_at,
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::NodeState;
    use serde_json::json;

    #[test]
    fn status_response_serde_round_trip() {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "plan".to_string(),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: Some("r_abc123/plan".to_string()),
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: None,
                worker_name: None,
            },
        );

        let mut node_errors = BTreeMap::new();
        node_errors.insert("read".to_string(), "boom".to_string());

        let mut node_results = BTreeMap::new();
        node_results.insert("plan".to_string(), "r_abc123/plan".to_string());

        let queue_receipts = vec![QueueReceiptRecord {
            id: "r_abc123:plan:receipt-1".to_string(),
            run_id: "r_abc123".to_string(),
            node_uid: "plan".to_string(),
            function_id: "plan_function".to_string(),
            queue: "default".to_string(),
            receipt_id: "receipt-1".to_string(),
            attempt: 0,
            ts_unix_ms: 12345,
        }];

        let resp = StatusResponse {
            run_id: "r_abc123".to_string(),
            status: RunStatus::AwaitingNodes,
            nodes,
            node_errors,
            definition: WorkflowDef {
                version: 1,
                metadata: None,
                default_functions: None,
                nodes: BTreeMap::new(),
                output: crate::types::OutputRef {
                    from: "node:plan".to_string(),
                },
            },
            node_results,
            queue_receipts,
            loop_stats: BTreeMap::new(),
            result_ref: Some("r_abc123".to_string()),
            store_key: Some("r_abc123".to_string()),
            output_result_mode_declared: NodeResultReturnType::Store,
            output_result_mode_effective: NodeResultReturnType::Store,
            output_on_memory_fail: None,
            node_result_modes: BTreeMap::new(),
            node_result_states: BTreeMap::new(),
            result: Some(json!({"summary": "hello"})),
            result_error: Some("node 'read': boom".to_string()),
            created_at: 12345,
            updated_at: 67890,
        };

        let serialized = serde_json::to_string(&resp).expect("serialize StatusResponse");
        let decoded: StatusResponse =
            serde_json::from_str(&serialized).expect("deserialize StatusResponse");

        assert_eq!(decoded.run_id, resp.run_id);
        assert_eq!(decoded.status, resp.status);
        assert_eq!(decoded.nodes, resp.nodes);
        assert_eq!(decoded.node_errors, resp.node_errors);
        assert_eq!(decoded.node_results, resp.node_results);
        assert_eq!(decoded.queue_receipts, resp.queue_receipts);
        assert_eq!(decoded.result_ref, resp.result_ref);
        assert_eq!(decoded.store_key, resp.store_key);
        assert_eq!(
            decoded.output_result_mode_declared,
            resp.output_result_mode_declared
        );
        assert_eq!(
            decoded.output_result_mode_effective,
            resp.output_result_mode_effective
        );
        assert_eq!(decoded.output_on_memory_fail, resp.output_on_memory_fail);
        assert_eq!(decoded.node_result_modes, resp.node_result_modes);
        assert_eq!(decoded.node_result_states, resp.node_result_states);
        assert_eq!(decoded.result, resp.result);
        assert_eq!(decoded.result_error, resp.result_error);
        assert_eq!(decoded.created_at, resp.created_at);
        assert_eq!(decoded.updated_at, resp.updated_at);
    }

    #[test]
    fn status_response_omits_empty_diagnostics() {
        let resp = StatusResponse {
            run_id: "r_xyz".to_string(),
            status: RunStatus::Running,
            nodes: BTreeMap::new(),
            node_errors: BTreeMap::new(),
            definition: WorkflowDef {
                version: 1,
                metadata: None,
                default_functions: None,
                nodes: BTreeMap::new(),
                output: crate::types::OutputRef {
                    from: "node:x".to_string(),
                },
            },
            node_results: BTreeMap::new(),
            queue_receipts: Vec::new(),
            loop_stats: BTreeMap::new(),
            result_ref: None,
            store_key: None,
            output_result_mode_declared: NodeResultReturnType::Memory,
            output_result_mode_effective: NodeResultReturnType::Memory,
            output_on_memory_fail: None,
            node_result_modes: BTreeMap::new(),
            node_result_states: BTreeMap::new(),
            result: None,
            result_error: None,
            created_at: 0,
            updated_at: 0,
        };

        let serialized = serde_json::to_value(&resp).expect("serialize");
        assert!(
            serialized.get("result_ref").is_none(),
            "result_ref omitted when None"
        );
        assert!(
            serialized.get("store_key").is_none(),
            "store_key omitted when None"
        );
        assert!(
            serialized.get("output_on_memory_fail").is_none(),
            "output_on_memory_fail omitted when None"
        );
        assert!(
            serialized.get("result").is_none(),
            "result omitted when None"
        );
        assert!(
            serialized.get("result_error").is_none(),
            "result_error omitted when None"
        );
        assert!(
            serialized.get("node_results").is_none(),
            "node_results omitted when empty"
        );
        assert!(
            serialized.get("queue_receipts").is_none(),
            "queue_receipts omitted when empty"
        );
        assert!(
            serialized.get("loop_stats").is_none(),
            "loop_stats omitted when empty"
        );
        assert!(
            serialized.get("node_errors").is_none(),
            "node_errors omitted when empty"
        );
        assert!(
            serialized.get("node_result_modes").is_none(),
            "node_result_modes omitted when empty"
        );
        assert!(
            serialized.get("node_result_states").is_none(),
            "node_result_states omitted when empty"
        );
    }

    #[test]
    fn collect_loop_stats_reports_item_progress() {
        use crate::types::{
            FanoutMode, FanoutSpec, FunctionSpec, InputSpec, NodeDef, OutputRef, WorkflowRunRecord,
        };

        let mut def_nodes = BTreeMap::new();
        def_nodes.insert(
            "loop-node".to_string(),
            NodeDef {
                label: None,
                function: Some(FunctionSpec {
                    id: "test-fn".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                }),
                agent: None,
                agent_options: None,
                input: InputSpec {
                    from: "fanout_item".into(),
                    template: None,
                    value: None,
                },
                depends_on: vec![],
                fanout: Some(FanoutSpec {
                    over: "node:plan.result.items".to_string(),
                    mode: Some(FanoutMode::Sequential),
                    batch_size: None,
                    item_return_type: None,
                }),
                result: None,
                input_policy: None,
            },
        );

        let def = WorkflowDef {
            version: 1,
            nodes: def_nodes,
            output: OutputRef {
                from: "node:loop-node".to_string(),
            },
            default_functions: None,
            metadata: None,
        };

        let mut record = WorkflowRunRecord {
            run_id: "r_loop".to_string(),
            workflow_name: None,
            workflow_trace_id: None,
            state_scope_id: None,
            stream_scope_id: None,
            agent_session_id: None,
            step: 0,
            status: RunStatus::Running,
            abort: false,
            def_ref: "r_loop".to_string(),
            input_ref: "r_loop".to_string(),
            vars_ref: Some("r_loop".to_string()),
            state_keys_map: BTreeMap::new(),
            stream_ids: Vec::new(),
            queue_receipts: Vec::new(),
            nodes: BTreeMap::new(),
            fanout_src: BTreeMap::new(),
            result_ref: None,
            result_error: None,
            notify: None,
            caller_session_id: None,
            created_at: 0,
            updated_at: 0,
        };

        record.fanout_src.insert("loop-node".to_string(), 3);
        record.nodes.insert(
            "loop-node#0".to_string(),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: None,
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: None,
                worker_name: None,
            },
        );
        record.nodes.insert(
            "loop-node#1".to_string(),
            NodeCheckpoint {
                state: NodeState::Running,
                session_id: None,
                turn_id: None,
                result_ref: None,
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: None,
                worker_name: None,
            },
        );

        let stats = collect_loop_stats(&def, &record);
        let loop_stats = stats.get("loop-node").expect("loop stats present");

        assert_eq!(loop_stats.mode, "sequential");
        assert!(loop_stats.expanded);
        assert_eq!(loop_stats.total_items, 3);
        assert_eq!(loop_stats.completed_items, 1);
        assert_eq!(loop_stats.running_items, 1);
        assert_eq!(loop_stats.pending_items, 1);
        assert_eq!(loop_stats.active_index, Some(1));
    }
}
