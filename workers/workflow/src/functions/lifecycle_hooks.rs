use iii_sdk::protocol::TriggerRequest;
use iii_sdk::TriggerAction;
use serde_json::{json, Value};

use crate::functions::Deps;
use crate::types::{RunStatus, WorkflowDef, WorkflowRunRecord};

fn hook_id_for_start(def: &WorkflowDef) -> Option<&str> {
    def.metadata
        .as_ref()
        .and_then(|m| m.hooks.as_ref())
        .and_then(|h| h.on_start.as_deref())
        .filter(|id| !id.trim().is_empty())
}

fn hook_id_for_terminal(def: &WorkflowDef, status: RunStatus) -> Option<&str> {
    let hooks = def.metadata.as_ref().and_then(|m| m.hooks.as_ref())?;
    let hook_id = match status {
        RunStatus::Completed => hooks.on_end.as_deref(),
        RunStatus::Failed | RunStatus::Cancelled => hooks.on_error.as_deref(),
        _ => None,
    }?;

    if hook_id.trim().is_empty() {
        None
    } else {
        Some(hook_id)
    }
}

fn hook_id_for_delete(def: &WorkflowDef) -> Option<&str> {
    def.metadata
        .as_ref()
        .and_then(|m| m.hooks.as_ref())
        .and_then(|h| h.on_delete.as_deref())
        .filter(|id| !id.trim().is_empty())
}

async fn trigger_hook(deps: &Deps, function_id: &str, payload: Value) {
    let res = deps
        .iii
        .trigger(TriggerRequest {
            function_id: function_id.to_string(),
            payload,
            action: Some(TriggerAction::Enqueue {
                queue: "default".to_string(),
            }),
            timeout_ms: None,
        })
        .await;

    if let Err(err) = res {
        tracing::warn!(
            function_id = %function_id,
            error = %err,
            "workflow lifecycle hook dispatch failed"
        );
    }
}

pub async fn emit_start(deps: &Deps, def: &WorkflowDef, record: &WorkflowRunRecord) {
    let Some(function_id) = hook_id_for_start(def) else {
        return;
    };

    let payload = json!({
        "event": "on_start",
        "run_id": record.run_id,
        "status": record.status,
        "workflow_name": record.workflow_name,
        "created_at": record.created_at,
    });

    trigger_hook(deps, function_id, payload).await;
}

pub async fn emit_terminal(
    deps: &Deps,
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    result: Option<Value>,
) {
    let Some(function_id) = hook_id_for_terminal(def, record.status) else {
        return;
    };

    let payload = json!({
        "event": if record.status == RunStatus::Completed { "on_end" } else { "on_error" },
        "run_id": record.run_id,
        "status": record.status,
        "workflow_name": record.workflow_name,
        "result": result,
        "result_error": record.result_error,
        "updated_at": record.updated_at,
    });

    trigger_hook(deps, function_id, payload).await;
}

pub async fn emit_delete(
    deps: &Deps,
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    result: Option<Value>,
) {
    let Some(function_id) = hook_id_for_delete(def) else {
        return;
    };

    let payload = json!({
        "event": "on_delete",
        "run_id": record.run_id,
        "status": record.status,
        "workflow_name": record.workflow_name,
        "was_terminal": record.status.is_terminal(),
        "result": result,
        "result_error": record.result_error,
        "deleted_at": deps.now_ms(),
    });

    trigger_hook(deps, function_id, payload).await;
}
