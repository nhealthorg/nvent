use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use crate::error::WorkflowError;
use crate::state::{self, SCOPE_RUN_STATE};
use crate::observability::{self, ObservabilityAdapter};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct StateDeleteRequest {
    pub run_id: String,
    pub key: String,
    #[serde(default)]
    pub node_uid: Option<String>,
}

pub async fn handle(deps: &Deps, req: StateDeleteRequest) -> Result<(), WorkflowError> {
    {
        let _g = deps.locks.guard(&req.run_id).await;
        let state_key = state::run_scoped_key(&req.run_id, &req.key);

        // 1. Delete value
        state::state_delete(&deps.iii, SCOPE_RUN_STATE, &state_key).await?;

        // 2. Atomically remove registry entry from workflow_run
        if state::get_run(&deps.iii, &req.run_id).await?.is_some() {
            state::state_update(
                &deps.iii,
                state::SCOPE_RUN,
                &req.run_id,
                json!([
                    {
                        "type": "merge",
                        "path": "state_keys_map",
                        "value": state::state_registry_merge_value(&req.key, false)
                    }
                ]),
            )
            .await?;
        }
    }

    // 3. Audit
    observability::adapter().write_trace(&deps.iii, &state::WorkflowRunTraceRecord {
        id: format!("tr_{}_{}", deps.now_ms(), crate::ids::new_trace_id()),
        run_id: req.run_id,
        node_uid: req.node_uid,
        function_id: Some("workflow::state-delete".to_string()),
        runtime: None,
        event_name: "workflow.state.delete".to_string(),
        ts_unix_ms: deps.now_ms(),
        attributes: Some(json!({
            "workflow.state.key": req.key,
        })),
        trace_id: None,
        span_id: None,
    }).await?;

    Ok(())
}
