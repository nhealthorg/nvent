//! ctx.callWorkflow integration for nworkflow
//!
//! A `child_workflow` node starts another (possibly the same) registered
//! workflow as an independent run and waits for its terminal result. This
//! module fires the child (`nworkflow::child-start`) and reconciles its
//! completion back onto the parent node (`nworkflow::child-completed`), reusing
//! the same session-index / notify machinery already built for sub-workflow
//! nesting depth tracking and for agent-node completion.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::WorkflowError;
use crate::functions::{node_completed, Deps};
use crate::ids;
use crate::types::{ChildWorkflowLinkRecord, NotifySpec};

pub const CHILD_START_ID: &str = "nworkflow::child-start";
pub const CHILD_COMPLETED_ID: &str = "nworkflow::child-completed";

/// Reserved wrapper key `defineWorkflow`'s registered handler unwraps to learn
/// this trigger is a nested `ctx.callWorkflow(...)` call rather than a plain
/// top-level invocation, mirroring the existing `_workflow` wrapper convention
/// used for plain function nodes.
pub const CHILD_WORKFLOW_WRAPPER_KEY: &str = "_childWorkflow";

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ChildStartRequest {
    pub run_id: String,
    pub node_uid: String,
    #[serde(default)]
    pub attempt: u32,
    /// Registered function id of the target workflow.
    pub workflow: String,
    #[serde(default)]
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ChildStartResponse {
    pub child_run_id: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ChildCompletedPayload {
    pub run_id: String,
    pub status: String,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub result_error: Option<String>,
}

async fn resolve_completed_result(
    deps: &Deps,
    child_run_id: &str,
    payload_result: Option<Value>,
) -> Result<Option<Value>, WorkflowError> {
    if payload_result.is_some() {
        return Ok(payload_result);
    }

    let Some(child_record) = crate::state::get_run(&deps.iii, child_run_id).await? else {
        return Ok(None);
    };
    let Some(result_ref) = child_record.result_ref.as_deref() else {
        return Ok(None);
    };

    crate::state::get_run_result(&deps.iii, result_ref).await
}

/// Build the payload sent to the target workflow's own registered function.
/// `defineWorkflow`'s handler unwraps `_childWorkflow` to extract
/// `callerSessionId`/`notify` for its `nworkflow::start` call and uses `input`
/// as the actual workflow input, so an unrelated top-level trigger (no
/// wrapper) is completely unaffected.
fn wrapped_trigger_payload(caller_session_id: &str, idempotency_key: &str, input: Value) -> Value {
    json!({
        CHILD_WORKFLOW_WRAPPER_KEY: {
            "callerSessionId": caller_session_id,
            "idempotencyKey": idempotency_key,
            "notify": notify_spec(),
        },
        "input": input,
    })
}

fn child_attempt_identity(run_id: &str, node_uid: &str, attempt: u32) -> (String, String) {
    let attempt_node_uid = format!("{}@r{}", node_uid, attempt);
    (
        ids::child_session_id(run_id, &attempt_node_uid),
        format!("child:{}:{}:attempt:{}", run_id, node_uid, attempt),
    )
}

/// Fire a `child_workflow` node: start the target workflow as an independent
/// run, link it back to this node, and return its `run_id` so the caller
/// (`tick::fire_node`) can stamp `NodeCheckpoint.child_run_id` synchronously.
pub async fn start_child_workflow_task(
    deps: &Deps,
    req: ChildStartRequest,
) -> Result<ChildStartResponse, WorkflowError> {
    let (caller_session_id, idempotency_key) =
        child_attempt_identity(&req.run_id, &req.node_uid, req.attempt);

    // A retry after the child was accepted but before the response/link was
    // persisted must reuse the same start key. This also makes recovery safe
    // when the parent tick is redelivered.
    if let Some(existing_link) = crate::state::list_child_workflow_links_for_run(&req.run_id)
        .await?
        .into_iter()
        .find(|link| link.parent_node_uid == req.node_uid && link.attempt == req.attempt)
    {
        return Ok(ChildStartResponse {
            child_run_id: existing_link.child_run_id,
        });
    }

    crate::state::put_session_index(&deps.iii, &caller_session_id, &req.run_id).await?;

    let dispatch_timeout_ms = deps.cfg().await.dispatch_timeout_ms;
    let payload = wrapped_trigger_payload(&caller_session_id, &idempotency_key, req.input);

    let response = deps
        .trigger_bounded(
            iii_sdk::protocol::TriggerRequest {
                function_id: req.workflow.clone(),
                payload,
                action: None,
                timeout_ms: None,
            },
            dispatch_timeout_ms,
        )
        .await
        .map_err(|e| {
            WorkflowError::Trigger(format!(
                "failed to start child workflow '{}': {e}",
                req.workflow
            ))
        })?;

    let child_run_id = response
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            WorkflowError::Trigger(format!(
                "child workflow '{}' did not return a run_id",
                req.workflow
            ))
        })?
        .to_string();

    crate::state::put_child_workflow_link(&ChildWorkflowLinkRecord {
        child_run_id: child_run_id.clone(),
        parent_run_id: req.run_id.clone(),
        parent_node_uid: req.node_uid.clone(),
        attempt: req.attempt,
        created_at: deps.now_ms(),
    })
    .await?;

    // Best-effort: stamp the child's own record with its direct parent linkage
    // (root_run_id/root_stream_scope_id are derived at nworkflow::start time
    // from the caller_session_id chain; parent_node_uid is only knowable here,
    // once the child_run_id is back).
    if let Some(mut child_record) = crate::state::get_run(&deps.iii, &child_run_id).await? {
        child_record.parent_node_uid = Some(req.node_uid.clone());
        child_record.updated_at = deps.now_ms();
        let _ = crate::state::put_run(&deps.iii, &child_record).await;
    }

    Ok(ChildStartResponse { child_run_id })
}

