use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    error::WorkflowError,
    state,
    types::{RunStatus, WorkflowRunRecord},
};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListRunsRequest {
    pub status: Option<RunStatus>,
    pub workflow: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
}

fn default_limit() -> usize {
    20
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ListRunsResponse {
    pub runs: Vec<WorkflowRunRecord>,
    pub pagination: PaginationInfo,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PaginationInfo {
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
}

pub async fn handle(deps: &Deps, req: ListRunsRequest) -> Result<ListRunsResponse, WorkflowError> {
    let ListRunsRequest {
        status,
        workflow,
        limit,
        offset,
    } = req;

    // Filters are delegated to the internal state layer (Redis-native when available).
    let mut filtered: Vec<WorkflowRunRecord> =
        state::list_runs_filtered(&deps.iii, status, workflow).await?;

    // 3. Sort (newest first)
    filtered.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    // 4. Paginate
    let total = filtered.len();
    let runs = filtered.into_iter().skip(offset).take(limit).collect();

    Ok(ListRunsResponse {
        runs,
        pagination: PaginationInfo {
            total,
            limit,
            offset,
        },
    })
}
