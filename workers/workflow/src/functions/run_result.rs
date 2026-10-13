use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{error::WorkflowError, state};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RunResultRequest {
    /// The `run_id` returned by `nworkflow::start`.
    pub run_id: String,
    /// Whether to resolve and return the full stored result payload.
    /// Set false to retrieve only the result reference.
    #[serde(default = "default_include_result")]
    pub include_result: bool,
}

fn default_include_result() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RunResultResponse {
    /// Terminal workflow output, or null when unavailable.
    pub result: Option<Value>,
    /// Internal result reference that can be retained for deferred retrieval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<String>,
}

pub async fn handle(
    deps: &Deps,
    req: RunResultRequest,
) -> Result<RunResultResponse, WorkflowError> {
    let Some(record) = state::get_run(&deps.iii, &req.run_id).await? else {
        return Ok(RunResultResponse {
            result: None,
            result_ref: None,
        });
    };
    let result_ref = record.result_ref.clone();
    let result = if req.include_result {
        match result_ref.as_deref() {
            Some(result_ref) => state::get_run_result(&deps.iii, result_ref).await?,
            None => None,
        }
    } else {
        None
    };
    Ok(RunResultResponse { result, result_ref })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn run_result_response_serde_round_trip() {
        let resp = RunResultResponse {
            result: Some(json!({"ok": true})),
            result_ref: Some("run_result_123".to_string()),
        };
        let s = serde_json::to_string(&resp).expect("serialize");
        let decoded: RunResultResponse = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(decoded.result, resp.result);
    }

    #[test]
    fn run_result_response_serializes_explicit_null() {
        let v = serde_json::to_value(RunResultResponse {
            result: None,
            result_ref: None,
        })
        .expect("serialize");
        assert!(v.get("result").is_some(), "result key is always present");
        assert!(v["result"].is_null(), "result is null when None");
    }

    #[test]
    fn run_result_request_defaults_to_payload_and_accepts_reference_only_mode() {
        let default_request: RunResultRequest =
            serde_json::from_value(json!({"run_id": "r_123"})).expect("decode default request");
        assert!(default_request.include_result);

        let reference_request: RunResultRequest = serde_json::from_value(json!({
            "run_id": "r_123",
            "include_result": false
        }))
        .expect("decode reference-only request");
        assert!(!reference_request.include_result);
    }
}
