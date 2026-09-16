use iii_sdk::protocol::TriggerRequest;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::error::WorkflowError;
use crate::observability::{self, ObservabilityAdapter};
use crate::state;

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct StreamPublishRequest {
    pub run_id: String,
    pub stream: String,
    pub data: Value,
    #[serde(default)]
    pub node_uid: Option<String>,
}

pub async fn publish_best_effort(deps: &Deps, requests: Vec<StreamPublishRequest>) {
    let timeout_ms = deps.cfg().await.dispatch_timeout_ms;

    for request in requests {
        let run_id = request.run_id.clone();
        let event_type = request.stream.clone();
        match tokio::time::timeout(
            Duration::from_millis(timeout_ms.max(1)),
            handle(deps, request),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(
                run_id = %run_id,
                event_type = %event_type,
                error = %error,
                "best-effort stream publication failed"
            ),
            Err(_) => tracing::warn!(
                run_id = %run_id,
                event_type = %event_type,
                timeout_ms,
                "best-effort stream publication timed out"
            ),
        }
    }
}

pub async fn handle(deps: &Deps, req: StreamPublishRequest) -> Result<(), WorkflowError> {
    let StreamPublishRequest {
        run_id,
        stream,
        data,
        node_uid,
    } = req;
    let data_preview = truncate_value(&data);
    let event_type = stream;
    let stream_name = state::STREAM_NAME_WORKFLOW.to_string();
    let run_id_ref = run_id.clone();
    let ts_unix_ms = deps.now_ms();
    let mut mirror_group_id = None;
    let mut mirror_node_uid = None;
    let mut mirror_node_path = Vec::new();

    // Register the stream on both the emitting run and its root run. The root
    // group is the single subscription surface for a nested workflow chain.
    {
        let _g = deps.locks.guard(&run_id).await;
        if let Some(mut record) = state::get_run(&deps.iii, &run_id).await? {
            mirror_group_id =
                mirror_target_group_id(&run_id, record.root_stream_scope_id.as_deref());
            mirror_node_uid = record.parent_node_uid.clone();
            if !record
                .stream_ids
                .iter()
                .any(|existing| existing == &stream_name)
            {
                record.stream_ids.push(stream_name.clone());
                state::put_run(&deps.iii, &record).await?;
            }
        }
    }

    if let Some(root_group_id) = mirror_group_id.as_deref() {
        mirror_node_path = resolve_node_path(deps, &run_id).await?;
        let _g = deps.locks.guard(root_group_id).await;
        if let Some(mut root_record) = state::get_run(&deps.iii, root_group_id).await? {
            if !root_record
                .stream_ids
                .iter()
                .any(|existing| existing == &stream_name)
            {
                root_record.stream_ids.push(stream_name.clone());
                state::put_run(&deps.iii, &root_record).await?;
            }
        }
    }

    let payload = json!({
        "type": event_type,
        "data": data,
        "run_id": run_id,
        "node_uid": node_uid,
        "ts_unix_ms": ts_unix_ms,
    });

    let item_id = publish_to_group(deps, &stream_name, &run_id_ref, &payload, "original").await?;

    if let Some(root_group_id) = mirror_group_id.as_deref() {
        let mirrored_payload = json!({
            "type": payload["type"],
            "data": payload["data"],
            "run_id": root_group_id,
            "node_uid": payload["node_uid"],
            "ts_unix_ms": payload["ts_unix_ms"],
            "origin_run_id": run_id_ref.clone(),
            "origin_node_uid": payload["node_uid"],
            "origin_stream_group_id": run_id_ref.clone(),
            "node_path": mirror_node_path,
            "mirrored": true,
        });
        publish_to_group(
            deps,
            &stream_name,
            root_group_id,
            &mirrored_payload,
            "mirror",
        )
        .await?;
    }

    // 4. Automatic Audit
    observability::adapter()
        .write_trace(
            &deps.iii,
            &state::WorkflowRunTraceRecord {
                id: format!("tr_{}_{}", deps.now_ms(), crate::ids::new_trace_id()),
                run_id: run_id_ref.clone(),
                node_uid: node_uid.clone(),
                function_id: Some("nworkflow::stream-publish".to_string()),
                runtime: None,
                event_name: "workflow.stream.publish".to_string(),
                ts_unix_ms,
                attributes: Some(json!({
                    "workflow.stream.name": stream_name,
                    "workflow.stream.event_type": event_type,
                    "workflow.stream.group_id": run_id,
                    "workflow.stream.item_id": item_id,
                    "workflow.stream.preview": data_preview,
                    "workflow.stream.payload": payload,
                })),
                trace_id: None,
                span_id: None,
            },
        )
        .await?;

    if let Some(root_group_id) = mirror_group_id {
        observability::adapter()
            .write_trace(
                &deps.iii,
                &state::WorkflowRunTraceRecord {
                    id: format!("tr_{}_{}", deps.now_ms(), crate::ids::new_trace_id()),
                    run_id: root_group_id.clone(),
                    node_uid: mirror_node_uid,
                    function_id: Some("nworkflow::stream-publish".to_string()),
                    runtime: None,
                    event_name: "workflow.stream.publish".to_string(),
                    ts_unix_ms,
                    attributes: Some(json!({
                        "workflow.stream.name": stream_name,
                        "workflow.stream.event_type": event_type,
                        "workflow.stream.group_id": root_group_id,
                        "workflow.stream.item_id": format!("{}:mirror", item_id),
                        "workflow.stream.mirrored": true,
                        "workflow.stream.origin_run_id": run_id_ref,
                        "workflow.stream.origin_node_uid": node_uid,
                        "workflow.stream.node_path": mirror_node_path,
                        "workflow.stream.preview": data_preview,
                        "workflow.stream.payload": payload,
                    })),
                    trace_id: None,
                    span_id: None,
                },
            )
            .await?;
    }

    Ok(())
}

