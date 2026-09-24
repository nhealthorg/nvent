use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::{
    error::WorkflowError,
    ids::new_ref_id,
    state,
    types::{NodeCheckpoint, NodeState, RunStatus, WorkflowDef, WorkflowRunRecord},
};

fn effective_max_retries(def: &WorkflowDef, node_uid: &str, fallback: u32) -> u32 {
    let base_id = node_uid.split('#').next().unwrap_or(node_uid);
    def.nodes
        .get(base_id)
        .map(|n| n.effective_function())
        .and_then(|f| f.engine_retry)
        .and_then(|r| r.max_attempts)
        .unwrap_or(fallback)
}

// ---------------------------------------------------------------------------
// NodeOutcome
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum NodeOutcome {
    StillRunning,
    Done(Value),
    Failed(String),
    Cancelled,
}

#[derive(Debug, PartialEq)]
enum FunctionFailureAction {
    Retry { attempt: u32 },
    Fail { result_error: String },
}

// ---------------------------------------------------------------------------
// Result size cap
// ---------------------------------------------------------------------------

/// Max serialized bytes for a single node result. A result flows verbatim into
/// downstream nodes' prompts AND is loaded into memory on every tick
/// (`load_done_results`), so an unbounded blob is a memory / cost / provider-reject
/// hazard. Passing megabytes inline between agents is an anti-pattern (pass a
/// reference/key instead), so an oversized result is REJECTED (the node fails)
/// rather than truncated — truncation would yield malformed JSON that derails
/// gather_input / fanout downstream. Safety ceiling, tunable.
const MAX_RESULT_BYTES: usize = 1 << 20; // 1 MiB

/// `Some(len)` if the serialized result exceeds the cap, else `None`. Pure.
fn oversized_result(result: &Value) -> Option<usize> {
    let len = serde_json::to_string(result).map(|s| s.len()).unwrap_or(0);
    (len > MAX_RESULT_BYTES).then_some(len)
}

// ---------------------------------------------------------------------------
// classify_terminal (pure)
// ---------------------------------------------------------------------------

/// Classify a harness turn status into a `NodeOutcome`.
///
/// Rules (in priority order):
/// 1. `"completed"` + `result_error` present → `Failed` (contract violation)
/// 2. `"completed"` (no error) → `Done(result)` if within `MAX_RESULT_BYTES`,
///    else `Failed` (oversized output rejected)
/// 3. `"failed"` → `Failed(result_error.unwrap_or("failed"))`
/// 4. `"cancelled"` → `Cancelled`
/// 5. anything else → `StillRunning`
pub fn classify_terminal(
    status: &str,
    result: Option<Value>,
    result_error: Option<String>,
) -> NodeOutcome {
    match status {
        "completed" => {
            if let Some(err) = result_error {
                NodeOutcome::Failed(err)
            } else {
                let res = result.unwrap_or(Value::Null);
                match oversized_result(&res) {
                    Some(len) => NodeOutcome::Failed(format!(
                        "node result is {len} bytes, exceeds the cap of {MAX_RESULT_BYTES} \
                         (oversized output rejected; pass a reference, not the blob)"
                    )),
                    None => NodeOutcome::Done(res),
                }
            }
        }
        "failed" => NodeOutcome::Failed(result_error.unwrap_or_else(|| "failed".into())),
        "cancelled" => NodeOutcome::Cancelled,
        _ => NodeOutcome::StillRunning,
    }
}

fn function_failure_action(retries: u32, max_retries: u32, error: &str) -> FunctionFailureAction {
    if retries < max_retries {
        return FunctionFailureAction::Retry {
            attempt: retries + 1,
        };
    }

    let result_error = if retries == 0 {
        error.to_string()
    } else {
        format!(
            "{error} (retry budget exhausted after {retries} retr{})",
            if retries == 1 { "y" } else { "ies" }
        )
    };

    FunctionFailureAction::Fail { result_error }
}

