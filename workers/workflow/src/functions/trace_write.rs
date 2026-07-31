use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::observability::ObservabilityAdapter;
use crate::{error::WorkflowError, observability, state};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct TraceWriteRequest {
    pub run_id: String,
    pub id: String,
    #[serde(default)]
    pub node_uid: Option<String>,
    #[serde(default)]
    pub function_id: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    pub event_name: String,
    pub ts_unix_ms: i64,
    #[serde(default)]
    pub attributes: Option<Value>,
    #[serde(default)]
    pub trace_id: Option<String>,
    #[serde(default)]
    pub span_id: Option<String>,
}

pub async fn handle(deps: &Deps, req: TraceWriteRequest) -> Result<(), WorkflowError> {
    let _g = deps.locks.guard(&req.run_id).await;

    if state::get_run(&deps.iii, &req.run_id).await?.is_none() {
        return Ok(());
    }

    observability::adapter()
        .write_trace(
            &deps.iii,
            &state::WorkflowRunTraceRecord {
                id: req.id,
                run_id: req.run_id,
                node_uid: req.node_uid,
                function_id: req.function_id,
                runtime: req.runtime,
                event_name: req.event_name,
                ts_unix_ms: req.ts_unix_ms,
                attributes: req.attributes,
                trace_id: req.trace_id,
                span_id: req.span_id,
            },
        )
        .await
}
