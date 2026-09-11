use crate::error::WorkflowError;
use crate::functions::{start, Deps};
use crate::types::{NodeState, RunStatus, WorkflowDef};
use iii_sdk::protocol::TriggerRequest;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StopRequest {
    pub run_id: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct StopResponse {
    pub stopping: bool,
    #[serde(default)]
    pub stopped_sessions: u32,
    #[serde(default)]
    pub queue_fragments_detected: u64,
    #[serde(default)]
    pub checked_queues: Vec<String>,
    #[serde(default)]
    pub tracked_receipt_count: usize,
    #[serde(default)]
    pub tracked_receipt_ids: Vec<String>,
    /// Number of per-receipt cleanup calls attempted.
    #[serde(default)]
    pub queue_cleanup_attempted: usize,
    /// Number of receipts successfully cleaned up.
    #[serde(default)]
    pub queue_cleanup_succeeded: usize,
    /// Best-effort errors keyed by receipt id.
    #[serde(default)]
    pub queue_cleanup_errors: BTreeMap<String, String>,
}

// ---------------------------------------------------------------------------
// should_stop (pure classifier)
// ---------------------------------------------------------------------------

pub fn should_stop(status: RunStatus) -> bool {
    !status.is_terminal()
}

// ---------------------------------------------------------------------------
// handle
// ---------------------------------------------------------------------------

pub async fn handle(deps: &Deps, req: StopRequest) -> Result<StopResponse, WorkflowError> {
    let cleanup_timeout_ms = deps.cfg().await.cleanup_timeout_ms;
    let _guard = deps
        .locks
        .guard_bounded(&req.run_id, cleanup_timeout_ms)
        .await
        .ok_or_else(|| {
            WorkflowError::State(format!(
                "timed out acquiring run lock for stop after {cleanup_timeout_ms}ms: {}",
                req.run_id
            ))
        })?;

    let Some(mut record) = crate::state::get_run(&deps.iii, &req.run_id).await? else {
        return Ok(StopResponse {
            stopping: false,
            stopped_sessions: 0,
            queue_fragments_detected: 0,
            checked_queues: Vec::new(),
            tracked_receipt_count: 0,
            tracked_receipt_ids: Vec::new(),
            queue_cleanup_attempted: 0,
            queue_cleanup_succeeded: 0,
            queue_cleanup_errors: BTreeMap::new(),
        }); // unknown run: no-op
    };

    if !should_stop(record.status) {
        return Ok(StopResponse {
            stopping: false,
            stopped_sessions: 0,
            queue_fragments_detected: 0,
            checked_queues: Vec::new(),
            tracked_receipt_count: 0,
            tracked_receipt_ids: Vec::new(),
            queue_cleanup_attempted: 0,
            queue_cleanup_succeeded: 0,
            queue_cleanup_errors: BTreeMap::new(),
        }); // already terminal: no-op
    }

    let def = crate::state::get_def(&deps.iii, &record.def_ref)
        .await?
        .map(|d| crate::functions::start::prepare_definition_for_execution(&d));

    let running_session_ids = collect_running_sessions(&record.nodes);
    let queue_candidates = collect_queue_candidates(&record.nodes);

    // Terminal-first: persist the cancellation before any best-effort remote cleanup so
    // an unreachable/slow harness or queue worker cannot stall the caller's invocation.
    let now = deps.now_ms();
    for cp in record.nodes.values_mut() {
        if !matches!(
            cp.state,
            NodeState::Done | NodeState::Failed | NodeState::Cancelled
        ) {
            cp.state = NodeState::Cancelled;
            cp.completed_at = Some(now);
            if cp.result_error.is_none() {
                cp.result_error = Some("cancelled".to_string());
            }
        }
    }

    record.abort = true;
    record.status = RunStatus::Cancelled;
    record.updated_at = now;
    crate::state::put_run(&deps.iii, &record).await?;

    // Best-effort stop cascade for session-backed nodes.
    let mut stopped_sessions = 0u32;
    for sid in running_session_ids {
        let stop_res = deps
            .trigger_bounded(
                TriggerRequest {
                    function_id: "harness::stop".into(),
                    payload: json!({ "session_id": sid }),
                    action: None,
                    timeout_ms: None,
                },
                cleanup_timeout_ms,
            )
            .await;
        match stop_res {
            Ok(_) => stopped_sessions += 1,
            Err(e) => {
                tracing::warn!(run_id = %req.run_id, error = %e, "cancel: harness::stop failed")
            }
        }
    }

    // Inspect queue depths for queues that currently host running function nodes
    // of this run. This is best-effort visibility (topic-level depth, not per-message).
    let mut checked_queues: Vec<String> = Vec::new();
    let mut queue_fragments_detected: u64 = 0;
    if let Some(def) = def.as_ref() {
        let queue_names = queues_for_candidates(def, &queue_candidates);
        for queue in queue_names {
            checked_queues.push(queue.clone());
            let depth = topic_depth(deps, &queue, cleanup_timeout_ms)
                .await
                .unwrap_or(0);
            queue_fragments_detected = queue_fragments_detected.saturating_add(depth);
        }
    }

    let tracked_receipts = deps
        .internal_state
        .list_queue_receipts(&req.run_id)
        .await
        .unwrap_or_default();
    let tracked_receipt_count = tracked_receipts.len();
    let tracked_receipt_ids: Vec<String> = tracked_receipts
        .iter()
        .map(|r| r.receipt_id.clone())
        .collect();

    // Best-effort cleanup by tracked receipt ids.
    let mut queue_cleanup_attempted = 0usize;
    let mut queue_cleanup_succeeded = 0usize;
    let mut queue_cleanup_errors: BTreeMap<String, String> = BTreeMap::new();
    for rec in &tracked_receipts {
        queue_cleanup_attempted += 1;
        match cleanup_queue_receipt(deps, &rec.queue, &rec.receipt_id, cleanup_timeout_ms).await {
            Ok(()) => queue_cleanup_succeeded += 1,
            Err(e) => {
                queue_cleanup_errors.insert(rec.receipt_id.clone(), e);
            }
        }
    }

    // Stop transitions the run directly to terminal state. Clear per-run
    // in-process payload caches immediately instead of waiting for retention GC.
    let _ = crate::state::delete_run_input_memory(&req.run_id);
    let _ = crate::state::delete_all_fanout_items_memory(&req.run_id);
    let _ = crate::state::delete_all_node_results_memory(&req.run_id);

    // Best effort callback push for callers using `notify`.
    let _ = tokio::time::timeout(
        Duration::from_millis(cleanup_timeout_ms.max(1)),
        crate::events::emit_notify(deps, &record),
    )
    .await;

    // Re-drive once so any stale in-flight hooks observe terminal state quickly.
    let _ = tokio::time::timeout(
        Duration::from_millis(cleanup_timeout_ms.max(1)),
        start::enqueue_tick(&deps.iii, &req.run_id, record.step + 1),
    )
    .await;

    Ok(StopResponse {
        stopping: true,
        stopped_sessions,
        queue_fragments_detected,
        checked_queues,
        tracked_receipt_count,
        tracked_receipt_ids,
        queue_cleanup_attempted,
        queue_cleanup_succeeded,
        queue_cleanup_errors,
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

fn collect_running_sessions(nodes: &BTreeMap<String, crate::types::NodeCheckpoint>) -> Vec<String> {
    nodes
        .values()
        .filter(|cp| cp.state == NodeState::Running)
        .filter_map(|cp| cp.session_id.clone())
        .collect()
}

fn collect_queue_candidates(nodes: &BTreeMap<String, crate::types::NodeCheckpoint>) -> Vec<String> {
    nodes
        .iter()
        .filter(|(_, cp)| cp.state == NodeState::Running && cp.session_id.is_none())
        .map(|(uid, _)| uid.clone())
        .collect()
}

fn queues_for_candidates(def: &WorkflowDef, candidates: &[String]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for uid in candidates {
        let base_id = uid.split('#').next().unwrap_or(uid);
        let queue = def
            .nodes
            .get(base_id)
            .map(|n| n.effective_function())
            .and_then(|f| f.queue.map(|q| q.trim().to_string()))
            .filter(|q| !q.is_empty())
            .unwrap_or_else(|| "default".to_string());
        out.insert(queue);
    }
    out
}

async fn topic_depth(deps: &Deps, topic: &str, timeout_ms: u64) -> Option<u64> {
    let resp = deps
        .trigger_bounded(
            TriggerRequest {
                function_id: "engine::queue::topic_stats".into(),
                payload: json!({ "topic": topic }),
                action: None,
                timeout_ms: None,
            },
            timeout_ms,
        )
        .await
        .ok()?;

    resp.get("depth").and_then(|v| v.as_u64())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::types::RunStatus;

    #[test]
    fn stopping_false_for_terminal_status() {
        assert!(!super::should_stop(RunStatus::Completed));
        assert!(!super::should_stop(RunStatus::Cancelled));
        assert!(super::should_stop(RunStatus::Running));
        assert!(super::should_stop(RunStatus::AwaitingNodes));
    }
}
