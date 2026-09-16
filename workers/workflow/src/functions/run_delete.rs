use std::collections::BTreeMap;

use crate::error::WorkflowError;
use crate::functions::Deps;
use crate::types::NodeState;
use iii_sdk::protocol::TriggerRequest;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RunDeleteRequest {
    pub run_id: String,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RunDeleteResponse {
    pub deleted: bool,
    #[serde(default)]
    pub had_run: bool,
    #[serde(default)]
    pub was_terminal: bool,
    #[serde(default)]
    pub stopped_sessions: u32,
    #[serde(default)]
    pub queue_cleanup_attempted: usize,
    #[serde(default)]
    pub queue_cleanup_succeeded: usize,
    #[serde(default)]
    pub queue_cleanup_errors: BTreeMap<String, String>,
    /// `ctx.callWorkflow(...)` child runs cascade-deleted before this run.
    #[serde(default)]
    pub child_workflows_deleted: u32,
    /// Child runs whose cascade-delete RPC failed; their link is kept so a
    /// later delete attempt on this run can retry them.
    #[serde(default)]
    pub child_workflows_failed: u32,
}

pub async fn handle(
    deps: &Deps,
    req: RunDeleteRequest,
) -> Result<RunDeleteResponse, WorkflowError> {
    delete_run_by_id(deps, &req.run_id).await
}

pub async fn delete_run_by_id(
    deps: &Deps,
    run_id: &str,
) -> Result<RunDeleteResponse, WorkflowError> {
    let _g = deps.locks.guard(run_id).await;

    let Some(record) = crate::state::get_run(&deps.iii, run_id).await? else {
        return Ok(RunDeleteResponse {
            deleted: false,
            had_run: false,
            was_terminal: false,
            stopped_sessions: 0,
            queue_cleanup_attempted: 0,
            queue_cleanup_succeeded: 0,
            queue_cleanup_errors: BTreeMap::new(),
            child_workflows_deleted: 0,
            child_workflows_failed: 0,
        });
    };

    let was_terminal = record.status.is_terminal();

    // Child artifacts before the parent record: cascade-delete every
    // ctx.callWorkflow(...) child run (deepest first, via the same
    // nworkflow::run-delete RPC a caller would use) before touching this run's
    // own artifacts. A link is only cleared once its child is confirmed gone,
    // so a failed cascade step leaves a retryable trail instead of an orphan.
    let child_links = crate::state::list_child_workflow_links_for_run(run_id)
        .await
        .unwrap_or_default();
    let mut child_workflows_deleted = 0u32;
    let mut child_workflows_failed = 0u32;
    let cascade_timeout_ms = deps.cfg().await.cleanup_timeout_ms;
    for link in &child_links {
        let delete_res = deps
            .trigger_bounded(
                TriggerRequest {
                    function_id: "nworkflow::run-delete".into(),
                    payload: json!({ "run_id": link.child_run_id }),
                    action: None,
                    timeout_ms: None,
                },
                cascade_timeout_ms,
            )
            .await;
        match delete_res {
            Ok(_) => {
                child_workflows_deleted += 1;
                let _ = crate::state::delete_child_workflow_link(&link.child_run_id).await;
            }
            Err(e) => {
                child_workflows_failed += 1;
                tracing::warn!(
                    run_id = %run_id,
                    child_run_id = %link.child_run_id,
                    error = %e,
                    "failed to cascade-delete child workflow run; link kept for retry"
                );
            }
        }
    }

    // Best-effort stop cascade for any still-running harness sessions.
    let timeout_ms = deps.cfg().await.cleanup_timeout_ms;
    let mut stopped_sessions = 0u32;
    for sid in collect_running_sessions(&record.nodes) {
        let stop_res = deps
            .trigger_bounded(
                TriggerRequest {
                    function_id: "harness::stop".into(),
                    payload: json!({ "session_id": sid }),
                    action: None,
                    timeout_ms: None,
                },
                timeout_ms,
            )
            .await;
        if stop_res.is_ok() {
            stopped_sessions += 1;
        }
    }

    // Best-effort cleanup by tracked queue receipts for this run.
    let tracked_receipts = deps
        .internal_state
        .list_queue_receipts(run_id)
        .await
        .unwrap_or_default();

    let mut queue_cleanup_attempted = 0usize;
    let mut queue_cleanup_succeeded = 0usize;
    let mut queue_cleanup_errors: BTreeMap<String, String> = BTreeMap::new();
    for rec in &tracked_receipts {
        queue_cleanup_attempted += 1;
        match cleanup_queue_receipt(deps, &rec.queue, &rec.receipt_id, timeout_ms).await {
            Ok(()) => queue_cleanup_succeeded += 1,
            Err(e) => {
                queue_cleanup_errors.insert(rec.receipt_id.clone(), e);
            }
        }
    }

    if let Some(def) = crate::state::get_def(&deps.iii, &record.def_ref).await? {
        let result = match record.result_ref.as_deref() {
            Some(result_ref) => crate::state::get_run_result(&deps.iii, result_ref).await?,
            None => None,
        };
        super::lifecycle_hooks::emit_delete(deps, &def, &record, result).await;
    }

    crate::state::delete_run(&deps.iii, &record).await?;

    Ok(RunDeleteResponse {
        deleted: true,
        had_run: true,
        was_terminal,
        stopped_sessions,
        queue_cleanup_attempted,
        queue_cleanup_succeeded,
        queue_cleanup_errors,
        child_workflows_deleted,
        child_workflows_failed,
    })
}

async fn cleanup_queue_receipt(
    deps: &Deps,
    queue: &str,
    receipt_id: &str,
    timeout_ms: u64,
) -> Result<(), String> {
    // Compatibility matrix: queue cleanup surfaces can differ across versions.
    // We try known variants in sequence and accept the first success.
    let candidates: [(&str, serde_json::Value); 4] = [
        (
            "iii::queue::discard_message",
            json!({ "topic": queue, "message_id": receipt_id }),
        ),
        (
            "iii::queue::discard_message",
            json!({ "queue": queue, "message_id": receipt_id }),
        ),
        (
            "engine::queue::discard_message",
            json!({ "topic": queue, "message_id": receipt_id }),
        ),
        (
            "engine::queue::discard_message",
            json!({ "queue": queue, "message_id": receipt_id }),
        ),
    ];

    let mut last_err = String::new();
    for (function_id, payload) in candidates {
        match deps
            .trigger_bounded(
                TriggerRequest {
                    function_id: function_id.to_string(),
                    payload,
                    action: None,
                    timeout_ms: None,
                },
                timeout_ms,
            )
            .await
        {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_err = format!("{}: {}", function_id, e);
            }
        }
    }

    if last_err.is_empty() {
        Err("no cleanup API variant available".to_string())
    } else {
        Err(last_err)
    }
}

