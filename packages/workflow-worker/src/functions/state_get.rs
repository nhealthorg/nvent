use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::error::WorkflowError;
use crate::state::{self, SCOPE_RUN_STATE};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct StateGetRequest {
    pub run_id: String,
    pub key: String,
}

pub async fn handle(deps: &Deps, req: StateGetRequest) -> Result<Value, WorkflowError> {
    let state_key = state::run_scoped_key(&req.run_id, &req.key);
    state::state_get(&deps.iii, SCOPE_RUN_STATE, &state_key).await
}
