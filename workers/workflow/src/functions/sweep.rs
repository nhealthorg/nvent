//! `workflow::sweep` — cron-bound node-timeout sweep.
//!
//! Scans all `AwaitingNodes` runs. For each, re-runs reconciliation (to pick up
//! any newly-completed nodes) and times out any `Running` checkpoint past its
//! `pending_at + pending_timeout_ms` deadline. Then re-enqueues a tick so the
//! run can advance.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{error::WorkflowError, functions::Deps, reconcile, state, types::NodeState};
use crate::{observability, observability::ObservabilityAdapter};

use super::{run_delete, start};

fn effective_max_retries(def: &crate::types::WorkflowDef, node_uid: &str, fallback: u32) -> u32 {
    let base_id = node_uid.split('#').next().unwrap_or(node_uid);
    def.nodes
        .get(base_id)
        .and_then(|n| n.function.engine_retry.as_ref())
        .and_then(|r| r.max_attempts)
        .unwrap_or(fallback)
}

pub const SWEEP_ID: &str = "workflow::sweep";
pub const SWEEP_DESC: &str =
    "Internal cron sweep: reconcile AwaitingNodes runs and time out nodes past their deadline. \
     Not called directly.";

/// Cron event payload (schedule info ignored — the sweep scans all run records).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct SweepEvent {
    #[serde(default)]
    pub scheduled_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SweepResponse {
    pub ok: bool,
    /// Number of runs touched (reconciled and/or timed out) this sweep.
    pub swept: u64,
}

pub async fn handle(deps: &Deps, _event: SweepEvent) -> Result<SweepResponse, WorkflowError> {
    let runs = state::list_runs(&deps.iii).await?;
    let active = runs.iter().filter(|r| !r.status.is_terminal()).count() as u64;
    crate::telemetry::set_active_runs(active);
    let mut swept = 0u64;

    let cfg = deps.cfg().await;
    let now = deps.now_ms();
    let obs_cutoff = now - cfg.observability_retention_ms.min(i64::MAX as u64) as i64;
    let run_cutoff = now - cfg.run_retention_ms.min(i64::MAX as u64) as i64;
    let obs_adapter = observability::adapter();

    for run in &runs {
        match obs_adapter
            .prune_logs_before(&deps.iii, &run.run_id, obs_cutoff)
            .await
        {
            Ok(removed) if removed > 0 => {
                tracing::debug!(run_id = %run.run_id, removed, "sweep: pruned workflow logs");
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(run_id = %run.run_id, error = %e, "sweep: log retention prune failed")
            }
        }

        match obs_adapter
            .prune_traces_before(&deps.iii, &run.run_id, obs_cutoff)
            .await
        {
            Ok(removed) if removed > 0 => {
                tracing::debug!(run_id = %run.run_id, removed, "sweep: pruned workflow traces");
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(run_id = %run.run_id, error = %e, "sweep: trace retention prune failed")
            }
        }
    }

    for run in runs.iter().filter(|r| !r.status.is_terminal()) {
        // Isolate each run: one failing run must not starve the rest of the
        // cycle of timeout handling. Log and continue on error.
        match sweep_one_run(deps, &run.run_id, &cfg, now).await {
            Ok(true) => swept += 1,
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(run_id = %run.run_id, error = %e, "sweep: run failed; skipping")
            }
        }
    }

    // GC terminal runs past the retention window so `list_runs` doesn't deserialize
    // unbounded history every cycle (terminal runs are otherwise never deleted). Uses
    // the snapshot taken above, so a run that finalized THIS cycle (updated_at ~= now)
    // is never reaped here. Best-effort; a failed delete is retried next sweep.
    let cutoff = run_cutoff;
    for run in runs
        .iter()
        .filter(|r| r.status.is_terminal() && r.updated_at < cutoff)
    {
        match run_delete::delete_run_by_id(deps, &run.run_id).await {
            Ok(res) if res.deleted => swept += 1,
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(run_id = %run.run_id, error = %e, "sweep: GC delete failed")
            }
        }
    }

    Ok(SweepResponse { ok: true, swept })
}