fn collect_running_sessions(
    nodes: &std::collections::BTreeMap<String, crate::types::NodeCheckpoint>,
) -> Vec<String> {
    nodes
        .values()
        .filter(|cp| cp.state == NodeState::Running)
        .filter_map(|cp| cp.session_id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrip() {
        let req = RunDeleteRequest {
            run_id: "r_123".to_string(),
        };
        let v = serde_json::to_value(&req).expect("serialize request");
        assert_eq!(v["run_id"], "r_123");
        let decoded: RunDeleteRequest = serde_json::from_value(v).expect("deserialize request");
        assert_eq!(decoded.run_id, "r_123");
    }

    #[test]
    fn response_roundtrip() {
        let resp = RunDeleteResponse {
            deleted: true,
            had_run: true,
            was_terminal: true,
            stopped_sessions: 0,
            queue_cleanup_attempted: 1,
            queue_cleanup_succeeded: 1,
            queue_cleanup_errors: BTreeMap::new(),
            child_workflows_deleted: 0,
            child_workflows_failed: 0,
        };

        let v = serde_json::to_value(&resp).expect("serialize response");
        let decoded: RunDeleteResponse = serde_json::from_value(v).expect("deserialize response");
        assert!(decoded.deleted);
        assert!(decoded.had_run);
        assert!(decoded.was_terminal);
        assert_eq!(decoded.queue_cleanup_succeeded, 1);
    }
}
