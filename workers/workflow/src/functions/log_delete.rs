use schemars::JsonSchema;
use serde::Deserialize;

use crate::observability::ObservabilityAdapter;
use crate::{error::WorkflowError, observability};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct LogDeleteRequest {
    pub run_id: String,
    #[serde(default)]
    pub id: Option<String>,
}

pub async fn handle(deps: &Deps, req: LogDeleteRequest) -> Result<(), WorkflowError> {
    observability::adapter()
        .delete_log(&deps.iii, &req.run_id, req.id.as_deref())
        .await
}
