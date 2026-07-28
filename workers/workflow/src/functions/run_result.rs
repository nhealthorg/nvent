use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{error::WorkflowError, state};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RunResultRequest {
    /// The `run_id` returned by `workflow::start`.
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RunResultResponse {
    /// Terminal workflow output, or null when unavailable.
    pub result: Option<Value>,
}

pub async fn handle(deps: &Deps, req: RunResultRequest) -> Result<RunResultResponse, WorkflowError> {
    let result = state::get_run_result(&deps.iii, &req.run_id).await?;
    Ok(RunResultResponse { result })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn run_result_response_serde_round_trip() {
        let resp = RunResultResponse {
            result: Some(json!({"ok": true})),
        };
        let s = serde_json::to_string(&resp).expect("serialize");
        let decoded: RunResultResponse = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(decoded.result, resp.result);
    }

    #[test]
    fn run_result_response_serializes_explicit_null() {
        let v = serde_json::to_value(RunResultResponse { result: None }).expect("serialize");
        assert!(v.get("result").is_some(), "result key is always present");
        assert!(v["result"].is_null(), "result is null when None");
    }
}