/// The physical group id to mirror this run's event into, or `None` when this
/// run has no root linkage (top-level run) or already IS its own root group
/// (would otherwise double-publish into the same group). Pure.
fn mirror_target_group_id(run_id: &str, root_stream_scope_id: Option<&str>) -> Option<String> {
    root_stream_scope_id
        .filter(|root_group_id| *root_group_id != run_id)
        .map(str::to_string)
}

async fn resolve_node_path(deps: &Deps, origin_run_id: &str) -> Result<Vec<String>, WorkflowError> {
    let mut path = Vec::new();
    let mut current_run_id = origin_run_id.to_string();

    for _ in 0..32 {
        let Some(record) = state::get_run(&deps.iii, &current_run_id).await? else {
            break;
        };
        let Some(node_uid) = record.parent_node_uid else {
            break;
        };
        path.push(node_uid);
        let Some(parent_run_id) = record.parent_run_id else {
            break;
        };
        current_run_id = parent_run_id;
    }

    path.reverse();
    Ok(path)
}

async fn publish_to_group(
    deps: &Deps,
    stream_name: &str,
    group_id: &str,
    payload: &Value,
    item_suffix: &str,
) -> Result<String, WorkflowError> {
    let channel = state::run_scoped_key(group_id, stream_name);
    let item_id = format!(
        "st_{}_{}_{}",
        payload["ts_unix_ms"].as_i64().unwrap_or_default(),
        item_suffix,
        crate::ids::new_trace_id()
    );

    deps.iii
        .trigger(TriggerRequest {
            function_id: "stream::set".into(),
            payload: json!({
                "stream_name": stream_name,
                "group_id": group_id,
                "item_id": item_id,
                "data": payload,
            }),
            action: None,
            timeout_ms: Some(30_000),
        })
        .await
        .map_err(|e| WorkflowError::State(format!("stream::set {channel}: {e}")))?;

    Ok(item_id)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_target_group_id_is_none_without_root_linkage() {
        // A top-level run has no root_stream_scope_id: never mirrors.
        assert_eq!(mirror_target_group_id("r_root", None), None);
    }

    #[test]
    fn mirror_target_group_id_is_none_when_root_equals_self() {
        // Defensive: never mirror a run into its own group.
        assert_eq!(mirror_target_group_id("r_root", Some("r_root")), None);
    }

    #[test]
    fn mirror_target_group_id_targets_the_actual_root_run_id() {
        // A nested child mirrors into the root's own run_id — the physical
        // group every reader (and the root's own writes) is keyed on.
        assert_eq!(
            mirror_target_group_id("r_child", Some("r_root")),
            Some("r_root".to_string())
        );
    }
}
