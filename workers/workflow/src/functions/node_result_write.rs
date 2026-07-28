use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::{error::WorkflowError, state};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct NodeResultWriteRequest {
    pub run_id: String,
    /// Node uid: node id for plain nodes, or "{node_id}#{i}" for fanout items.
    #[serde(alias = "uid")]
    pub node_uid: String,
    pub result: Value,
}

pub async fn handle(deps: &Deps, req: NodeResultWriteRequest) -> Result<(), WorkflowError> {
    let _g = deps.locks.guard(&req.run_id).await;

    // Ignore stale late-writes for runs that were already swept/cancelled.
    if state::get_run(&deps.iii, &req.run_id).await?.is_none() {
        return Ok(());
    }

    state::put_node_result(&deps.iii, &req.run_id, &req.node_uid, &req.result).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_accepts_uid_alias() {
        let req: NodeResultWriteRequest = serde_json::from_value(json!({
            "run_id": "r",
            "uid": "step#1",
            "result": {"ok": true}
        }))
        .expect("decode with uid alias");
        assert_eq!(req.node_uid, "step#1");
    }

    #[test]
    fn request_accepts_canonical_node_uid() {
        let req: NodeResultWriteRequest = serde_json::from_value(json!({
            "run_id": "r",
            "node_uid": "step#2",
            "result": {"ok": true}
        }))
        .expect("decode with canonical node_uid");
        assert_eq!(req.node_uid, "step#2");
    }
}
