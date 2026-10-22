use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    error::WorkflowError,
    state,
    types::{RunStatus, WorkflowRunSummary},
};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListRunsRequest {
    pub status: Option<RunStatus>,
    pub workflow_id: Option<String>,
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub cursor: Option<String>,
}

fn default_limit() -> usize {
    20
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ListRunsResponse {
    pub runs: Vec<WorkflowRunSummary>,
    pub pagination: PaginationInfo,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PaginationInfo {
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

pub async fn handle(deps: &Deps, req: ListRunsRequest) -> Result<ListRunsResponse, WorkflowError> {
    let ListRunsRequest {
        status,
        workflow_id,
        workflow,
        limit,
        offset,
        cursor,
    } = req;

    let limit = limit.clamp(1, 100);
    let (runs, next_cursor, has_more, total) = state::list_run_summaries(
        &deps.iii,
        status,
        workflow_id,
        workflow,
        limit,
        cursor.as_deref(),
        offset,
    )
    .await?;
    Ok(ListRunsResponse {
        runs,
        pagination: PaginationInfo {
            total,
            limit,
            offset,
            next_cursor,
            has_more,
        },
    })
}
