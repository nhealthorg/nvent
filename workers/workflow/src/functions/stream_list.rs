use schemars::JsonSchema;
use serde::Deserialize;

use crate::error::WorkflowError;
use crate::state;

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct StreamListRequest {
    pub run_id: String,
}

pub async fn handle(deps: &Deps, req: StreamListRequest) -> Result<Vec<String>, WorkflowError> {
    let run = state::get_run(&deps.iii, &req.run_id).await?;
    match run {
        Some(r) => {
            let mut unique = Vec::new();
            for stream_id in r.stream_ids {
                if !unique.iter().any(|existing| existing == &stream_id) {
                    unique.push(stream_id);
                }
            }
            Ok(unique)
        }
        None => Ok(Vec::new()),
    }
}
