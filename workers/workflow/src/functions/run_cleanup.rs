use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{error::WorkflowError, functions::Deps, types::RunStatus};

const MAX_RETENTION_DAYS: u32 = 3650;
const MAX_FAILURE_DETAILS: usize = 50;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RunCleanupRequest {
    pub older_than_days: u32,
    #[serde(default)]
    pub execute: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct RunCleanupFailure {
    pub run_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct RunCleanupResponse {
    pub older_than_days: u32,
    pub cutoff_unix_ms: i64,
    pub eligible: usize,
    pub deleted: usize,
    pub failed: usize,
    pub failures: Vec<RunCleanupFailure>,
    pub executed: bool,
}

fn cutoff_for_days(now: i64, days: u32) -> Result<i64, WorkflowError> {
    if !(1..=MAX_RETENTION_DAYS).contains(&days) {
        return Err(WorkflowError::InvalidDef(format!(
            "older_than_days must be between 1 and {MAX_RETENTION_DAYS}"
        )));
    }
    Ok(now.saturating_sub(i64::from(days).saturating_mul(DAY_MS)))
}

fn eligible_terminal(status: RunStatus, updated_at: i64, cutoff: i64) -> bool {
    matches!(status, RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled)
        && updated_at < cutoff
}

pub async fn handle(
    deps: &Deps,
    req: RunCleanupRequest,
) -> Result<RunCleanupResponse, WorkflowError> {
    let now = deps.now_ms();
    let cutoff_unix_ms = cutoff_for_days(now, req.older_than_days)?;
    let runs = crate::state::list_runs(&deps.iii).await?;
    let eligible = runs
        .iter()
        .filter(|run| eligible_terminal(run.status, run.updated_at, cutoff_unix_ms))
        .collect::<Vec<_>>();
    let eligible_count = eligible.len();

    if !req.execute {
        return Ok(RunCleanupResponse {
            older_than_days: req.older_than_days,
            cutoff_unix_ms,
            eligible: eligible_count,
            deleted: 0,
            failed: 0,
            failures: Vec::new(),
            executed: false,
        });
    }

    let mut deleted = 0;
    let mut failed = 0;
    let mut failures = Vec::new();
    for run in eligible {
        match super::run_delete::delete_run_by_id(deps, &run.run_id).await {
            Ok(response) if response.deleted => deleted += 1,
            Ok(response) => {
                failed += 1;
                if failures.len() < MAX_FAILURE_DETAILS {
                    failures.push(RunCleanupFailure {
                        run_id: run.run_id.clone(),
                        error: format!(
                            "delete was not completed ({} child workflows failed)",
                            response.child_workflows_failed
                        ),
                    });
                }
            }
            Err(error) => {
                failed += 1;
                if failures.len() < MAX_FAILURE_DETAILS {
                    failures.push(RunCleanupFailure {
                        run_id: run.run_id.clone(),
                        error: error.to_string(),
                    });
                }
            }
        }
    }

    Ok(RunCleanupResponse {
        older_than_days: req.older_than_days,
        cutoff_unix_ms,
        eligible: eligible_count,
        deleted,
        failed,
        failures,
        executed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutoff_accepts_supported_days_and_rejects_invalid_values() {
        assert_eq!(cutoff_for_days(10 * DAY_MS, 2).unwrap(), 8 * DAY_MS);
        assert!(cutoff_for_days(0, 0).is_err());
        assert!(cutoff_for_days(0, MAX_RETENTION_DAYS + 1).is_err());
    }

    #[test]
    fn request_ignores_engine_injected_metadata() {
        let request: RunCleanupRequest = serde_json::from_value(serde_json::json!({
            "older_than_days": 2,
            "execute": false,
            "_caller_worker_id": "app-worker"
        }))
        .expect("engine-injected metadata is ignored");

        assert_eq!(request.older_than_days, 2);
        assert!(!request.execute);
    }

    #[test]
    fn only_old_terminal_runs_are_eligible() {
        let cutoff = 100;
        assert!(eligible_terminal(RunStatus::Completed, 99, cutoff));
        assert!(eligible_terminal(RunStatus::Failed, 99, cutoff));
        assert!(eligible_terminal(RunStatus::Cancelled, 99, cutoff));
        assert!(!eligible_terminal(RunStatus::AwaitingNodes, 1, cutoff));
        assert!(!eligible_terminal(RunStatus::Running, 1, cutoff));
        assert!(!eligible_terminal(RunStatus::Completed, cutoff, cutoff));
    }
}