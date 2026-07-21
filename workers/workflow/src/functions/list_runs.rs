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
  // 1. Get ALL runs from state (bottleneck for now, but encapsulated in worker)
  // Optimization note: Once the underlying iii-state supports filtered listing,
  // we can push this logic down. For now, the worker acts as the clearing house.
  let all_runs = state::list_runs(&deps.iii).await?;
  
  // 2. Filter
  let mut filtered: Vec<WorkflowRunRecord> = all_runs
    .into_iter()
    .filter(|r| {
        // Status filter
        if let Some(status) = &req.status {
            if r.status != *status {
                // Special case: 'running' often maps to both running and awaiting_nodes in UI,
                // but here we use the exact enum match from the request.
                return false;
            }
        }
        
        // Workflow ID / Prefix / Name filter
        if let Some(workflow) = &req.workflow {
            let filter = workflow.to_lowercase();
            let matches_ref = r.def_ref.to_lowercase().contains(&filter);
            let matches_id = r.run_id.to_lowercase().contains(&filter);
            let matches_name = r.workflow_name.as_ref()
                .map(|n| n.to_lowercase().contains(&filter))
                .unwrap_or(false);
                
            if !matches_ref && !matches_id && !matches_name {
                return false;
            }
        }
        
        true
    })
    .collect();

  // 3. Sort (newest first)
  filtered.sort_by(|a, b| b.created_at.cmp(&a.created_at));

  // 4. Paginate
  let total = filtered.len();
  let runs = filtered
    .into_iter()
    .skip(req.offset)
    .take(req.limit)
    .collect();

  Ok(ListRunsResponse {
    runs,
    pagination: PaginationInfo {
        total,
        limit: req.limit,
        offset: req.offset,
    },
  })
}
