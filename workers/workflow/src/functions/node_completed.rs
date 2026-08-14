//! Handle `workflow::node-completed` events emitted by functions to wake the
//! orchestrator tick when a node finishes execution asynchronously.
//!
//! Functions running in a queue can emit this event to immediately trigger the
//! next tick instead of waiting for the sweep to poll. The event payload carries
//! the run_id and node_uid; the handler enqueues a new tick if the run is still
//! non-terminal.

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::WorkflowError;
use crate::functions::{start, Deps};
use crate::observability::ObservabilityAdapter;
use crate::types::{NodeMemoryFailPolicy, NodeResultReturnType};

pub const NODE_COMPLETED_ID: &str = "workflow::node-completed";

pub const NODE_COMPLETED_DESC: &str =
    "Internal: called by workflow functions when they complete asynchronously to wake \
    the orchestrator. Payload: {run_id, node_uid, result?, result_error?}. Functions running via queue \
    should emit this at completion; the workflow worker stores optional result payloads \
     tick wakeup instead of waiting for the sweep poll.";

/// Event payload emitted by functions when they complete execution.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct NodeCompletedEvent {
    /// The workflow run ID.
    pub run_id: String,
    /// The node UID (node_id or node_id#index for fanout items).
    pub node_uid: String,
    /// Optional runtime-provided trace id for central trace indexing.
    #[serde(default)]
    pub trace_id: Option<String>,
    /// Optional function id for central trace indexing.
    #[serde(default)]
    pub function_id: Option<String>,
    /// Optional runtime label (nodejs/python/rust).
    #[serde(default)]
    pub runtime: Option<String>,
    /// Optional node result payload (success path).
    #[serde(default)]
    pub result: Option<Value>,
    /// Optional error message (failure path).
    #[serde(default)]
    pub result_error: Option<String>,
    /// Optional dispatch attempt number for out-of-order protection.
    #[serde(default)]
    pub attempt: Option<u32>,
    // Note: Additional fields like _caller_worker_id may be injected by iii-engine
    // and will be silently ignored (no deny_unknown_fields)
}

fn should_persist_result(
    return_type: NodeResultReturnType,
    on_memory_fail: Option<NodeMemoryFailPolicy>,
) -> bool {
    matches!(return_type, NodeResultReturnType::Store | NodeResultReturnType::Stream)
        || matches!(
            (return_type, on_memory_fail),
            (NodeResultReturnType::Memory, Some(NodeMemoryFailPolicy::Store))
        )
}

