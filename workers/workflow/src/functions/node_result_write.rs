use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::{
    error::WorkflowError,
    state,
    types::{NodeMemoryFailPolicy, NodeResultReturnType},
};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct NodeResultWriteRequest {
    pub run_id: String,
    /// Node uid: node id for plain nodes, or "{node_id}#{i}" for fanout items.
    #[serde(alias = "uid")]
    pub node_uid: String,
    /// Optional dispatch attempt number for out-of-order protection.
    #[serde(default)]
    pub attempt: Option<u32>,
    pub result: Value,
}

fn should_persist_result(
    return_type: NodeResultReturnType,
    on_memory_fail: Option<NodeMemoryFailPolicy>,
) -> bool {
    matches!(return_type, NodeResultReturnType::Store | NodeResultReturnType::Stream)
        || matches!(
            (return_type, on_memory_fail),
            (NodeResultReturnType::Memory, Some(NodeMemoryFailPolicy::Store))
        )
}

pub async fn handle(deps: &Deps, req: NodeResultWriteRequest) -> Result<(), WorkflowError> {
    let _g = deps.locks.guard(&req.run_id).await;

    // Ignore stale late-writes for runs that were already swept/cancelled.
    let Some(record) = state::get_run(&deps.iii, &req.run_id).await? else {
        return Ok(());
    };

    let Some(checkpoint) = record.nodes.get(&req.node_uid) else {
        return Ok(());
    };

    if checkpoint.state != crate::types::NodeState::Running {
        return Ok(());
    }

    if let Some(attempt) = req.attempt {
        if checkpoint.retries != attempt {
            return Ok(());
        }
    }

    let base_node_id = req.node_uid.split('#').next().unwrap_or(req.node_uid.as_str());
    let result_policy = state::get_def(&deps.iii, &record.def_ref)
        .await?
        .and_then(|def| def.nodes.get(base_node_id).cloned())
        .and_then(|node| node.result);

    let return_type = result_policy
        .as_ref()
        .map(|result| result.return_type)
        .unwrap_or(NodeResultReturnType::Memory);
    let on_memory_fail = result_policy.as_ref().and_then(|result| result.on_memory_fail);

    if should_persist_result(return_type, on_memory_fail) {
        let _ = state::delete_node_result_memory(&req.run_id, &req.node_uid);
        state::put_node_result(&deps.iii, &req.run_id, &req.node_uid, &req.result).await
    } else {
        state::put_node_result_memory(&req.run_id, &req.node_uid, &req.result)?;
        state::delete_node_result_store(&deps.iii, &req.run_id, &req.node_uid).await
    }
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
            "attempt": 2,
            "result": {"ok": true}
        }))
        .expect("decode with uid alias");
        assert_eq!(req.node_uid, "step#1");
        assert_eq!(req.attempt, Some(2));
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

    #[test]
    fn should_persist_result_for_store_stream_and_memory_store_fallback() {
        assert!(should_persist_result(NodeResultReturnType::Store, None));
        assert!(should_persist_result(NodeResultReturnType::Stream, None));
        assert!(should_persist_result(
            NodeResultReturnType::Memory,
            Some(NodeMemoryFailPolicy::Store)
        ));
        assert!(!should_persist_result(NodeResultReturnType::Memory, None));
    }
}
