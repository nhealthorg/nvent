//! Handle the optional queue worker start signal.
//!
//! Queue admission and function execution have different failure modes. A
//! queue-backed function may therefore emit this event once a worker has
//! actually begun processing its message. Until then the node keeps the
//! generous queue pending timeout.

use schemars::JsonSchema;
use serde::Deserialize;

use crate::error::WorkflowError;
use crate::functions::Deps;
use crate::types::NodeState;

pub const NODE_STARTED_ID: &str = "nworkflow::node-started";
pub const NODE_STARTED_DESC: &str =
    "Internal: called by a queue-backed workflow function when a worker starts processing. Payload: {run_id, node_uid, attempt?, worker_name?}.";

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct NodeStartedEvent {
    pub run_id: String,
    pub node_uid: String,
    #[serde(default)]
    pub attempt: Option<u32>,
    #[serde(default)]
    pub worker_name: Option<String>,
}

pub async fn handle(deps: &Deps, event: NodeStartedEvent) -> Result<(), WorkflowError> {
    let _guard = deps.locks.guard(&event.run_id).await;
    let Some(mut record) = crate::state::get_run(&deps.iii, &event.run_id).await? else {
        return Ok(());
    };

    let Some(checkpoint) = record.nodes.get_mut(&event.node_uid) else {
        return Ok(());
    };
    if checkpoint.state != NodeState::Running {
        return Ok(());
    }
    if let Some(attempt) = event.attempt {
        if checkpoint.retries != attempt {
            return Ok(());
        }
    }

    checkpoint.pending_at = Some(deps.now_ms());
    checkpoint.pending_timeout_ms = Some(deps.cfg().await.default_pending_timeout_ms);
    if event.worker_name.is_some() {
        checkpoint.worker_name = event.worker_name;
    }
    record.updated_at = deps.now_ms();
    crate::state::put_run(&deps.iii, &record).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_payload_accepts_optional_attempt_and_worker() {
        let event: NodeStartedEvent = serde_json::from_value(serde_json::json!({
            "run_id": "r_1",
            "node_uid": "step#0",
            "attempt": 2,
            "worker_name": "worker-a"
        }))
        .expect("valid node-started payload");

        assert_eq!(event.attempt, Some(2));
        assert_eq!(event.worker_name.as_deref(), Some("worker-a"));
    }
}