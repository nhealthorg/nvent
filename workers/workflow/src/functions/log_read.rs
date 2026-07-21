use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::observability::ObservabilityAdapter;
use crate::{error::WorkflowError, observability, state};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct LogReadRequest {
    pub run_id: String,
    #[serde(default)]
    pub node_uid: Option<String>,
    #[serde(default)]
    pub function_id: Option<String>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub start_time_ms: Option<i64>,
    #[serde(default)]
    pub end_time_ms: Option<i64>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct LogReadResponse {
    pub logs: Vec<state::WorkflowRunLogRecord>,
}

pub async fn handle(deps: &Deps, req: LogReadRequest) -> Result<LogReadResponse, WorkflowError> {
    let items = observability::adapter()
        .read_logs(
            &deps.iii,
            &req.run_id,
            &observability::LogReadFilter {
                node_uid: req.node_uid,
                function_id: req.function_id,
                level: req.level,
                start_time_ms: req.start_time_ms,
                end_time_ms: req.end_time_ms,
                limit: req.limit,
            },
        )
        .await?;

    Ok(LogReadResponse { logs: items })
}
