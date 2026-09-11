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

    // 1. Channel mapping label: [RUN_ID]_[stream_name]
    let channel = state::run_scoped_key(&run_id_ref, &stream_name);
    let item_id = format!("st_{}_{}", ts_unix_ms, crate::ids::new_trace_id());

    let payload = json!({
        "type": event_type,
        "data": data,
        "run_id": run_id,
        "node_uid": node_uid,
        "ts_unix_ms": ts_unix_ms,
    });

    // 2. Update Registry in workflow_run record
    {
        let _g = deps.locks.guard(&run_id).await;
        if let Some(mut record) = state::get_run(&deps.iii, &run_id).await? {
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

    // 3. Persist into iii-stream
    deps.iii
        .trigger(TriggerRequest {
            function_id: "stream::set".into(),
            payload: json!({
                "stream_name": stream_name,
                "group_id": run_id,
                "item_id": item_id,
                "data": payload,
            }),
            action: None,
            timeout_ms: Some(30_000),
        })
        .await
        .map_err(|e| WorkflowError::State(format!("stream::set {channel}: {e}")))?;

    // 4. Automatic Audit
    observability::adapter()
        .write_trace(
            &deps.iii,
            &state::WorkflowRunTraceRecord {
                id: format!("tr_{}_{}", deps.now_ms(), crate::ids::new_trace_id()),
                run_id: run_id_ref,
                node_uid,
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
