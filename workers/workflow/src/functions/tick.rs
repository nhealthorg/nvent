use std::collections::BTreeMap;

use serde_json::{json, Value};
use iii_sdk::TriggerAction;

use crate::{
    dag,
    error::WorkflowError,
    ids, state,
    types::{
        FunctionSpec, InputFrom, NodeCheckpoint, NodeDef, NodeState, QueueReceiptRecord, RunStatus, WorkflowDef,
        WorkflowRunRecord,
    },
};

use super::Deps;

// ---------------------------------------------------------------------------
// TickDecision
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum TickDecision {
    Finalize(RunStatus),
    Fire(Vec<String>),
    Park,
}

// ---------------------------------------------------------------------------
// decide (pure)
// ---------------------------------------------------------------------------

pub fn decide(def: &WorkflowDef, record: &WorkflowRunRecord) -> TickDecision {
    // Abort flag always wins.
    if record.abort {
        return TickDecision::Finalize(RunStatus::Cancelled);
    }

    // Check quiescence for terminal states.
    let q = dag::quiescence(def, record);
    if q == RunStatus::Completed || q == RunStatus::Failed {
        return TickDecision::Finalize(q);
    }

    // If there are nodes ready to fire, Fire them; otherwise Park.
    let ready = dag::ready_frontier(def, record);
    if ready.is_empty() {
        TickDecision::Park
    } else {
        TickDecision::Fire(ready)
    }
}

fn dispatch_queue_for(function: &FunctionSpec) -> String {
    function
        .queue
        .as_deref()
        .filter(|q| !q.trim().is_empty())
        .unwrap_or("default")
        .to_string()
}

// ---------------------------------------------------------------------------
// fire_node
// ---------------------------------------------------------------------------

fn resolve_node_input(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    run_input: &Value,
    node_uid: &str,
    base_id: &str,
    node: &NodeDef,
    results: &BTreeMap<String, Value>,
) -> Value {
    if node_uid.contains('#') {
        // Per-item binding: parse the index i after '#'
        let idx_str = node_uid.split('#').nth(1).unwrap_or("0");
        let i: usize = idx_str.parse().unwrap_or(0);

        if node.input.from.is_literal("fanout_item") {
            return record
                .fanout_src
                .get(base_id)
                .and_then(|items| items.get(i))
                .cloned()
                .unwrap_or(Value::Null);
        }

        // Loop/fanout chaining: for fanout child node `curr#i` reading from
        // `node:dep` where `dep` is also a fanout, feed the matched dep item
        // `dep#i` instead of the whole dep array.
        let maybe_item_from_dep = match &node.input.from {
            InputFrom::One(src) if src.starts_with("node:") && node.fanout.is_some() => {
                let dep = src.strip_prefix("node:").unwrap_or(src.as_str());
                let dep_is_fanout = def
                    .nodes
                    .get(dep)
                    .and_then(|n| n.fanout.as_ref())
                    .is_some();

                if dep_is_fanout {
                    let dep_uid = format!("{}#{}", dep, i);
                    results.get(dep_uid.as_str()).cloned()
                } else {
                    None
                }
            }
            _ => None,
        };

        return maybe_item_from_dep.unwrap_or_else(|| dag::gather_input(def, record, run_input, base_id, results));
    }

    dag::gather_input(def, record, run_input, base_id, results)
}

fn effective_pending_timeout_ms(
    prior_timeout: Option<u64>,
    function_timeout_ms: Option<u64>,
    dispatch_timeout_ms: u64,
) -> Option<u64> {
    prior_timeout
        .or(function_timeout_ms)
        .or(Some(dispatch_timeout_ms))
}

