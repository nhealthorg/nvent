use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    error::WorkflowError,
    state,
    types::{
        NodeCheckpoint, NodeState, QueueReceiptRecord, RunStatus, WorkflowDef, WorkflowRunRecord,
    },
};

use super::Deps;

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

/// Read a single snapshot of a workflow run's status. For a long-running
/// pipeline, prefer `workflow::start` + a `notify` callback (pushed the outcome
/// once it's terminal) over polling this in a loop — each poll costs one of your
/// turns and a poll loop can exhaust your turn budget.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct StatusRequest {
    /// The `run_id` returned by `workflow::start`.
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
    /// Fetch the value with `workflow::node-result { run_id, node_uid }`. Lets a
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Run-level failure summary (set when `status == failed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
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

        let items = record.fanout_src.get(node_id).cloned().unwrap_or_default();
        let total_items = items.len();

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

        let active_index = if fanout.mode == Some(crate::types::FanoutMode::Sequential) {
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
                mode: if fanout.mode == Some(crate::types::FanoutMode::Sequential) {
                    "sequential".to_string()
                } else {
                    "parallel".to_string()
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

    let definition = match state::get_def(&deps.iii, &req.run_id).await? {
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
    let result = if req.include_result && record.result_ref.is_some() {
        state::get_run_result(&deps.iii, &req.run_id).await?
    } else {
        None
    };

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
                function: FunctionSpec {
                    id: "test-fn".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                },
                input: InputSpec {
                    from: "fanout_item".into(),
                    template: None,
                    value: None,
                },
                depends_on: vec![],
                fanout: Some(FanoutSpec {
                    over: "node:plan.result.items".to_string(),
                    mode: Some(FanoutMode::Sequential),
                }),
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

        record.fanout_src.insert(
            "loop-node".to_string(),
            vec![json!("a"), json!("b"), json!("c")],
        );
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