async fn retry_or_fail_function_node(
    deps: &crate::functions::Deps,
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
    uid: &str,
    error: &str,
    now: i64,
    max_retries: u32,
    results_cache: &mut Option<BTreeMap<String, Value>>,
    pending_stream_events: &mut Vec<crate::functions::stream_publish::StreamPublishRequest>,
) -> Result<(), WorkflowError> {
    let retries = record.nodes.get(uid).map(|cp| cp.retries).unwrap_or(0);

    match function_failure_action(retries, max_retries, error) {
        FunctionFailureAction::Retry { attempt } => {
            tracing::info!(
                run_id = %record.run_id,
                node_uid = %uid,
                attempt,
                max_retries,
                error = %error,
                "retrying function node after reported failure"
            );

            state::delete_node_result(&deps.iii, &record.run_id, uid).await?;

            if let Some(cp) = record.nodes.get_mut(uid) {
                cp.retries = attempt;
            }

            if results_cache.is_none() {
                *results_cache = Some(state::load_done_results(&deps.iii, record).await?);
            }

            crate::functions::tick::fire_node(
                deps,
                record,
                def,
                uid,
                results_cache.as_ref().expect("results cache initialized"),
                pending_stream_events,
            )
            .await?;
        }
        FunctionFailureAction::Fail { result_error } => {
            if let Some(cp) = record.nodes.get_mut(uid) {
                cp.state = NodeState::Failed;
                cp.result_error = Some(result_error);
                cp.completed_at = Some(now);
                let dur = cp
                    .pending_at
                    .map(|p| (now - p).max(0) as f64)
                    .unwrap_or(0.0);
                crate::telemetry::record_node_terminal(false, dur);
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// reconcile_function_nodes
// ---------------------------------------------------------------------------

/// Running nodes dispatched as a plain function/queue call: no `session_id`
/// (not harness-backed) and no `child_run_id` (a `ctx.callWorkflow` node —
/// those are polled separately, against the child run's own status). Pure.
fn collect_running_function_node_uids(nodes: &BTreeMap<String, NodeCheckpoint>) -> Vec<String> {
    nodes
        .iter()
        .filter(|(_, cp)| {
            cp.state == NodeState::Running && cp.session_id.is_none() && cp.child_run_id.is_none()
        })
        .map(|(uid, _)| uid.clone())
        .collect()
}

/// Poll Running function-based nodes (those without session_id) for completion.
/// Functions write their result via state::put and optionally emit
/// workflow::node-completed to wake the tick (fast path). This polling is the
/// slow path: the sweep calls it periodically for eventual completion detection.
pub async fn reconcile_function_nodes(
    deps: &crate::functions::Deps,
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
    pending_stream_events: &mut Vec<crate::functions::stream_publish::StreamPublishRequest>,
) -> Result<(), WorkflowError> {
    // Find Running nodes without session_id (function-based execution). Child-workflow
    // nodes also have session_id == None but are reconciled separately, against the
    // child run's own status, by `reconcile_child_workflow_nodes`.
    let running_functions: Vec<String> = collect_running_function_node_uids(&record.nodes);

    if !running_functions.is_empty() {
        tracing::debug!(
            run_id = %record.run_id,
            running_nodes = ?running_functions,
            "polling running function nodes for completion"
        );
    }

    let now = deps.now_ms();
    let default_max_retries = deps.cfg().await.max_node_retries;
    let mut results_cache: Option<BTreeMap<String, Value>> = None;

    for uid in running_functions {
        // Try to read the result from state
        match state::get_node_result(&deps.iii, &record.run_id, &uid).await {
            Ok(Some(v)) => {
                // Detected a reported error from the worker
                if let Some(err_val) = v.get("__workflow_error__").and_then(|e| e.as_str()) {
                    tracing::warn!(
                        run_id = %record.run_id,
                        node_uid = %uid,
                        error = %err_val,
                        "function node failed - error reported in state"
                    );

                    retry_or_fail_function_node(
                        deps,
                        def,
                        record,
                        &uid,
                        err_val,
                        now,
                        effective_max_retries(def, &uid, default_max_retries),
                        &mut results_cache,
                        pending_stream_events,
                    )
                    .await?;
                    continue;
                }

                tracing::info!(
                    run_id = %record.run_id,
                    node_uid = %uid,
                    "function node completed - result found in state"
                );

                // Result is present: node completed successfully
                if let Some(cp) = record.nodes.get_mut(&uid) {
                    cp.result_ref = Some(new_ref_id("node_result"));
                    cp.state = NodeState::Done;
                    cp.completed_at = Some(now); // Track completion time
                    let dur = cp
                        .pending_at
                        .map(|p| (now - p).max(0) as f64)
                        .unwrap_or(0.0);
                    crate::telemetry::record_node_terminal(true, dur);
                }
            }
            Ok(None) => {
                // Result not yet written, node still running
                tracing::trace!(
                    run_id = %record.run_id,
                    node_uid = %uid,
                    "function node still running - no result yet"
                );
                continue;
            }
            Err(e) => {
                // State read error - treat as node failure
                tracing::warn!(
                    run_id = %record.run_id,
                    node = %uid,
                    error = %e,
                    "reconcile: failed to read node result from state"
                );
                if let Some(cp) = record.nodes.get_mut(&uid) {
                    cp.result_error = Some(format!("state read error: {}", e));
                    cp.state = NodeState::Failed;
                    cp.completed_at = Some(now); // Track completion time (failure)
                    let dur = cp
                        .pending_at
                        .map(|p| (now - p).max(0) as f64)
                        .unwrap_or(0.0);
                    crate::telemetry::record_node_terminal(false, dur);
                }
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// reconcile_child_workflow_nodes
// ---------------------------------------------------------------------------

/// `(node_uid, child_run_id)` pairs for every Running `child_workflow` node. Pure.
fn collect_running_child_workflow_nodes(
    nodes: &BTreeMap<String, NodeCheckpoint>,
) -> Vec<(String, String)> {
    nodes
        .iter()
        .filter(|(_, cp)| cp.state == NodeState::Running)
        .filter_map(|(uid, cp)| {
            cp.child_run_id
                .clone()
                .map(|child_id| (uid.clone(), child_id))
        })
        .collect()
}

/// Map a child run's status to the `classify_terminal` status string, or
/// `None` while it is still in flight. Pure.
fn child_terminal_status_str(status: RunStatus) -> Option<&'static str> {
    match status {
        RunStatus::Completed => Some("completed"),
        RunStatus::Failed => Some("failed"),
        RunStatus::Cancelled => Some("cancelled"),
        RunStatus::Running | RunStatus::AwaitingNodes => None,
    }
}

/// Parent-node `result_error` for a failed child run. Pure.
fn child_workflow_failed_message(child_run_id: &str, err: &str) -> String {
    format!("child workflow (run {child_run_id}) failed: {err}")
}

/// Parent-node `result_error` for a cancelled child run. Pure.
fn child_workflow_cancelled_message(child_run_id: &str) -> String {
    format!("child workflow (run {child_run_id}) cancelled")
}

fn classify_child_terminal(
    child_run_id: &str,
    status: &str,
    result: Option<Value>,
    result_error: Option<String>,
) -> NodeOutcome {
    if status == "completed" && result.is_none() {
        return NodeOutcome::Failed(format!(
            "child workflow (run {child_run_id}) completed without a stored result"
        ));
    }

    classify_terminal(status, result, result_error)
}

/// Poll Running `child_workflow` nodes against their target run's own status.
/// This is the pull-side fallback for `child_workflow::handle_completed` (the
/// push path via `notify`): if that callback is ever lost — worker restart,
/// dropped delivery — this closes the loop by directly checking whether the
/// child run already reached a terminal state.
pub async fn reconcile_child_workflow_nodes(
    deps: &crate::functions::Deps,
    record: &mut WorkflowRunRecord,
) -> Result<(), WorkflowError> {
    let running_children = collect_running_child_workflow_nodes(&record.nodes);

    let now = deps.now_ms();

    for (uid, child_run_id) in running_children {
        let Some(child_record) = state::get_run(&deps.iii, &child_run_id).await? else {
            // Vanished before reporting back (swept/deleted). Leave Running — the
            // timeout sweep is the backstop so the parent node doesn't hang forever.
            tracing::warn!(
                run_id = %record.run_id,
                node_uid = %uid,
                child_run_id = %child_run_id,
                "reconcile: child workflow run not found"
            );
            continue;
        };

        let status = match child_terminal_status_str(child_record.status) {
            Some(status) => status,
            None => continue,
        };

        let result = match child_record.result_ref.as_deref() {
            Some(result_ref) => state::get_run_result(&deps.iii, result_ref).await?,
            None => None,
        };

        tracing::info!(
            run_id = %record.run_id,
            node_uid = %uid,
            child_run_id = %child_run_id,
            status,
            "reconcile: child workflow run reached terminal state (pull fallback)"
        );

        let outcome = classify_child_terminal(
            &child_run_id,
            status,
            result,
            child_record.result_error.clone(),
        );

        match outcome {
            NodeOutcome::StillRunning => {
                unreachable!("status is always one of the terminal branches above")
            }
            NodeOutcome::Done(res) => {
                state::put_node_result(&deps.iii, &record.run_id, &uid, &res).await?;
                if let Some(cp) = record.nodes.get_mut(&uid) {
                    cp.result_ref = Some(new_ref_id("node_result"));
                    cp.state = NodeState::Done;
                    cp.completed_at = Some(now);
                    let dur = cp
                        .pending_at
                        .map(|p| (now - p).max(0) as f64)
                        .unwrap_or(0.0);
                    crate::telemetry::record_node_terminal(true, dur);
                }
            }
            NodeOutcome::Failed(err) => {
                if let Some(cp) = record.nodes.get_mut(&uid) {
                    cp.result_error = Some(child_workflow_failed_message(&child_run_id, &err));
                    cp.state = NodeState::Failed;
                    cp.completed_at = Some(now);
                    let dur = cp
                        .pending_at
                        .map(|p| (now - p).max(0) as f64)
                        .unwrap_or(0.0);
                    crate::telemetry::record_node_terminal(false, dur);
                }
            }
            NodeOutcome::Cancelled => {
                if let Some(cp) = record.nodes.get_mut(&uid) {
                    cp.result_error = Some(child_workflow_cancelled_message(&child_run_id));
                    cp.state = NodeState::Cancelled;
                    cp.completed_at = Some(now);
                }
            }
        }

        let _ = state::delete_child_workflow_link(&child_run_id).await;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// reconcile_run
// ---------------------------------------------------------------------------

/// For each `Running` checkpoint that has a `session_id`, poll
/// `harness::status` and advance the checkpoint to its terminal state (Done /
/// Failed / Cancelled).  Skips unknown sessions (null response) and mismatched
/// `turn_id` values (re-seed guard).
pub async fn reconcile_run(
    deps: &crate::functions::Deps,
    record: &mut WorkflowRunRecord,
) -> Result<(), WorkflowError> {
    // Collect the (uid, session_id, turn_id) tuples for all Running nodes so
    // we don't hold a &mut reference across .await points.
    let running: Vec<(String, String, Option<String>)> = record
        .nodes
        .iter()
        .filter(|(_, cp)| cp.state == NodeState::Running)
        .filter_map(|(uid, cp)| {
            cp.session_id
                .as_ref()
                .map(|sid| (uid.clone(), sid.clone(), cp.turn_id.clone()))
        })
        .collect();

    let timeout_ms = deps.cfg().await.dispatch_timeout_ms;
    let now = deps.now_ms();

    for (uid, session_id, expected_turn_id) in running {
        // Poll harness::status. A transient/timeout error polling ONE node must NOT
        // abort reconciliation of the rest of the run (which previously bubbled up,
        // failed the whole tick, and dead-lettered). Log and move on — the node
        // stays Running and is re-polled next tick; the timeout sweep is the backstop.
        let resp = match deps
            .trigger_bounded(
                iii_sdk::protocol::TriggerRequest {
                    function_id: "harness::status".into(),
                    payload: json!({
                        "session_id": session_id,
                        "verbose": true,
                    }),
                    action: None,
                    timeout_ms: None,
                },
                timeout_ms,
            )
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                tracing::warn!(
                    run_id = %record.run_id,
                    node = %uid,
                    session_id = %session_id,
                    error = %e,
                    "reconcile: harness::status poll failed; leaving node Running"
                );
                continue;
            }
        };

        // Null → unknown session, still running
        if resp.is_null() {
            continue;
        }

        // Turn-id guard: skip only if an explicit expected turn_id was set and mismatches
        if let Some(expected) = expected_turn_id.as_deref() {
            let reported_turn_id = resp.get("turn_id").and_then(|v| v.as_str());
            if reported_turn_id != Some(expected) {
                continue;
            }
        }

        let status = resp
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("running");

        let result = resp
            .get("result")
            .or_else(|| resp.get("output"))
            .or_else(|| resp.get("final_result"))
            .cloned();
        let result_error = resp
            .get("result_error")
            .or_else(|| resp.get("error"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        match classify_terminal(status, result, result_error) {
            NodeOutcome::StillRunning => {
                if let Some(cp) = record.nodes.get_mut(&uid) {
                    cp.pending_at = Some(now);
                }
            }
            NodeOutcome::Done(res) => {
                // Persist the result blob
                state::put_node_result(&deps.iii, &record.run_id, &uid, &res).await?;
                // Update checkpoint
                if let Some(cp) = record.nodes.get_mut(&uid) {
                    cp.result_ref = Some(new_ref_id("node_result"));
                    cp.state = NodeState::Done;
                    cp.completed_at = Some(now); // Track completion time
                    let dur = cp
                        .pending_at
                        .map(|p| (now - p).max(0) as f64)
                        .unwrap_or(0.0);
                    crate::telemetry::record_node_terminal(true, dur);
                }
            }
            NodeOutcome::Failed(err) => {
                if let Some(cp) = record.nodes.get_mut(&uid) {
                    cp.result_error = Some(err);
                    cp.state = NodeState::Failed;
                    cp.completed_at = Some(now); // Track completion time (failure)
                    let dur = cp
                        .pending_at
                        .map(|p| (now - p).max(0) as f64)
                        .unwrap_or(0.0);
                    crate::telemetry::record_node_terminal(false, dur);
                }
            }
            NodeOutcome::Cancelled => {
                if let Some(cp) = record.nodes.get_mut(&uid) {
                    cp.state = NodeState::Cancelled;
                    cp.completed_at = Some(now); // Track completion time (cancellation)
                }
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{EngineRetrySpec, FunctionSpec, InputSpec, NodeDef, OutputRef, WorkflowDef};
    use serde_json::json;
    use std::collections::BTreeMap;

    fn retry_test_def(max_attempts: Option<u32>) -> WorkflowDef {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "step".to_string(),
            NodeDef {
                label: None,
                function: Some(FunctionSpec {
                    id: "worker::step".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: Some(EngineRetrySpec { max_attempts }),
                    runtime: None,
                }),
                agent: None,
                agent_options: None,
                child_workflow: None,
                reduce: None,
                reduce_body: None,
                if_spec: None,
                if_branch: None,
                input: InputSpec {
                    from: "run_input".into(),
                    template: None,
                    value: None,
                },
                depends_on: vec![],
                fanout: None,
                result: None,
                input_policy: None,
            },
        );

        WorkflowDef {
            version: 1,
            nodes,
            output: OutputRef {
                from: "node:step".to_string(),
            },
            default_functions: None,
            metadata: None,
        }
    }

    #[test]
    fn completed_without_error_is_done() {
        let outcome = classify_terminal("completed", Some(json!({"answer": 42})), None);
        assert_eq!(outcome, NodeOutcome::Done(json!({"answer": 42})));
    }

    #[test]
    fn completed_with_result_error_is_failed() {
        let outcome = classify_terminal(
            "completed",
            Some(json!({"answer": 42})),
            Some("schema validation failed".into()),
        );
        match outcome {
            NodeOutcome::Failed(msg) => assert_eq!(msg, "schema validation failed"),
            other => panic!("expected Failed, got {:?}", other),
        }
    }

    #[test]
    fn failed_and_cancelled_map_through() {
        // "failed" with an explicit error message
        let outcome_failed = classify_terminal("failed", None, Some("something broke".into()));
        match outcome_failed {
            NodeOutcome::Failed(msg) => assert_eq!(msg, "something broke"),
            other => panic!("expected Failed, got {:?}", other),
        }

        // "failed" with no error message falls back to "failed"
        let outcome_failed_default = classify_terminal("failed", None, None);
        match outcome_failed_default {
            NodeOutcome::Failed(msg) => assert_eq!(msg, "failed"),
            other => panic!("expected Failed(\"failed\"), got {:?}", other),
        }

        // "cancelled"
        let outcome_cancelled = classify_terminal("cancelled", None, None);
        assert_eq!(outcome_cancelled, NodeOutcome::Cancelled);
    }

    #[test]
    fn non_terminal_is_still_running() {
        for status in &["running", "awaiting_nodes", "queued", "unknown", ""] {
            let outcome = classify_terminal(status, None, None);
            assert_eq!(
                outcome,
                NodeOutcome::StillRunning,
                "expected StillRunning for status {:?}",
                status
            );
        }
    }

    #[test]
    fn oversized_result_helper_flags_only_over_cap() {
        assert!(oversized_result(&json!({"k": "v"})).is_none());
        let big = Value::String("x".repeat(MAX_RESULT_BYTES + 1));
        assert!(oversized_result(&big).is_some());
    }

    #[test]
    fn completed_oversized_result_is_failed_not_done() {
        // A completed node whose result blows past the cap fails instead of being
        // stored + fed downstream / loaded into memory every tick.
        let big = Value::String("x".repeat(MAX_RESULT_BYTES + 10));
        match classify_terminal("completed", Some(big), None) {
            NodeOutcome::Failed(msg) => assert!(
                msg.contains("exceeds the cap"),
                "message should name the cap, got: {msg}"
            ),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn completed_modest_result_unaffected_by_cap() {
        let outcome = classify_terminal("completed", Some(json!({"k": "v"})), None);
        assert_eq!(outcome, NodeOutcome::Done(json!({"k": "v"})));
    }

    #[test]
    fn function_failure_retries_while_budget_remains() {
        assert_eq!(
            function_failure_action(0, 3, "boom"),
            FunctionFailureAction::Retry { attempt: 1 }
        );
        assert_eq!(
            function_failure_action(2, 3, "boom"),
            FunctionFailureAction::Retry { attempt: 3 }
        );
    }

    #[test]
    fn function_failure_surfaces_retry_exhaustion() {
        assert_eq!(
            function_failure_action(0, 0, "boom"),
            FunctionFailureAction::Fail {
                result_error: "boom".into()
            }
        );
        assert_eq!(
            function_failure_action(3, 3, "boom"),
            FunctionFailureAction::Fail {
                result_error: "boom (retry budget exhausted after 3 retries)".into()
            }
        );
    }

    #[test]
    fn effective_max_retries_prefers_node_override() {
        let def = retry_test_def(Some(1));
        assert_eq!(effective_max_retries(&def, "step", 3), 1);
        assert_eq!(effective_max_retries(&def, "step#4", 3), 1);
    }

    #[test]
    fn effective_max_retries_falls_back_to_worker_default() {
        let def = retry_test_def(None);
        assert_eq!(effective_max_retries(&def, "step", 3), 3);
        assert_eq!(effective_max_retries(&def, "missing", 3), 3);
    }

    // -----------------------------------------------------------------------
    // Child-workflow reconcile helpers
    // -----------------------------------------------------------------------

    fn checkpoint(
        state: NodeState,
        session_id: Option<&str>,
        child_run_id: Option<&str>,
    ) -> NodeCheckpoint {
        NodeCheckpoint {
            state,
            session_id: session_id.map(str::to_string),
            turn_id: None,
            result_ref: None,
            result_error: None,
            child_run_id: child_run_id.map(str::to_string),
            pending_at: None,
            pending_timeout_ms: None,
            retries: 0,
            completed_at: None,
            worker_name: None,
        }
    }

    #[test]
    fn collect_running_function_node_uids_excludes_child_and_session_backed_nodes() {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "plain-fn".to_string(),
            checkpoint(NodeState::Running, None, None),
        );
        nodes.insert(
            "invoice".to_string(),
            checkpoint(NodeState::Running, None, Some("r_child_1")),
        );
        nodes.insert(
            "agent-step".to_string(),
            checkpoint(NodeState::Running, Some("wf_s1"), None),
        );
        nodes.insert(
            "done-fn".to_string(),
            checkpoint(NodeState::Done, None, None),
        );

        assert_eq!(
            collect_running_function_node_uids(&nodes),
            vec!["plain-fn".to_string()]
        );
    }

    #[test]
    fn collect_running_child_workflow_nodes_ignores_non_running_and_plain_nodes() {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "invoice".to_string(),
            checkpoint(NodeState::Running, None, Some("r_child_1")),
        );
        nodes.insert(
            "shipped".to_string(),
            checkpoint(NodeState::Done, None, Some("r_child_2")),
        );
        nodes.insert(
            "plain-fn".to_string(),
            checkpoint(NodeState::Running, None, None),
        );

        assert_eq!(
            collect_running_child_workflow_nodes(&nodes),
            vec![("invoice".to_string(), "r_child_1".to_string())]
        );
    }

    #[test]
    fn child_terminal_status_str_maps_terminal_statuses_only() {
        assert_eq!(
            child_terminal_status_str(RunStatus::Completed),
            Some("completed")
        );
        assert_eq!(child_terminal_status_str(RunStatus::Failed), Some("failed"));
        assert_eq!(
            child_terminal_status_str(RunStatus::Cancelled),
            Some("cancelled")
        );
        assert_eq!(child_terminal_status_str(RunStatus::Running), None);
        assert_eq!(child_terminal_status_str(RunStatus::AwaitingNodes), None);
    }

    #[test]
    fn child_workflow_messages_name_the_child_run_and_cause() {
        assert_eq!(
            child_workflow_failed_message("r_child_1", "boom"),
            "child workflow (run r_child_1) failed: boom"
        );
        assert_eq!(
            child_workflow_cancelled_message("r_child_1"),
            "child workflow (run r_child_1) cancelled"
        );
    }

    #[test]
    fn child_run_completed_status_maps_to_done_outcome_via_classify_terminal() {
        let status = child_terminal_status_str(RunStatus::Completed).expect("terminal");
        let outcome = classify_terminal(status, Some(json!({"ok": true})), None);
        assert_eq!(outcome, NodeOutcome::Done(json!({"ok": true})));
    }

    #[test]
    fn completed_child_without_result_fails_instead_of_forwarding_null() {
        let outcome = classify_child_terminal("r_child_missing", "completed", None, None);

        assert_eq!(
            outcome,
            NodeOutcome::Failed(
                "child workflow (run r_child_missing) completed without a stored result"
                    .to_string()
            )
        );
    }

    #[test]
    fn completed_child_with_stored_json_null_remains_done() {
        let outcome = classify_child_terminal("r_child_null", "completed", Some(json!(null)), None);

        assert_eq!(outcome, NodeOutcome::Done(json!(null)));
    }

    #[test]
    fn child_run_failed_status_carries_child_result_error_into_outcome() {
        let status = child_terminal_status_str(RunStatus::Failed).expect("terminal");
        let outcome = classify_terminal(status, None, Some("upstream boom".to_string()));
        match outcome {
            NodeOutcome::Failed(err) => assert_eq!(
                child_workflow_failed_message("r_child_9", &err),
                "child workflow (run r_child_9) failed: upstream boom"
            ),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn child_run_cancelled_status_maps_to_cancelled_outcome() {
        let status = child_terminal_status_str(RunStatus::Cancelled).expect("terminal");
        assert_eq!(
            classify_terminal(status, None, None),
            NodeOutcome::Cancelled
        );
    }
}
