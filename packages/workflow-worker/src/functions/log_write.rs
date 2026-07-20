use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::observability::ObservabilityAdapter;
use crate::{error::WorkflowError, observability, state};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct LogWriteRequest {
    pub run_id: String,
    pub id: String,
    #[serde(default)]
    pub node_uid: Option<String>,
    #[serde(default)]
    pub function_id: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    pub level: String,
    pub message: String,
    pub ts_unix_ms: i64,
    #[serde(default)]
    pub data: Option<Value>,
}

pub async fn handle(deps: &Deps, req: LogWriteRequest) -> Result<(), WorkflowError> {
    let _g = deps.locks.guard(&req.run_id).await;

    if state::get_run(&deps.iii, &req.run_id).await?.is_none() {
        return Ok(());
    }

    observability::adapter()
        .write_log(
            &deps.iii,
            &state::WorkflowRunLogRecord {
            id: req.id,
            run_id: req.run_id,
            node_uid: req.node_uid,
            function_id: req.function_id,
            runtime: req.runtime,
            level: req.level,
            message: req.message,
            ts_unix_ms: req.ts_unix_ms,
            data: req.data,
            },
        )
        .await
}