/// `notify` target for a completed/failed/cancelled child run: resolve which
/// parent node started it and reconcile that node via the same
/// `node_completed` path every other node type (function/agent) already uses.
pub async fn handle_completed(
    deps: &Deps,
    payload: ChildCompletedPayload,
) -> Result<(), WorkflowError> {
    let Some(link) = crate::state::get_child_workflow_link(&payload.run_id).await? else {
        tracing::warn!(
            child_run_id = %payload.run_id,
            "no child workflow link found for completed run; relying on reconcile fallback"
        );
        return Ok(());
    };

    // A completion from a timed-out attempt must not complete a newer retry.
    if let Some(parent_record) = crate::state::get_run(&deps.iii, &link.parent_run_id).await? {
        let current_checkpoint = parent_record.nodes.get(&link.parent_node_uid);
        let current_child = current_checkpoint
            .and_then(|checkpoint| checkpoint.child_run_id.as_deref());
        if current_child != Some(payload.run_id.as_str())
            || current_checkpoint.is_none_or(|checkpoint| {
                checkpoint.state != crate::types::NodeState::Running
            })
        {
            tracing::warn!(
                parent_run_id = %link.parent_run_id,
                node_uid = %link.parent_node_uid,
                stale_child_run_id = %payload.run_id,
                current_child_run_id = ?current_child,
                "ignoring stale child workflow completion"
            );
            return crate::state::delete_child_workflow_link(&payload.run_id).await;
        }
    }

    let (result, result_error) = match payload.status.as_str() {
        "completed" => {
            match resolve_completed_result(deps, &payload.run_id, payload.result).await? {
                Some(result) => (Some(result), None),
                None => (
                    None,
                    Some(format!(
                        "child workflow (run {}) completed without a stored result",
                        payload.run_id
                    )),
                ),
            }
        }
        "failed" => {
            let failure = format!(
                "child workflow (run {}) failed: {}",
                payload.run_id,
                payload.result_error.as_deref().unwrap_or("failed")
            );
            let previous = crate::state::get_run(&deps.iii, &link.parent_run_id)
                .await?
                .and_then(|record| {
                    record
                        .nodes
                        .get(&link.parent_node_uid)
                        .and_then(|checkpoint| checkpoint.result_error.clone())
                });
            (
                None,
                Some(match previous {
                    Some(previous) => format!("{previous}; {failure}"),
                    None => failure,
                }),
            )
        }
        _ => {
            let cancellation = format!("child workflow (run {}) cancelled", payload.run_id);
            let previous = crate::state::get_run(&deps.iii, &link.parent_run_id)
                .await?
                .and_then(|record| {
                    record
                        .nodes
                        .get(&link.parent_node_uid)
                        .and_then(|checkpoint| checkpoint.result_error.clone())
                });
            (
                None,
                Some(match previous {
                    Some(previous) => format!("{previous}; {cancellation}"),
                    None => cancellation,
                }),
            )
        }
    };

    node_completed::handle(
        deps,
        node_completed::NodeCompletedEvent {
            run_id: link.parent_run_id,
            node_uid: link.parent_node_uid,
            trace_id: None,
            function_id: Some(CHILD_START_ID.to_string()),
            runtime: Some("workflow".to_string()),
            result,
            result_error,
            attempt: None,
        },
    )
    .await?;

    crate::state::delete_child_workflow_link(&payload.run_id).await
}

/// Completion callback registered on the child's `nworkflow::start` call.
pub fn notify_spec() -> NotifySpec {
    NotifySpec {
        function_id: CHILD_COMPLETED_ID.to_string(),
        queue: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapped_trigger_payload_carries_caller_session_and_notify() {
        let payload = wrapped_trigger_payload(
            "wf_r_parent_invoice",
            "child:wf_r_parent:invoice",
            json!({ "orderId": "o1" }),
        );

        assert_eq!(
            payload[CHILD_WORKFLOW_WRAPPER_KEY]["callerSessionId"],
            "wf_r_parent_invoice"
        );
        assert_eq!(
            payload[CHILD_WORKFLOW_WRAPPER_KEY]["notify"]["function_id"],
            CHILD_COMPLETED_ID
        );
        assert_eq!(
            payload[CHILD_WORKFLOW_WRAPPER_KEY]["idempotencyKey"],
            "child:wf_r_parent:invoice"
        );
        assert_eq!(payload["input"]["orderId"], "o1");
    }

    #[test]
    fn notify_spec_targets_child_completed() {
        let spec = notify_spec();
        assert_eq!(spec.function_id, CHILD_COMPLETED_ID);
        assert!(spec.queue.is_none());
    }

    #[test]
    fn retry_attempts_have_distinct_stable_child_identity() {
        let first = child_attempt_identity("r_parent", "patient#0", 0);
        let retry = child_attempt_identity("r_parent", "patient#0", 1);
        assert_ne!(first, retry);
        assert_eq!(first, child_attempt_identity("r_parent", "patient#0", 0));
        assert!(retry.0.ends_with("patient#0@r1"));
        assert!(retry.1.ends_with(":attempt:1"));
    }
}
