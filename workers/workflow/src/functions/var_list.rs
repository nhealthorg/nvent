use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::WorkflowError;
use crate::state;

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct VarListRequest {
    pub run_id: String,
    #[serde(default)]
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct VarItem {
    pub key: String,
    pub version: u64,
    pub updated_at: i64,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct VarListResponse {
    pub items: Vec<VarItem>,
}

pub async fn handle(deps: &Deps, req: VarListRequest) -> Result<VarListResponse, WorkflowError> {
    if state::get_run(&deps.iii, &req.run_id).await?.is_none() {
        return Ok(VarListResponse { items: Vec::new() });
    }

    let vars = state::get_run_vars(&deps.iii, &req.run_id).await?;

    let mut items: Vec<VarItem> = vars
        .into_values()
        .filter(|entry| {
            if let Some(key) = req.key.as_deref() {
                entry.key == key
            } else {
                true
            }
        })
        .map(|entry| VarItem {
            key: entry.key,
            version: entry.version,
            updated_at: entry.updated_at,
            value: entry.value,
        })
        .collect();

    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(VarListResponse { items })
}