/// Wake the workflow tick when a function signals completion.
///
/// This is a fast-path optimization: functions CAN emit this event to trigger
/// immediate reconciliation, but the sweep will eventually poll all Running nodes
/// anyway (timeout check + completion detection). A function that never emits this
/// event will still complete — just slower (up to one sweep interval delay).
pub async fn handle(deps: &Deps, event: NodeCompletedEvent) -> Result<(), WorkflowError> {
    tracing::info!(
        run_id = %event.run_id,
        node_uid = %event.node_uid,
        "received node-completed event"
    );

    let _g = deps.locks.guard(&event.run_id).await;

    let Some(record) = crate::state::get_run(&deps.iii, &event.run_id).await? else {
        // Run no longer exists (swept/deleted). No-op.
        tracing::debug!(run_id = %event.run_id, "run not found, ignoring event");
        return Ok(());
    };

    if record.status.is_terminal() {
        // Run already reached a terminal state. No further ticks needed.
        tracing::debug!(
            run_id = %event.run_id,
            status = ?record.status,
            "run already terminal, ignoring event"
        );
        return Ok(());
    }

    let checkpoint = record.nodes.get(&event.node_uid);
    let node_is_running = checkpoint
        .map(|cp| cp.state == crate::types::NodeState::Running)
        .unwrap_or(false);

    if !node_is_running {
        tracing::debug!(
            run_id = %event.run_id,
            node_uid = %event.node_uid,
            "ignoring node-completed event for non-running node"
        );
        return Ok(());
    }

    if let (Some(event_attempt), Some(cp)) = (event.attempt, checkpoint) {
        if cp.retries != event_attempt {
            tracing::debug!(
                run_id = %event.run_id,
                node_uid = %event.node_uid,
                event_attempt,
                expected_attempt = cp.retries,
                "ignoring stale node-completed event due to attempt mismatch"
            );
            return Ok(());
        }
    }

    // Optional fast-path payload persistence: runtimes may include result/error
    // directly in this event and skip the extra workflow::node-result-write call.
    if event.result.is_some() || event.result_error.is_some() {
        let value = match event.result_error {
            Some(err) => json!({ "__workflow_error__": err }),
            None => event.result.unwrap_or(Value::Null),
        };

        let ts = deps.now_ms();
        let base_node_id = event.node_uid.split('#').next().unwrap_or(event.node_uid.as_str());
        let result_policy = crate::state::get_def(&deps.iii, &record.def_ref)
            .await?
            .and_then(|def| def.nodes.get(base_node_id).cloned())
            .and_then(|node| node.result);

        let return_type = result_policy
            .as_ref()
            .map(|result| result.return_type)
            .unwrap_or(NodeResultReturnType::Memory);
        let on_memory_fail = result_policy.as_ref().and_then(|result| result.on_memory_fail);

        if should_persist_result(return_type, on_memory_fail) {
            let _ = crate::state::delete_node_result_memory(&event.run_id, &event.node_uid);
            crate::state::put_node_result(&deps.iii, &event.run_id, &event.node_uid, &value)
                .await?;
        } else {
            crate::state::put_node_result_memory(&event.run_id, &event.node_uid, &value)?;
            crate::state::delete_node_result_store(&deps.iii, &event.run_id, &event.node_uid)
                .await?;
        }

        let event_name = match return_type {
            NodeResultReturnType::Store => "result:store",
            NodeResultReturnType::Stream => "result:stream",
            NodeResultReturnType::Memory => "result:memory",
        };

        let effective_event_name = if matches!(return_type, NodeResultReturnType::Memory)
            && matches!(on_memory_fail, Some(NodeMemoryFailPolicy::Store))
        {
            "result:store"
        } else {
            event_name
        };

        let payload_size = serde_json::to_vec(&value).map(|blob| blob.len()).unwrap_or(0);

        crate::observability::adapter()
            .write_trace(
                &deps.iii,
                &crate::state::WorkflowRunTraceRecord {
                    id: format!("tr_{}_{}", ts, crate::ids::new_trace_id()),
                    run_id: event.run_id.clone(),
                    node_uid: Some(event.node_uid.clone()),
                    function_id: event.function_id.clone(),
                    runtime: event.runtime.clone(),
                    event_name: effective_event_name.to_string(),
                    ts_unix_ms: ts,
                    attributes: Some(json!({
                        "workflow.result_mode": effective_event_name,
                        "workflow.result_declared_mode": event_name,
                        "workflow.on_memory_fail": on_memory_fail.map(|v| match v {
                            NodeMemoryFailPolicy::Store => "store",
                            NodeMemoryFailPolicy::Error => "error",
                        }),
                        "workflow.payload_size_bytes": payload_size,
                        "workflow.source": "node_completed_event"
                    })),
                    trace_id: event.trace_id.clone(),
                    span_id: None,
                },
            )
            .await?;
    }

    tracing::info!(
        run_id = %event.run_id,
        step = record.step,
        "enqueueing next tick after node completion"
    );

    // Enqueue a new tick to reconcile the completed node and fire any newly-ready nodes.
    start::enqueue_tick(&deps.iii, &event.run_id, record.step + 1).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_payload_parses() {
        let event: NodeCompletedEvent = serde_json::from_value(serde_json::json!({
            "run_id": "run_abc",
            "node_uid": "gen#2",
            "attempt": 1,
            "trace_id": "1234567890abcdef1234567890abcdef",
            "function_id": "process-text",
                "runtime": "nodejs",
                "result": { "ok": true }
        }))
        .expect("valid NodeCompletedEvent");
        assert_eq!(event.run_id, "run_abc");
        assert_eq!(event.node_uid, "gen#2");
        assert_eq!(
            event.trace_id.as_deref(),
            Some("1234567890abcdef1234567890abcdef")
        );
        assert_eq!(event.function_id.as_deref(), Some("process-text"));
        assert_eq!(event.runtime.as_deref(), Some("nodejs"));
        assert_eq!(event.attempt, Some(1));
        assert_eq!(event.result, Some(serde_json::json!({ "ok": true })));
    }

    #[test]
    fn should_persist_result_for_store_stream_and_memory_store_fallback() {
        assert!(should_persist_result(NodeResultReturnType::Store, None));
        assert!(should_persist_result(NodeResultReturnType::Stream, None));
        assert!(should_persist_result(
            NodeResultReturnType::Memory,
            Some(NodeMemoryFailPolicy::Store)
        ));
        assert!(!should_persist_result(NodeResultReturnType::Memory, None));
    }
}
