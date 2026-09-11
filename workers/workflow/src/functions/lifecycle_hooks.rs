use iii_sdk::protocol::TriggerRequest;
use iii_sdk::TriggerAction;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

use crate::functions::Deps;
use crate::types::{RunStatus, WorkflowDef, WorkflowLifecycleHookSpec, WorkflowRunRecord};

fn hook_spec_for_start(def: &WorkflowDef) -> Option<&WorkflowLifecycleHookSpec> {
    def.metadata
        .as_ref()
        .and_then(|m| m.hooks.as_ref())
        .and_then(|h| h.on_start.as_ref())
}

fn hook_spec_for_terminal(
    def: &WorkflowDef,
    status: RunStatus,
) -> Option<&WorkflowLifecycleHookSpec> {
    let hooks = def.metadata.as_ref().and_then(|m| m.hooks.as_ref())?;
    match status {
        RunStatus::Completed => hooks.on_end.as_ref(),
        RunStatus::Failed | RunStatus::Cancelled => hooks.on_error.as_ref(),
        _ => None,
    }
}

fn hook_spec_for_delete(def: &WorkflowDef) -> Option<&WorkflowLifecycleHookSpec> {
    def.metadata
        .as_ref()
        .and_then(|m| m.hooks.as_ref())
        .and_then(|h| h.on_delete.as_ref())
}

fn resolve_hook_target(
    hook: Option<&WorkflowLifecycleHookSpec>,
) -> Option<(&str, Option<&BTreeMap<String, Value>>)> {
    let hook = hook?;
    let function_id = hook.function_id().trim();
    if function_id.is_empty() {
        return None;
    }

    Some((function_id, hook.static_input()))
}

fn merge_hook_payload(payload: Value, static_input: Option<&BTreeMap<String, Value>>) -> Value {
    let Some(static_input) = static_input else {
        return payload;
    };

    let Value::Object(payload_map) = payload else {
        return payload;
    };

    let mut merged = Map::new();
    for (key, value) in static_input {
        merged.insert(key.clone(), value.clone());
    }

    // Runtime hook metadata must win on key collisions.
    for (key, value) in payload_map {
        merged.insert(key, value);
    }

    Value::Object(merged)
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
    let Some((function_id, static_input)) = resolve_hook_target(hook_spec_for_start(def)) else {
        return;
    };

    let payload = merge_hook_payload(
        json!({
            "event": "on_start",
            "run_id": record.run_id,
            "status": record.status,
            "workflow_name": record.workflow_name,
            "created_at": record.created_at,
        }),
        static_input,
    );

    trigger_hook(deps, function_id, payload).await;
}

pub async fn emit_terminal(
    deps: &Deps,
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    result: Option<Value>,
) {
    let Some((function_id, static_input)) =
        resolve_hook_target(hook_spec_for_terminal(def, record.status))
    else {
        return;
    };

    let payload = merge_hook_payload(
        json!({
            "event": if record.status == RunStatus::Completed { "on_end" } else { "on_error" },
            "run_id": record.run_id,
            "status": record.status,
            "workflow_name": record.workflow_name,
            "result": result,
            "result_error": record.result_error,
            "updated_at": record.updated_at,
        }),
        static_input,
    );

    trigger_hook(deps, function_id, payload).await;
}

pub async fn emit_delete(
    deps: &Deps,
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    result: Option<Value>,
) {
    let Some((function_id, static_input)) = resolve_hook_target(hook_spec_for_delete(def)) else {
        return;
    };

    let payload = merge_hook_payload(
        json!({
            "event": "on_delete",
            "run_id": record.run_id,
            "status": record.status,
            "workflow_name": record.workflow_name,
            "was_terminal": record.status.is_terminal(),
            "result": result,
            "result_error": record.result_error,
            "deleted_at": deps.now_ms(),
        }),
        static_input,
    );

    trigger_hook(deps, function_id, payload).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{WorkflowLifecycleHookSpec, WorkflowLifecycleHookTarget};

    #[test]
    fn resolve_hook_target_rejects_empty_function_id() {
        let spec = WorkflowLifecycleHookSpec::FunctionId("   ".to_string());
        assert!(resolve_hook_target(Some(&spec)).is_none());
    }

    #[test]
    fn resolve_hook_target_reads_object_spec_with_input() {
        let mut input = BTreeMap::new();
        input.insert("team".to_string(), Value::String("ops".to_string()));

        let spec = WorkflowLifecycleHookSpec::Target(WorkflowLifecycleHookTarget {
            function: "hook::start".to_string(),
            input: Some(input),
        });

        let Some((function_id, static_input)) = resolve_hook_target(Some(&spec)) else {
            panic!("hook target must resolve");
        };

        assert_eq!(function_id, "hook::start");
        assert_eq!(
            static_input
                .and_then(|map| map.get("team"))
                .and_then(|v| v.as_str()),
            Some("ops")
        );
    }

    #[test]
    fn merge_hook_payload_runtime_keys_override_static_input() {
        let mut input = BTreeMap::new();
        input.insert("event".to_string(), Value::String("custom".to_string()));
        input.insert("team".to_string(), Value::String("ops".to_string()));

        let merged = merge_hook_payload(
            json!({
                "event": "on_start",
                "run_id": "run_1",
            }),
            Some(&input),
        );

        assert_eq!(
            merged.get("event").and_then(|v| v.as_str()),
            Some("on_start")
        );
        assert_eq!(merged.get("team").and_then(|v| v.as_str()), Some("ops"));
        assert_eq!(merged.get("run_id").and_then(|v| v.as_str()), Some("run_1"));
    }
}
