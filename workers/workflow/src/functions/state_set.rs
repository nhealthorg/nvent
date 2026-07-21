use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::WorkflowError;
use crate::state::{self, SCOPE_RUN_STATE};
use crate::observability::{self, ObservabilityAdapter};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct StateSetRequest {
    pub run_id: String,
    pub key: String,
    pub value: Value,
    #[serde(default)]
    pub node_uid: Option<String>,
}

pub async fn handle(deps: &Deps, req: StateSetRequest) -> Result<(), WorkflowError> {
    {
        let _g = deps.locks.guard(&req.run_id).await;

        // 1. Map key: [RUN_ID]_[key]
        let state_key = state::run_scoped_key(&req.run_id, &req.key);

        // 2. Set value in workflow_run_state
        state::state_set(&deps.iii, SCOPE_RUN_STATE, &state_key, req.value.clone()).await?;

        // 3. Atomically upsert registry entry in workflow_run
        if state::get_run(&deps.iii, &req.run_id).await?.is_some() {
            state::state_update(
                &deps.iii,
                state::SCOPE_RUN,
                &req.run_id,
                json!([
                    {
                        "type": "merge",
                        "path": "state_keys_map",
                        "value": state::state_registry_merge_value(&req.key, true)
                    }
                ]),
            )
            .await?;
        }
    }

    // 4. Automatic Audit
    observability::adapter().write_trace(&deps.iii, &state::WorkflowRunTraceRecord {
        id: format!("tr_{}_{}", deps.now_ms(), crate::ids::new_trace_id()),
        run_id: req.run_id,
        node_uid: req.node_uid,
        function_id: Some("workflow::state-set".to_string()),
        runtime: None,
        event_name: "workflow.state.set".to_string(),
        ts_unix_ms: deps.now_ms(),
        attributes: Some(json!({
            "workflow.state.key": req.key,
            "workflow.state.value": truncate_value(&req.value),
        })),
        trace_id: None,
        span_id: None,
    }).await?;

    Ok(())
}

fn truncate_value(v: &Value) -> Value {
    match v {
        Value::String(s) if s.len() > 200 => json!(format!("{}...", &s[..200])),
        Value::Object(_) | Value::Array(_) => {
            let s = serde_json::to_string(v).unwrap_or_default();
            if s.len() > 500 {
                json!(format!("{}...[truncated]", &s[..500]))
            } else {
                v.clone()
            }
        }
        _ => v.clone(),
    }
}
