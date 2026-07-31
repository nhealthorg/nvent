//! Handle `workflow::node-completed` events emitted by functions to wake the
//! orchestrator tick when a node finishes execution asynchronously.
//!
//! Functions running in a queue can emit this event to immediately trigger the
//! next tick instead of waiting for the sweep to poll. The event payload carries
//! the run_id and node_uid; the handler enqueues a new tick if the run is still
//! non-terminal.

use schemars::JsonSchema;
use serde::Deserialize;

use crate::error::WorkflowError;
use crate::functions::{start, Deps};

pub const NODE_COMPLETED_ID: &str = "workflow::node-completed";

pub const NODE_COMPLETED_DESC: &str =
    "Internal: called by workflow functions when they complete asynchronously to wake \
     the orchestrator. Payload: {run_id, node_uid}. Functions running via queue \
     should emit this after storing their result via state::put to enable instant \
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
    // Note: Additional fields like _caller_worker_id may be injected by iii-engine
    // and will be silently ignored (no deny_unknown_fields)
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
            "trace_id": "1234567890abcdef1234567890abcdef",
            "function_id": "process-text",
            "runtime": "nodejs"
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
    }
}