/// Reconcile + timeout-sweep a single run. Returns `Ok(true)` if the run was
/// touched (reconciled and/or timed out), `Ok(false)` if it was skipped
/// (vanished / orphaned / already terminal under the lock).
async fn sweep_one_run(
    deps: &Deps,
    run_id: &str,
    cfg: &crate::config::WorkerConfig,
    now: i64,
) -> Result<bool, WorkflowError> {
    // Acquire per-run lock to serialize against concurrent tick deliveries.
    let _g = deps.locks.guard(run_id).await;

    // Re-read after acquiring the lock — state may have changed.
    let Some(mut record) = state::get_run(&deps.iii, run_id).await? else {
        return Ok(false);
    };
    if record.status.is_terminal() {
        return Ok(false);
    }

    // Fetch the workflow definition.
    // If missing, fail the run so it becomes terminal and is eligible for retention GC.
    let def = match state::get_def(&deps.iii, &record.def_ref).await? {
        Some(d) => crate::functions::start::prepare_definition_for_execution(&d),
        None => {
            record.status = crate::types::RunStatus::Failed;
            record.result_error = Some(
                "workflow definition missing: run cannot continue; marked failed by sweep"
                    .to_string(),
            );
            record.updated_at = now;
            state::put_run(&deps.iii, &record).await?;
            return Ok(true);
        }
    };

    // Poll running nodes for completion.
    reconcile::reconcile_run(deps, &mut record).await?;
    reconcile::reconcile_function_nodes(deps, &def, &mut record).await?;

    // Timeout sweep: apply timeout_action to each Running checkpoint.
    let results = state::load_done_results(&deps.iii, &mut record).await?;
    let default_timeout_ms = cfg.default_pending_timeout_ms;
    let default_max_retries = cfg.max_node_retries;
    let mut timed_out_any = false;
    let node_uids: Vec<String> = record.nodes.keys().cloned().collect();
    for uid in node_uids {
        let cp = record.nodes.get(&uid).cloned().unwrap();
        let effective_timeout_ms = cp.pending_timeout_ms.unwrap_or(default_timeout_ms);
        match crate::timeout::timeout_action(
            &cp,
            default_timeout_ms,
            effective_max_retries(&def, &uid, default_max_retries),
            now,
        ) {
            crate::timeout::TimeoutAction::StillWaiting => {}
            crate::timeout::TimeoutAction::Refire { attempt } => {
                if let Some(c) = record.nodes.get_mut(&uid) {
                    c.retries = attempt;
                }
                crate::telemetry::record_timeout(true);
                crate::functions::tick::fire_node(deps, &mut record, &def, &uid, &results).await?;
                timed_out_any = true;
            }
            crate::timeout::TimeoutAction::FailOut => {
                if let Some(c) = record.nodes.get_mut(&uid) {
                    c.state = NodeState::Failed;
                    c.result_error = Some(format!(
                        "engine_missing_completion_timeout: no completion/result observed before timeout_ms={} (retries={}); possible causes: invalid function return payload (e.g. bare/undefined), completion state write failure, or worker crash before completion event",
                        effective_timeout_ms,
                        c.retries,
                    ));
                }
                crate::telemetry::record_timeout(false);
                // FailOut is terminal for this node, but reconcile only polls
                // Running nodes — emit the node-duration here too, else timed-out
                // (the slowest) nodes would be absent from the histogram.
                let dur = cp
                    .pending_at
                    .map(|p| (now - p).max(0) as f64)
                    .unwrap_or(0.0);
                crate::telemetry::record_node_terminal(false, dur);
                timed_out_any = true;
            }
        }
    }

    // Apply full liveness-based memory cleanup in sweep as well, so stalled runs
    // still release transient payloads even when no regular tick progress occurs.
    let detached_result_uids =
        crate::functions::tick::release_consumed_memory_artifacts(deps, &def, &mut record)
            .await?;

    state::put_run(&deps.iii, &record).await?;

    for uid in &detached_result_uids {
        if let Err(e) = state::delete_node_result(&deps.iii, &record.run_id, uid).await {
            tracing::warn!(
                run_id = %record.run_id,
                node_uid = %uid,
                error = %e,
                "sweep: failed to delete detached node result payload"
            );
        }
    }

    // Re-drive: enqueue the next tick so the run can advance past the
    // newly-resolved nodes.
    if let Err(e) = start::enqueue_tick(&deps.iii, &record.run_id, record.step + 1).await {
        tracing::warn!(run_id = %record.run_id, error = %e, "sweep: re-enqueue tick failed");
    }

    if timed_out_any {
        tracing::info!(
            run_id = %record.run_id,
            "sweep: timed out one or more Running nodes"
        );
    }

    Ok(true)
}
