use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    error::WorkflowError,
    state,
    types::{NodeCheckpoint, RunStatus, WorkflowDef},
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
    /// Nodes that have a stored result: node uid → result_ref (its key in state).
    /// Fetch the value with `workflow::node-result { run_id, node_uid }`. Lets a
    /// caller recover partial work from a run that failed partway (the run-level
    /// `result` is only set on a Completed run). Omitted when empty.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_results: BTreeMap<String, String>,
    /// Queue enqueue receipts recorded for this run (for restart/cancel forensics).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queue_receipts: Vec<state::QueueReceiptRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Run-level failure summary (set when `status == failed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
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

    let queue_receipts = state::list_queue_receipts(&deps.iii, &req.run_id).await?;

    Ok(Some(StatusResponse {
        run_id: record.run_id,
        status: record.status,
        nodes: record.nodes,
        node_errors,
        definition,
        node_results,
        queue_receipts,
        result: record.result,
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
    use serde_json::json;
    use crate::types::NodeState;

    #[test]
    fn status_response_serde_round_trip() {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "plan".to_string(),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: Some("workflow_node_result/r_abc123/plan".to_string()),
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
        node_results.insert(
            "plan".to_string(),
            "workflow_node_result/r_abc123/plan".to_string(),
        );

        let queue_receipts = vec![state::QueueReceiptRecord {
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
            result: None,
            result_error: None,
            created_at: 0,
            updated_at: 0,
        };

        let serialized = serde_json::to_value(&resp).expect("serialize");
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
            serialized.get("node_errors").is_none(),
            "node_errors omitted when empty"
        );
    }
}