pub(crate) async fn fire_node(
    deps: &Deps,
    record: &mut WorkflowRunRecord,
    def: &WorkflowDef,
    node_uid: &str,
    results: &BTreeMap<String, Value>,
) -> Result<(), WorkflowError> {
        let run_input = state::get_run_input(&deps.iii, &record.run_id)
            .await?
            .ok_or_else(|| WorkflowError::State(format!("run input missing for {}", record.run_id)))?;

    // Abort guard: covers both the tick Fire branch and the sweep refire path.
    // `decide` already returns Finalize(Cancelled) first when abort=true (so the
    // Fire branch in tick::handle is never reached for an aborting run), but the
    // sweep refire path calls fire_node directly without going through decide —
    // a node timing out on an already-aborting run would otherwise be re-fired.
    // One guard here covers both call sites.
    if record.abort {
        return Ok(());
    }

    let base_id = node_uid.split('#').next().unwrap();
    let node = def
        .nodes
        .get(base_id)
        .ok_or_else(|| WorkflowError::State(format!("node '{}' not in def", base_id)))?;

    // Read attempt and prior_timeout BEFORE the input-resolution borrows.
    let attempt = record.nodes.get(node_uid).map(|c| c.retries).unwrap_or(0);
    let prior_timeout = record
        .nodes
        .get(node_uid)
        .and_then(|c| c.pending_timeout_ms);

    // Resolve the input value. Read everything from `node`/`record` into owned values
    // BEFORE the .await so we don't hold a borrow across the await point.
    let input_val = resolve_node_input(def, record, &run_input, node_uid, base_id, node, results);

    let dispatch_timeout_ms = deps.cfg().await.dispatch_timeout_ms;

    // Fire the function asynchronously via queue (non-blocking)
    let function = &node.function;
    let node_pending_timeout_ms = effective_pending_timeout_ms(
        prior_timeout,
        function.timeout_ms,
        dispatch_timeout_ms,
    );
    let max_retries = node
        .function
        .engine_retry
        .as_ref()
        .and_then(|r| r.max_attempts)
        .unwrap_or(deps.cfg().await.max_node_retries);

    // Discovery check: if the function is not in the registry, fail immediately
    // instead of enqueuing into a black hole.
    if !crate::discovery::is_function_available(&deps.discovery, &function.id).await {
        if attempt >= max_retries {
            tracing::error!(
                run_id = %record.run_id,
                node_uid = %node_uid,
                function_id = %function.id,
                retries = attempt,
                max_retries,
                "node fire failed: function missing after discovery retries"
            );

            record.nodes.insert(
                node_uid.to_string(),
                NodeCheckpoint {
                    state: NodeState::Failed,
                    session_id: None,
                    turn_id: None,
                    result_ref: None,
                    result_error: Some(format!("Function not found after retries: {}", function.id)),
                    pending_at: Some(deps.now_ms()),
                    pending_timeout_ms: None,
                    retries: attempt,
                    completed_at: Some(deps.now_ms()),
                    worker_name: None,
                },
            );
        } else {
            // Discovery is eventually consistent across worker reconnects.
            // Treat early misses as transient and re-drive via sweep timeout.
            tracing::warn!(
                run_id = %record.run_id,
                node_uid = %node_uid,
                function_id = %function.id,
                retries = attempt,
                max_retries,
                "function missing in discovery snapshot; will retry"
            );

            record.nodes.insert(
                node_uid.to_string(),
                NodeCheckpoint {
                    state: NodeState::Running,
                    session_id: None,
                    turn_id: None,
                    result_ref: None,
                    result_error: Some("function_missing_discovery_snapshot".to_string()),
                    pending_at: Some(deps.now_ms()),
                    pending_timeout_ms: Some(10_000),
                    retries: attempt,
                    completed_at: None,
                    worker_name: None,
                },
            );
        }

        record.updated_at = deps.now_ms();
        state::put_run(&deps.iii, record).await?;
        return Ok(());
    }

    let queue = dispatch_queue_for(function);

    // Wrap input with workflow metadata so functions can emit completion events
    let wrapped_input = json!({
        "_workflow": {
            "run_id": record.run_id,
            "node_uid": node_uid,
            "trace_id": record.workflow_trace_id
        },
        "input": input_val
    });

    tracing::info!(
        run_id = %record.run_id,
        node_uid = %node_uid,
        function_id = %function.id,
        "firing node via queue enqueue"
    );

    let trigger_res = deps
        .iii
        .trigger(iii_sdk::protocol::TriggerRequest {
            function_id: function.id.clone(),
            payload: wrapped_input,
            action: Some(TriggerAction::Enqueue { queue: queue.clone() }),
            timeout_ms: function.timeout_ms.or(Some(dispatch_timeout_ms)),
        })
        .await;

    match trigger_res {
        Ok(v) => {
            // Check if the engine returned a logic error (e.g. function not found)
            // even though the RPC request itself was technically successful (Ok).
            let logic_error = v.get("error").or_else(|| v.get("result_error"));

            if let Some(err_val) = logic_error {
                let err_msg = err_val.as_str().unwrap_or("Unknown trigger error").to_string();
                tracing::warn!(
                    run_id = %record.run_id,
                    node_uid = %node_uid,
                    error = %err_msg,
                    response = ?v,
                    "node fire returned logic error, marking as Failed"
                );

                record.nodes.insert(
                    node_uid.to_string(),
                    NodeCheckpoint {
                        state: NodeState::Failed,
                        session_id: None,
                        turn_id: None,
                        result_ref: None,
                        result_error: Some(format!("Trigger logic error: {}", err_msg)),
                        pending_at: Some(deps.now_ms()),
                        pending_timeout_ms: None,
                        retries: attempt,
                        completed_at: Some(deps.now_ms()),
                        worker_name: None,
                    },
                );
            } else {
                let maybe_session_id = v
                    .get("session_id")
                    .or_else(|| v.get("sessionId"))
                    .and_then(|x| x.as_str())
                    .map(str::to_string);

                if let Some(session_id) = maybe_session_id.as_deref() {
                    if let Err(e) = deps
                        .internal_state
                        .put_session_index(session_id, &record.run_id)
                        .await
                    {
                        tracing::warn!(
                            run_id = %record.run_id,
                            node_uid = %node_uid,
                            session_id = %session_id,
                            error = %e,
                            "failed to persist session index"
                        );
                    }
                }

                if let Some(receipt_id) = v.get("messageReceiptId").and_then(|x| x.as_str()) {
                    let receipt = QueueReceiptRecord {
                        id: format!("{}:{}:{}", &record.run_id, node_uid, receipt_id),
                        run_id: record.run_id.clone(),
                        node_uid: node_uid.to_string(),
                        function_id: function.id.clone(),
                        queue: queue.clone(),
                        receipt_id: receipt_id.to_string(),
                        attempt,
                        ts_unix_ms: deps.now_ms(),
                    };
                    if let Err(e) = deps.internal_state.put_queue_receipt(&receipt).await {
                        tracing::warn!(
                            run_id = %record.run_id,
                            node_uid = %node_uid,
                            error = %e,
                            "failed to persist queue receipt"
                        );
                    }
                }

                tracing::info!(
                    run_id = %record.run_id,
                    node_uid = %node_uid,
                    response = ?v,
                    "node enqueued successfully, marking as Running"
                );

                record.nodes.insert(
                    node_uid.to_string(),
                    NodeCheckpoint {
                        state: NodeState::Running,
                        session_id: maybe_session_id,
                        turn_id: None,
                        result_ref: None, // Result written by function when complete
                        result_error: None,
                        pending_at: Some(deps.now_ms()),
                        pending_timeout_ms: node_pending_timeout_ms,
                        retries: attempt,
                        completed_at: None,
                        worker_name: None,
                    },
                );
            }
        }
        Err(e) => {
            tracing::warn!(
                run_id = %record.run_id,
                node_uid = %node_uid,
                error = %e,
                "node fire failed (trigger error), marking as Failed"
            );

            record.nodes.insert(
                node_uid.to_string(),
                NodeCheckpoint {
                    state: NodeState::Failed,
                    session_id: None,
                    turn_id: None,
                    result_ref: None,
                    result_error: Some(format!("Trigger failed: {}", e)),
                    pending_at: Some(deps.now_ms()),
                    pending_timeout_ms: None,
                    retries: attempt,
                    completed_at: Some(deps.now_ms()),
                    worker_name: None,
                },
            );
        }
    }

    // Persist immediately to avoid race condition: if the function executes
    // synchronously (fast handler), it might emit node-completed before the
    // calling tick's state::put_run is reached. Persisting here ensures
    // node_completed::handle and reconcile_function_nodes see the Running state.
    record.updated_at = deps.now_ms();
    state::put_run(&deps.iii, record).await?;

    tracing::info!(
        run_id = %record.run_id,
        node_uid = %node_uid,
        "node state persisted"
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

/// Flip every still-`Running` checkpoint to `Cancelled`. Called by `finalize`
/// after the stop cascade: the cascade stops the live sessions, this records it in
/// the run so a terminal run doesn't report siblings as "running" in
/// workflow::status forever. Pure (no I/O), so it's unit-testable.
fn cancel_running_checkpoints(nodes: &mut BTreeMap<String, NodeCheckpoint>) {
    for cp in nodes.values_mut() {
        if matches!(cp.state, NodeState::Running) {
            cp.state = NodeState::Cancelled;
        }
    }
}

async fn finalize(
    deps: &Deps,
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
    status: RunStatus,
    results: &BTreeMap<String, Value>,
) -> Result<(), WorkflowError> {
    record.status = status;
    record.updated_at = deps.now_ms();

    let duration_ms = (record.updated_at - record.created_at).max(0) as f64;
    crate::telemetry::record_run_terminal(status, duration_ms);

    // Output node id (strip "node:") for result extraction.
    let out_node = def
        .output
        .from
        .strip_prefix("node:")
        .unwrap_or(&def.output.from);

    if status == RunStatus::Completed {
        // Check if the output node is a fanout group.
        let out_val = if def
            .nodes
            .get(out_node)
            .and_then(|n| n.fanout.as_ref())
            .is_some()
        {
            // Fanout group: collect results as an array in numeric order.
            let n = dag::fanned_uids(record, out_node).len();
            let arr: Vec<Value> = (0..n)
                .map(|i| {
                    let uid = ids::node_uid(out_node, Some(i as u32));
                    results.get(&uid).cloned().unwrap_or(Value::Null)
                })
                .collect();
            Value::Array(arr)
        } else {
            // Normal single-result node.
            results.get(out_node).cloned().unwrap_or(Value::Null)
        };

        state::put_run_result(&deps.iii, &record.run_id, &out_val).await?;
        record.result_ref = Some(crate::ids::run_result_key(&record.run_id));
    } else if status == RunStatus::Failed {
        // Surface WHY the run failed. Without this, `notify` delivers
        // result_error: null and workflow::status shows a bare "failed" — the
        // caller can't tell a bad model id from a crashed node and gives up.
        record.result_error = summarize_failure(&record.nodes);
    }

    // Mark any sibling nodes still Running as Cancelled in the run record.
    // A fast-fail (or a Completed run with branches that don't feed the output node)
    // can finalize while siblings are mid-turn.
    cancel_running_checkpoints(&mut record.nodes);

    // Emit terminal callbacks BEFORE `put_run` persists the terminal status (in
    // tick::handle): emit-first is at-least-once — a crash before persist re-ticks
    // and re-fires, and consumers dedup on run_id.
    // Persisting first would instead risk a LOST delivery on a crash mid-emit, which
    // is strictly worse for a delivery guarantee.
    let rec: &WorkflowRunRecord = record;
    crate::events::emit_notify(deps, rec).await;

    Ok(())
}

/// Summarize the failed nodes' errors into one run-level message, so
/// the run's `notify` callback (result_error) and `workflow::status` can report
/// WHY a run failed instead of a bare "failed". Returns None when nothing failed.
pub(crate) fn summarize_failure(nodes: &BTreeMap<String, NodeCheckpoint>) -> Option<String> {
    let mut errs: Vec<String> = nodes
        .iter()
        .filter(|(_, cp)| cp.state == NodeState::Failed)
        .map(|(uid, cp)| match &cp.result_error {
            Some(e) => format!("node '{uid}': {e}"),
            None => format!("node '{uid}' failed"),
        })
        .collect();
    errs.sort();
    if errs.is_empty() {
        None
    } else {
        Some(errs.join("; "))
    }
}

// ---------------------------------------------------------------------------
// handle
// ---------------------------------------------------------------------------

/// A tick should be skipped if its step is below the run's monotonic dequeue
/// floor (a re-delivered / duplicate tick — producers always enqueue
/// `record.step + 1`) or the run is already terminal. This IS the crash-resume /
/// at-least-once redelivery guard, pulled out as a pure fn so it's unit-testable
/// without a live engine. Note the comparison is strict `<`: a duplicate tick at
/// the SAME step (e.g. two fast-wakes firing `step+1` before either persists)
/// is NOT stale and runs a redundant-but-idempotent reconcile pass.
fn tick_is_stale(req_step: u64, record_step: u64, run_is_terminal: bool) -> bool {
    req_step < record_step || run_is_terminal
}

pub async fn handle(
    deps: &Deps,
    req: super::TickRequest,
) -> Result<super::TickResponse, WorkflowError> {
    // 1. Acquire per-run lock.
    let _g = deps.locks.guard(&req.run_id).await;

    // 2. Load the run record (None → skipped).
    let Some(mut record) = state::get_run(&deps.iii, &req.run_id).await? else {
        return Ok(super::TickResponse { skipped: true });
    };

    // 3. Stale guard.
    if tick_is_stale(req.step, record.step, record.status.is_terminal()) {
        return Ok(super::TickResponse { skipped: true });
    }

    // Advance the monotonic dequeue floor: a re-delivered tick at this step is now
    // rejected by the guard above. Producers (start/sweep/stop/resume) enqueue
    // `record.step + 1`, so a legitimate tick is never below this floor.
    record.step = req.step + 1;

    // 4. Load the workflow definition.
    let def = state::get_def(&deps.iii, &req.run_id)
        .await?
        .map(|d| super::start::prepare_definition_for_execution(&d))
        .ok_or_else(|| WorkflowError::State("def missing".into()))?;

    // 5. Reconcile running nodes.
    crate::reconcile::reconcile_run(deps, &mut record).await?;
    crate::reconcile::reconcile_function_nodes(deps, &def, &mut record).await?;

    // 6. Load done results.
    let results = state::load_done_results(&deps.iii, &mut record).await?;

    // 7. Expand any ready fanouts.
    dag::expand_ready_fanouts(&def, &mut record, &results);

    // 8. Decide and act.
    let decision = decide(&def, &record);
    tracing::info!(
        run_id = %req.run_id,
        decision = ?decision,
        "tick decision made"
    );
    
    match decision {
        TickDecision::Finalize(status) => {
            tracing::info!(
                run_id = %req.run_id,
                status = ?status,
                "finalizing workflow run"
            );
            finalize(deps, &def, &mut record, status, &results).await?;
            state::put_run(&deps.iii, &record).await?;
            Ok(super::TickResponse { skipped: false })
        }
        TickDecision::Fire(uids) => {
            tracing::info!(
                run_id = %req.run_id,
                nodes = ?uids,
                "firing ready nodes"
            );
            for uid in &uids {
                fire_node(deps, &mut record, &def, uid, &results).await?;
            }
            record.status = RunStatus::AwaitingNodes;
            record.updated_at = deps.now_ms();
            state::put_run(&deps.iii, &record).await?;
            Ok(super::TickResponse { skipped: false })
        }
        TickDecision::Park => {
            tracing::debug!(
                run_id = %req.run_id,
                "parking - no ready nodes"
            );
            record.status = RunStatus::AwaitingNodes;
            record.updated_at = deps.now_ms();
            state::put_run(&deps.iii, &record).await?;
            Ok(super::TickResponse { skipped: false })
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        FanoutSpec, FunctionSpec, InputSpec, NodeCheckpoint, NodeDef, NodeState, OutputRef,
        WorkflowDef, WorkflowRunRecord,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    // -----------------------------------------------------------------------
    // Test helpers
    // -----------------------------------------------------------------------

    fn three_node_def() -> WorkflowDef {
        let mut nodes = BTreeMap::new();

        nodes.insert(
            "plan".to_string(),
            NodeDef {
                function: FunctionSpec {
                    id: "plan_function".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                },
                input: InputSpec {
                    from: "run_input".into(),
                    template: None,
                },
                depends_on: vec![],
                fanout: None,
            },
        );

        nodes.insert(
            "read".to_string(),
            NodeDef {
                function: FunctionSpec {
                    id: "read_function".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                },
                input: InputSpec {
                    from: "fanout_item".into(),
                    template: None,
                },
                depends_on: vec!["plan".to_string()],
                fanout: Some(FanoutSpec {
                    over: "node:plan.result.docs".to_string(),
                    mode: None,
                }),
            },
        );

        nodes.insert(
            "synthesize".to_string(),
            NodeDef {
                function: FunctionSpec {
                    id: "synthesize_function".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                },
                input: InputSpec {
                    from: "node:read".into(),
                    template: None,
                },
                depends_on: vec!["read".to_string()],
                fanout: None,
            },
        );

        WorkflowDef {
            version: 1,
            nodes,
            output: OutputRef {
                from: "node:synthesize".into(),
            },
            default_functions: None,
            metadata: None,
        }
    }

    fn fresh_record() -> WorkflowRunRecord {
        WorkflowRunRecord {
            run_id: "run_test".to_string(),
            workflow_name: None,
            workflow_trace_id: Some("trace_test".to_string()),
            state_scope_id: Some("run_test".to_string()),
            stream_scope_id: Some("run_test".to_string()),
            step: 0,
            status: RunStatus::Running,
            abort: false,
            def_ref: "run_test".to_string(),
            input_ref: "run_test".to_string(),
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
        }
    }

    fn done_cp() -> NodeCheckpoint {
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
        }
    }

    // -----------------------------------------------------------------------
    // RED → GREEN tests for `decide`
    // -----------------------------------------------------------------------

    /// abort=true + ready frontier present → Finalize(Cancelled). Abort wins.
    #[test]
    fn decide_abort_finalizes_cancelled() {
        let def = three_node_def();
        let mut record = fresh_record();
        // Mark abort AND leave plan in the ready frontier.
        record.abort = true;

        // Sanity: ready_frontier returns ["plan"] without abort.
        let frontier = dag::ready_frontier(&def, &record);
        assert_eq!(frontier, vec!["plan".to_string()], "plan should be ready");

        match decide(&def, &record) {
            TickDecision::Finalize(RunStatus::Cancelled) => {}
            other => panic!("expected Finalize(Cancelled), got {:?}", other),
        }
    }

    /// Fresh 3-node record → Fire(["plan"]).
    #[test]
    fn decide_fires_root_then_parks() {
        let def = three_node_def();
        let record = fresh_record();

        match decide(&def, &record) {
            TickDecision::Fire(uids) => {
                assert_eq!(uids, vec!["plan".to_string()], "should fire plan first");
            }
            other => panic!("expected Fire([\"plan\"]), got {:?}", other),
        }
    }

    /// All nodes done → Finalize(Completed).
    #[test]
    fn decide_finalizes_when_completed() {
        let def = three_node_def();
        let mut record = fresh_record();
        record.nodes.insert("plan".into(), done_cp());
        // Expand read fanout with 1 item.
        record.fanout_src.insert("read".into(), vec![json!("doc1")]);
        record.nodes.insert("read#0".into(), done_cp());
        record.nodes.insert("synthesize".into(), done_cp());

        match decide(&def, &record) {
            TickDecision::Finalize(RunStatus::Completed) => {}
            other => panic!("expected Finalize(Completed), got {:?}", other),
        }
    }

    /// No ready nodes (plan is Running) → Park.
    #[test]
    fn decide_parks_when_nothing_ready() {
        let def = three_node_def();
        let mut record = fresh_record();
        record.nodes.insert(
            "plan".into(),
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

        match decide(&def, &record) {
            TickDecision::Park => {}
            other => panic!("expected Park, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // tick_is_stale — the crash-resume / at-least-once redelivery guard.
    // -----------------------------------------------------------------------

    #[test]
    fn tick_is_stale_below_floor_not_at_or_above() {
        // A re-delivered tick below the monotonic dequeue floor is skipped.
        assert!(tick_is_stale(0, 1, false));
        assert!(tick_is_stale(4, 5, false));
        // Strict `<`: a duplicate tick AT the floor still runs (idempotent re-pass),
        // and a fresh tick above the floor runs.
        assert!(!tick_is_stale(5, 5, false));
        assert!(!tick_is_stale(6, 5, false));
    }

    #[test]
    fn tick_is_stale_when_terminal_regardless_of_step() {
        // Once the run is terminal, NO tick re-runs finalize — this is what stops a
        // re-delivered tick from re-emitting notify + double telemetry.
        assert!(tick_is_stale(99, 0, true));
        assert!(tick_is_stale(0, 0, true));
    }

    // -----------------------------------------------------------------------
    // cancel_running_checkpoints — terminal run reflects the stop cascade.
    // -----------------------------------------------------------------------

    #[test]
    fn cancel_running_checkpoints_flips_only_running() {
        let mut nodes: BTreeMap<String, NodeCheckpoint> = BTreeMap::new();
        let mut running = done_cp();
        running.state = NodeState::Running;
        nodes.insert("live".into(), running);
        nodes.insert("done".into(), done_cp());
        nodes.insert("failed".into(), failed_cp(Some("boom")));

        cancel_running_checkpoints(&mut nodes);

        assert_eq!(nodes["live"].state, NodeState::Cancelled);
        assert_eq!(nodes["done"].state, NodeState::Done); // untouched
        assert_eq!(nodes["failed"].state, NodeState::Failed); // untouched
    }

    // -----------------------------------------------------------------------
    // summarize_failure — the "failed to run" diagnosability gap: a node failed
    // with "no provider registered for model claude-sonnet-4-5" but `notify` /
    // workflow::status returned result_error: null and showed a bare "failed".
    // -----------------------------------------------------------------------

    fn failed_cp(err: Option<&str>) -> NodeCheckpoint {
        NodeCheckpoint {
            state: NodeState::Failed,
            session_id: None,
            turn_id: None,
            result_ref: None,
            result_error: err.map(|s| s.to_string()),
            pending_at: None,
            pending_timeout_ms: None,
            retries: 0,
            completed_at: None,
            worker_name: None,
        }
    }

    #[test]
    fn summarize_failure_reports_node_error() {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "researcher".to_string(),
            failed_cp(Some("no provider registered for model claude-sonnet-4-5")),
        );
        nodes.insert("writer".to_string(), done_cp()); // Done nodes are ignored
        let got = summarize_failure(&nodes).expect("a failure summary");
        assert_eq!(
            got,
            "node 'researcher': no provider registered for model claude-sonnet-4-5"
        );
    }

    #[test]
    fn summarize_failure_joins_multiple_and_handles_missing_detail() {
        let mut nodes = BTreeMap::new();
        nodes.insert("a".to_string(), failed_cp(Some("boom")));
        nodes.insert("b".to_string(), failed_cp(None));
        assert_eq!(
            summarize_failure(&nodes),
            Some("node 'a': boom; node 'b' failed".to_string())
        );
    }

    #[test]
    fn summarize_failure_none_when_nothing_failed() {
        let mut nodes = BTreeMap::new();
        nodes.insert("a".to_string(), done_cp());
        assert_eq!(summarize_failure(&nodes), None);
    }

    #[test]
    fn dispatch_queue_for_uses_configured_queue() {
        let function = FunctionSpec {
            id: "fn::critical".to_string(),
            timeout_ms: None,
            queue: Some("critical".to_string()),
            engine_retry: None,
            runtime: None,
        };

        assert_eq!(dispatch_queue_for(&function), "critical");
    }

    #[test]
    fn dispatch_queue_for_falls_back_to_default() {
        let none = FunctionSpec {
            id: "fn::none".to_string(),
            timeout_ms: None,
            queue: None,
            engine_retry: None,
            runtime: None,
        };
        let empty = FunctionSpec {
            id: "fn::empty".to_string(),
            timeout_ms: None,
            queue: Some("   ".to_string()),
            engine_retry: None,
            runtime: None,
        };

        assert_eq!(dispatch_queue_for(&none), "default");
        assert_eq!(dispatch_queue_for(&empty), "default");
    }

    #[test]
    fn effective_pending_timeout_prefers_prior_then_function_then_dispatch() {
        assert_eq!(
            effective_pending_timeout_ms(Some(5_000), Some(10_000), 30_000),
            Some(5_000)
        );
        assert_eq!(
            effective_pending_timeout_ms(None, Some(10_000), 30_000),
            Some(10_000)
        );
        assert_eq!(
            effective_pending_timeout_ms(None, None, 30_000),
            Some(30_000)
        );
    }

    #[test]
    fn resolve_node_input_fanout_chain_uses_matching_dep_item() {
        let mut def = three_node_def();

        // Override read as fanout over plan docs and synthesize as fanout over same docs,
        // reading each matching read#i item via input.from = node:read.
        if let Some(read) = def.nodes.get_mut("read") {
            read.fanout = Some(FanoutSpec {
                over: "node:plan.result.docs".to_string(),
                mode: None,
            });
            read.input = InputSpec {
                from: "fanout_item".into(),
                template: None,
            };
        }
        if let Some(synth) = def.nodes.get_mut("synthesize") {
            synth.fanout = Some(FanoutSpec {
                over: "node:plan.result.docs".to_string(),
                mode: None,
            });
            synth.input = InputSpec {
                from: "node:read".into(),
                template: None,
            };
        }

        let mut record = fresh_record();
        record
            .fanout_src
            .insert("synthesize".to_string(), vec![json!("a"), json!("b")]);

        let mut results: BTreeMap<String, Value> = BTreeMap::new();
        results.insert("read#0".to_string(), json!({ "summary": "A" }));
        results.insert("read#1".to_string(), json!({ "summary": "B" }));

        let node = def.nodes.get("synthesize").expect("synthesize node present");
        let val = resolve_node_input(
            &def,
            &record,
            &json!({"topic": "rust"}),
            "synthesize#1",
            "synthesize",
            node,
            &results,
        );

        assert_eq!(val, json!({ "summary": "B" }));
    }

    #[test]
    fn resolve_node_input_falls_back_when_dep_is_not_fanout() {
        let def = three_node_def();
        let mut record = fresh_record();
        record.fanout_src.insert("read".to_string(), vec![json!("x")]);

        let mut results: BTreeMap<String, Value> = BTreeMap::new();
        results.insert("plan".to_string(), json!({ "docs": ["x"] }));
        results.insert("read#0".to_string(), json!({ "summary": "X" }));

        // synthesize#0 reads node:read, but dep fanout behavior for this non-fanout node
        // should fall back to gather_input and return array of read child results.
        let node = def.nodes.get("synthesize").expect("synthesize node present");
        let val = resolve_node_input(
            &def,
            &record,
            &json!({"topic": "rust"}),
            "synthesize#0",
            "synthesize",
            node,
            &results,
        );

        assert_eq!(val, json!([{ "summary": "X" }]));
    }
}
