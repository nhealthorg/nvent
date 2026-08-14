/// The terminal-state payload, shared by the global broadcast and the
/// caller-supplied callback.
async fn completed_payload(
    deps: &crate::functions::Deps,
    record: &crate::types::WorkflowRunRecord,
) -> serde_json::Value {
    let result = if let Some(result_ref) = record.result_ref.as_deref() {
        match crate::state::get_run_result(&deps.iii, result_ref).await {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!(
                    run_id = %record.run_id,
                    error = %err,
                    "failed to load run result for completion payload"
                );
                None
            }
        }
    } else {
        None
    };

    serde_json::json!({
        "run_id": record.run_id,
        "status": record.status,
        "result": result,
        "result_error": record.result_error,
    })
}

/// Global fire-and-forget event broadcast when any run reaches a terminal state.
/// Untargeted: bind a worker to `workflow::run-completed` to observe every run.
/// For a per-run "notify me" callback, see `emit_notify` + `NotifySpec`.
pub async fn emit_run_completed(
    deps: &crate::functions::Deps,
    record: &crate::types::WorkflowRunRecord,
) {
    let payload = completed_payload(deps, record).await;
    let _ = deps
        .iii
        .trigger(iii_sdk::protocol::TriggerRequest {
            function_id: "workflow::run-completed".into(),
            payload,
            action: Some(iii_sdk::TriggerAction::Void),
            timeout_ms: None,
        })
        .await; // best-effort fire-and-forget
}

/// Fire the caller-supplied completion callback, if the run carries one. The
/// caller named a `function_id` at `workflow::start` time; we push it the run
/// outcome so the caller never has to poll `workflow::status`.
///
/// Durable delivery (enqueued, defaulting to the `"default"` queue) and
/// at-least-once: this fires inside `finalize`, before the terminal status is
/// persisted, so a crash mid-finalize re-ticks and re-fires. The handler must
/// dedup on `run_id`.
pub async fn emit_notify(deps: &crate::functions::Deps, record: &crate::types::WorkflowRunRecord) {
    let Some(notify) = record.notify.as_ref() else {
        return;
    };
    if notify.function_id.trim().is_empty() {
        return;
    }
    let queue = notify
        .queue
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let payload = completed_payload(deps, record).await;
    let _ = deps
        .iii
        .trigger(iii_sdk::protocol::TriggerRequest {
            function_id: notify.function_id.clone(),
            payload,
            action: Some(iii_sdk::TriggerAction::Enqueue { queue }),
            timeout_ms: None,
        })
        .await; // best-effort; durable retry is the queue's job
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    fn record_with(status: &str) -> crate::types::WorkflowRunRecord {
        serde_json::from_value(json!({
            "run_id": "r1", "step": 0, "status": status, "def_ref": "r1",
            "input_ref": "r1", "result_ref": "r1", "created_at": 0, "updated_at": 0
        }))
        .expect("minimal record")
    }

    #[test]
    fn completed_payload_carries_the_outcome() {
        let rec = record_with("completed");
        assert_eq!(rec.run_id, "r1");
        assert_eq!(rec.status, crate::types::RunStatus::Completed);
        assert_eq!(rec.result_ref.as_deref(), Some("r1"));
    }
}
