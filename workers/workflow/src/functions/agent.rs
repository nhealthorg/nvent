//! Harness Agent Integration for nworkflow
//!
//! Provides orchestrator helpers and handlers for spawning/sending agent tasks via `harness`,
//! correlating harness events, bridging events to the `nworkflow` stream under `agents.*`,
//! and waking the tick when an agent task completes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

use crate::error::WorkflowError;
use crate::functions::{node_completed, stream_publish, Deps};
use crate::state;
use crate::types::{AgentInvocationSpec, AgentRuntimeOptions, AgentTaskRecord, AgentTaskStatus};

pub const AGENT_START_ID: &str = "nworkflow::agent-start";
pub const AGENT_SEND_ID: &str = "nworkflow::agent-send";
pub const AGENT_STATUS_ID: &str = "nworkflow::agent-status";
pub const AGENT_CANCEL_ID: &str = "nworkflow::agent-cancel";
pub const AGENT_EVENT_ID: &str = "nworkflow::agent-event";
pub const AGENT_MESSAGE_UPDATED_ID: &str = "nworkflow::agent-message-updated";
pub const AGENT_MESSAGE_ADDED_ID: &str = "nworkflow::agent-message-added";

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentStartRequest {
    pub run_id: String,
    pub node_uid: String,
    pub spec: AgentInvocationSpec,
    #[serde(default)]
    pub options: Option<AgentRuntimeOptions>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AgentStartResponse {
    pub task_id: String,
    pub agent_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub status: AgentTaskStatus,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentSendRequest {
    pub run_id: String,
    pub task_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentStatusRequest {
    pub run_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentCancelRequest {
    pub run_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentEventPayload {
    pub session_id: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub output: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentMessageUpdatedPayload {
    pub session_id: String,
    pub entry_id: String,
    pub message: Value,
    pub revision: u64,
    #[serde(default)]
    pub origin: Option<Value>,
    #[serde(default)]
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentMessageAddedPayload {
    pub session_id: String,
    pub entry_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub message: Value,
    #[serde(default)]
    pub origin: Option<Value>,
    #[serde(default)]
    pub timestamp: Option<i64>,
}

fn spawn_payload(
    agent_profile: Option<&str>,
    model: Option<&str>,
    provider: Option<&str>,
    folder: Option<&str>,
    task: &str,
    options: Value,
    parent_session_id: &str,
) -> Value {
    let mut payload = json!({
        "task": task,
        "options": options,
        "parent_session_id": parent_session_id
    });

    if let (Some(agent_profile), Some(payload_obj)) = (agent_profile, payload.as_object_mut()) {
        if let Some(options_obj) = payload_obj
            .get_mut("options")
            .and_then(Value::as_object_mut)
        {
            options_obj.remove("system_prompt");
            options_obj.remove("system_prompt_strategy");
        }
        payload_obj.insert("agent".to_string(), json!(agent_profile));
    }

    if let (Some(model), Some(payload_obj)) = (model, payload.as_object_mut()) {
        payload_obj.insert("model".to_string(), json!(model));
    }
    if let (Some(provider), Some(payload_obj)) = (provider, payload.as_object_mut()) {
        payload_obj.insert("provider".to_string(), json!(provider));
    }
    if let (Some(folder), Some(payload_obj)) = (folder, payload.as_object_mut()) {
        payload_obj.insert("filesystem_root".to_string(), json!(folder));
    }

    payload
}

fn send_payload(
    session_id: &str,
    message: &str,
    model: Option<&str>,
    provider: Option<&str>,
    options: Value,
) -> Value {
    let mut payload = json!({
        "session_id": session_id,
        "message": message,
        "options": options,
    });
    if let (Some(model), Some(payload_obj)) = (model, payload.as_object_mut()) {
        payload_obj.insert("model".to_string(), json!(model));
    }
    if let (Some(provider), Some(payload_obj)) = (provider, payload.as_object_mut()) {
        payload_obj.insert("provider".to_string(), json!(provider));
    }
    payload
}

fn spawn_ids(response: &Value) -> Result<(String, Option<String>), WorkflowError> {
    let session_id = response
        .get("child_session_id")
        .or_else(|| response.get("session_id"))
        .or_else(|| response.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            WorkflowError::Trigger(
                "harness::spawn returned success without child_session_id".to_string(),
            )
        })?;
    let turn_id = response
        .get("child_turn_id")
        .or_else(|| response.get("turn_id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);

    Ok((session_id, turn_id))
}

fn send_ids(
    response: &Value,
    expected_session_id: &str,
) -> Result<(String, Option<String>), WorkflowError> {
    let session_id = response
        .get("session_id")
        .or_else(|| response.get("child_session_id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .unwrap_or(expected_session_id)
        .to_owned();
    if session_id != expected_session_id {
        return Err(WorkflowError::Trigger(format!(
            "harness::send changed session from {expected_session_id} to {session_id}"
        )));
    }
    let turn_id = response
        .get("turn_id")
        .or_else(|| response.get("child_turn_id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);

    if turn_id.is_none() {
        return Err(WorkflowError::Trigger(
            "harness::send returned success without turn_id".to_string(),
        ));
    }

    Ok((session_id, turn_id))
}

fn task_node_uid(task: &AgentTaskRecord) -> &str {
    if task.node_uid.is_empty() {
        &task.task_id
    } else {
        &task.node_uid
    }
}

fn message_stream_enabled(task: &AgentTaskRecord) -> bool {
    task.message_stream_enabled.unwrap_or(true)
}

fn validate_folder(folder: Option<&str>, has_existing_session: bool) -> Result<(), WorkflowError> {
    let Some(folder) = folder else {
        return Ok(());
    };
    if !Path::new(folder).is_absolute() {
        return Err(WorkflowError::InvalidDef(
            "agent folder must be an absolute path visible to the harness worker".to_string(),
        ));
    }
    if has_existing_session {
        return Err(WorkflowError::InvalidDef(
            "agent folder can only be set on the first agent step of a workflow run".to_string(),
        ));
    }
    Ok(())
}

fn harness_identity(
    spec: &AgentInvocationSpec,
) -> (Option<String>, Option<String>, Option<String>) {
    match &spec.agent {
        Some(crate::types::AgentProfileSpec::Name(name)) => (Some(name.clone()), None, None),
        Some(crate::types::AgentProfileSpec::Full {
            profile,
            model,
            system_prompt,
            ..
        }) => (profile.clone(), model.clone(), system_prompt.clone()),
        None => (None, None, None),
    }
}

pub(crate) fn started_event(
    run_id: &str,
    node_uid: &str,
    task_id: &str,
    agent_session_id: &str,
) -> stream_publish::StreamPublishRequest {
    stream_publish::StreamPublishRequest {
        run_id: run_id.to_string(),
        stream: "agents.started".to_string(),
        data: json!({
            "task_id": task_id,
            "agent_session_id": agent_session_id,
            "node_uid": node_uid,
        }),
        node_uid: Some(node_uid.to_string()),
    }
}

pub(crate) fn failed_event(
    run_id: &str,
    node_uid: &str,
    error: &str,
) -> stream_publish::StreamPublishRequest {
    stream_publish::StreamPublishRequest {
        run_id: run_id.to_string(),
        stream: "agents.failed".to_string(),
        data: json!({
            "task_id": node_uid,
            "error": error,
        }),
        node_uid: Some(node_uid.to_string()),
    }
}

pub async fn handle_start(
    deps: &Deps,
    req: AgentStartRequest,
) -> Result<AgentStartResponse, WorkflowError> {
    let run_id = req.run_id.clone();
    let node_uid = req.node_uid.clone();

    match start_agent_task(deps, req).await {
        Ok(response) => {
            stream_publish::publish_best_effort(
                deps,
                vec![started_event(
                    &run_id,
                    &node_uid,
                    &response.task_id,
                    &response.agent_session_id,
                )],
            )
            .await;
            Ok(response)
        }
        Err(error) => {
            stream_publish::publish_best_effort(
                deps,
                vec![failed_event(&run_id, &node_uid, &error.to_string())],
            )
            .await;
            Err(error)
        }
    }
}

pub async fn start_agent_task(
    deps: &Deps,
    req: AgentStartRequest,
) -> Result<AgentStartResponse, WorkflowError> {
    let AgentStartRequest {
        run_id,
        node_uid,
        spec,
        options,
    } = req;

    let mut run_record = state::get_run(&deps.iii, &run_id)
        .await?
        .ok_or_else(|| WorkflowError::State(format!("run '{run_id}' not found")))?;

    let workflow_session_id = run_record
        .caller_session_id
        .clone()
        .unwrap_or_else(|| run_id.clone());

    let opts = options.unwrap_or(AgentRuntimeOptions {
        model: None,
        provider: None,
        folder: None,
        max_turns: None,
        timeout_ms: None,
        functions: None,
        skills: None,
        system_prompt: None,
        system_prompt_strategy: None,
        stream: None,
        result: None,
    });

    let (agent_profile, profile_model, profile_system_prompt) = harness_identity(&spec);

    let mut prompt_parts = Vec::new();
    if let Some(p) = &spec.prompt {
        prompt_parts.push(p.clone());
    } else if let Some(m) = &spec.message {
        prompt_parts.push(m.clone());
    }

    if let Some(input_v) = &spec.input {
        if !input_v.is_null() {
            if let Some(s) = input_v.as_str() {
                prompt_parts.push(format!("Input:\n{}", s));
            } else {
                let json_str =
                    serde_json::to_string_pretty(input_v).unwrap_or_else(|_| input_v.to_string());
                prompt_parts.push(format!("Input Data:\n```json\n{}\n```", json_str));
            }
        }
    }

    let prompt_msg = if prompt_parts.is_empty() {
        "Please process the task.".to_string()
    } else {
        prompt_parts.join("\n\n")
    };

    let model = opts.model.as_ref().or(profile_model.as_ref());
    let mut harness_options = json!({
        "stream": {
            "session_id": run_id,
            "name": "nworkflow"
        }
    });

    if let Some(opts_obj) = harness_options.as_object_mut() {
        if let Some(turns) = opts.max_turns {
            opts_obj.insert("max_turns".to_string(), json!(turns));
        }
        if let Some(funcs) = &opts.functions {
            opts_obj.insert("functions".to_string(), json!(funcs));
        }
        if let Some(skills) = &opts.skills {
            opts_obj.insert("skills".to_string(), json!(skills));
        }
        let system_prompt = opts
            .system_prompt
            .as_ref()
            .or(profile_system_prompt.as_ref());
        if agent_profile.is_none() {
            if let Some(system_prompt) = system_prompt {
                opts_obj.insert("system_prompt".to_string(), json!(system_prompt));
            }
            if let Some(strategy) = &opts.system_prompt_strategy {
                opts_obj.insert("system_prompt_strategy".to_string(), json!(strategy));
            }
        } else if system_prompt.is_some() {
            tracing::warn!(
                run_id = %run_id,
                node_uid = %node_uid,
                agent = ?agent_profile,
                "ignoring custom system prompt because the harness agent profile supplies the child identity"
            );
        }
    }

    let existing_session_id = run_record.agent_session_id.clone();
    validate_folder(opts.folder.as_deref(), existing_session_id.is_some())?;
    let (function_id, harness_payload) = if let Some(session_id) = existing_session_id.as_deref() {
        if let (Some(agent_profile), Some(options_obj)) =
            (agent_profile.as_deref(), harness_options.as_object_mut())
        {
            options_obj.insert("agent".to_string(), json!(agent_profile));
        }
        (
            "harness::send",
            send_payload(
                session_id,
                &prompt_msg,
                model.map(String::as_str),
                opts.provider.as_deref(),
                harness_options,
            ),
        )
    } else {
        (
            "harness::spawn",
            spawn_payload(
                agent_profile.as_deref(),
                model.map(String::as_str),
                opts.provider.as_deref(),
                opts.folder.as_deref(),
                &prompt_msg,
                harness_options,
                &workflow_session_id,
            ),
        )
    };

    tracing::info!(
        run_id = %run_id,
        node_uid = %node_uid,
        function_id,
        session_id = ?existing_session_id,
        "starting harness agent turn"
    );

    let dispatch_timeout_ms = opts
        .timeout_ms
        .unwrap_or(deps.cfg().await.dispatch_timeout_ms);
    let harness_res = deps
        .trigger_bounded(
            iii_sdk::protocol::TriggerRequest {
                function_id: function_id.to_string(),
                payload: harness_payload,
                action: None,
                timeout_ms: None,
            },
            dispatch_timeout_ms,
        )
        .await;

    let (agent_session_id, turn_id) = match harness_res {
        Ok(res) => match existing_session_id.as_deref() {
            Some(session_id) => send_ids(&res, session_id)?,
            None => spawn_ids(&res)?,
        },
        Err(e) => {
            let err_msg = format!("{function_id} failed: {e}");
            tracing::error!(run_id = %run_id, node_uid = %node_uid, error = %err_msg);
            return Err(WorkflowError::Trigger(err_msg));
        }
    };

    if run_record.agent_session_id.is_none() {
        run_record.agent_session_id = Some(agent_session_id.clone());
        run_record.updated_at = deps.now_ms();
        state::put_run(&deps.iii, &run_record).await?;
    }

    let task_id = format!("agt_{}", crate::ids::new_trace_id());
    let now = deps.now_ms();
    let message_stream_enabled = opts
        .stream
        .as_ref()
        .and_then(|stream| stream.enabled)
        .unwrap_or(true);

    let task_record = AgentTaskRecord {
        task_id: task_id.clone(),
        run_id: run_id.clone(),
        node_uid: node_uid.clone(),
        workflow_session_id,
        agent_session_id: agent_session_id.clone(),
        turn_id: turn_id.clone(),
        message_stream_enabled: Some(message_stream_enabled),
        parent_session_id: run_record.caller_session_id,
        status: AgentTaskStatus::Running,
        created_at: now,
        updated_at: now,
        output_ref: None,
        final_result: None,
        error: None,
        options_hash: format!("{:x}", crate::ids::now_ms()),
        stream_name: "nworkflow".to_string(),
        stream_scope_id: run_id.clone(),
    };

    state::put_agent_task(&task_record).await?;

    Ok(AgentStartResponse {
        task_id,
        agent_session_id,
        turn_id,
        status: AgentTaskStatus::Running,
    })
}

pub async fn handle_agent_event(
    deps: &Deps,
    mut payload: AgentEventPayload,
) -> Result<(), WorkflowError> {
    let Some(mut task) = state::get_agent_task_by_session(&payload.session_id).await? else {
        return Ok(());
    };

    if let (Some(expected), Some(actual)) = (task.turn_id.as_deref(), payload.turn_id.as_deref()) {
        if expected != actual {
            tracing::debug!(
                session_id = %payload.session_id,
                expected_turn_id = %expected,
                actual_turn_id = %actual,
                "ignoring stale harness event"
            );
            return Ok(());
        }
    }

    let status_timeout_ms = deps.cfg().await.dispatch_timeout_ms;
    if let Ok(status) = deps
        .trigger_bounded(
            iii_sdk::protocol::TriggerRequest {
                function_id: "harness::status".to_string(),
                payload: json!({
                    "session_id": payload.session_id,
                    "verbose": true,
                }),
                action: None,
                timeout_ms: None,
            },
            status_timeout_ms,
        )
        .await
    {
        payload.status = status
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or(payload.status);
        payload.turn_id = status
            .get("turn_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or(payload.turn_id);
        payload.result = status
            .get("result")
            .cloned()
            .or_else(|| status.get("output").cloned())
            .or(payload.result);
        payload.error = status
            .get("result_error")
            .or_else(|| status.get("error"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or(payload.error);
    }

    let now = deps.now_ms();
    let raw_event_type = payload.event_type.as_deref().unwrap_or("message");
    let mapped_stream_name = match raw_event_type {
        "started" | "turn-started" => "agents.started",
        "completed" | "turn-completed" => "agents.completed",
        "failed" => "agents.failed",
        "cancelled" => "agents.cancelled",
        "tool-call" | "tool_call" => "agents.tool-call",
        "tool-result" | "tool_result" => "agents.tool-result",
        "progress" => "agents.progress",
        _ => "agents.message",
    };

    let is_terminal = matches!(
        mapped_stream_name,
        "agents.completed" | "agents.failed" | "agents.cancelled"
    ) || payload.status.as_deref() == Some("completed")
        || payload.status.as_deref() == Some("failed")
        || payload.status.as_deref() == Some("cancelled");

    if is_terminal {
        let node_uid = task_node_uid(&task).to_string();
        if payload.status.as_deref() == Some("failed") || mapped_stream_name == "agents.failed" {
            task.status = AgentTaskStatus::Failed;
            task.error = payload
                .error
                .clone()
                .or_else(|| Some("agent task failed".to_string()));
        } else if payload.status.as_deref() == Some("cancelled")
            || mapped_stream_name == "agents.cancelled"
        {
            task.status = AgentTaskStatus::Cancelled;
        } else {
            task.status = AgentTaskStatus::Completed;
            task.final_result = payload.result.clone().or_else(|| payload.output.clone());
        }

        task.updated_at = now;
        state::put_agent_task(&task).await?;

        // Publish stream event
        let _ = stream_publish::handle(
            deps,
            stream_publish::StreamPublishRequest {
                run_id: task.run_id.clone(),
                stream: mapped_stream_name.to_string(),
                data: json!({
                    "task_id": task.task_id,
                    "node_uid": node_uid,
                    "agent_session_id": task.agent_session_id,
                    "status": task.status,
                    "result": task.final_result,
                    "error": task.error
                }),
                node_uid: Some(node_uid.clone()),
            },
        )
        .await;

        // Wake node completion
        let completion_event = node_completed::NodeCompletedEvent {
            run_id: task.run_id.clone(),
            node_uid,
            trace_id: None,
            function_id: Some("harness::spawn".to_string()),
            runtime: Some("agent".to_string()),
            result: task.final_result.clone(),
            result_error: task.error.clone(),
            attempt: None,
        };

        node_completed::handle(deps, completion_event).await?;
    } else {
        let node_uid = task_node_uid(&task).to_string();
        // Non-terminal event - update timestamp & publish event
        task.updated_at = now;
        state::put_agent_task(&task).await?;

        let _ = stream_publish::handle(
            deps,
            stream_publish::StreamPublishRequest {
                run_id: task.run_id.clone(),
                stream: mapped_stream_name.to_string(),
                data: payload.data.unwrap_or_else(|| {
                    json!({
                        "task_id": task.task_id,
                        "node_uid": node_uid,
                        "agent_session_id": task.agent_session_id,
                        "turn_id": payload.turn_id,
                        "output": payload.output,
                    })
                }),
                node_uid: Some(node_uid),
            },
        )
        .await;
    }

    Ok(())
}

pub async fn handle_agent_message_updated(
    deps: &Deps,
    payload: AgentMessageUpdatedPayload,
) -> Result<(), WorkflowError> {
    let Some(task) = state::get_agent_task_by_session(&payload.session_id).await? else {
        return Ok(());
    };
    if !message_stream_enabled(&task) {
        return Ok(());
    }

    let event_turn_id = payload
        .origin
        .as_ref()
        .and_then(|origin| origin.get("turn_id"))
        .and_then(Value::as_str);
    if let Some(expected_turn_id) = task.turn_id.as_deref() {
        if event_turn_id != Some(expected_turn_id) {
            tracing::debug!(
                session_id = %payload.session_id,
                entry_id = %payload.entry_id,
                expected_turn_id,
                event_turn_id = ?event_turn_id,
                "ignoring assistant revision from another harness turn"
            );
            return Ok(());
        }
    }

    let node_uid = task_node_uid(&task).to_string();
    stream_publish::handle(
        deps,
        stream_publish::StreamPublishRequest {
            run_id: task.run_id.clone(),
            stream: "agents.message.updated".to_string(),
            data: json!({
                "task_id": task.task_id,
                "node_uid": node_uid,
                "agent_session_id": task.agent_session_id,
                "turn_id": event_turn_id,
                "entry_id": payload.entry_id,
                "revision": payload.revision,
                "message": payload.message,
                "origin": payload.origin,
                "timestamp": payload.timestamp,
            }),
            node_uid: Some(node_uid),
        },
    )
    .await
}

pub async fn handle_agent_message_added(
    deps: &Deps,
    payload: AgentMessageAddedPayload,
) -> Result<(), WorkflowError> {
    let Some(task) = state::get_agent_task_by_session(&payload.session_id).await? else {
        return Ok(());
    };
    if !message_stream_enabled(&task) {
        return Ok(());
    }

    let event_turn_id = payload
        .origin
        .as_ref()
        .and_then(|origin| origin.get("turn_id"))
        .and_then(Value::as_str);
    if let Some(expected_turn_id) = task.turn_id.as_deref() {
        if event_turn_id != Some(expected_turn_id) {
            return Ok(());
        }
    }

    let node_uid = task_node_uid(&task).to_string();
    stream_publish::handle(
        deps,
        stream_publish::StreamPublishRequest {
            run_id: task.run_id.clone(),
            stream: "agents.message.added".to_string(),
            data: json!({
                "task_id": task.task_id,
                "node_uid": node_uid,
                "agent_session_id": task.agent_session_id,
                "turn_id": event_turn_id,
                "entry_id": payload.entry_id,
                "parent_id": payload.parent_id,
                "message": payload.message,
                "origin": payload.origin,
                "timestamp": payload.timestamp,
            }),
            node_uid: Some(node_uid),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use crate::types::AgentInvocationSpec;
    use serde_json::json;

    #[test]
    fn spawn_ids_reads_harness_child_ids() {
        let (session_id, turn_id) = super::spawn_ids(&json!({
            "child_session_id": "s_child",
            "child_turn_id": "t_child"
        }))
        .expect("valid spawn response");

        assert_eq!(session_id, "s_child");
        assert_eq!(turn_id.as_deref(), Some("t_child"));
    }

    #[test]
    fn spawn_ids_rejects_malformed_success() {
        let error = super::spawn_ids(&json!({ "child_turn_id": "t_child" }))
            .expect_err("missing session id must fail");

        assert!(error.to_string().contains("child_session_id"));
    }

    #[test]
    fn send_ids_requires_turn_id_and_reuses_session() {
        let (session_id, turn_id) = super::send_ids(&json!({ "turn_id": "t_next" }), "s_shared")
            .expect("valid send response");

        assert_eq!(session_id, "s_shared");
        assert_eq!(turn_id.as_deref(), Some("t_next"));
        assert!(super::send_ids(&json!({}), "s_shared").is_err());
    }

    #[test]
    fn session_message_update_parses_thinking_blocks() {
        let payload: super::AgentMessageUpdatedPayload = serde_json::from_value(json!({
            "session_id": "s_agent",
            "entry_id": "e_assistant",
            "revision": 3,
            "origin": { "turn_id": "t_agent" },
            "timestamp": 123,
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "thinking", "text": "Checking the input" },
                    { "type": "text", "text": "Partial answer" },
                    {
                        "type": "function_call",
                        "id": "call_1",
                        "function_id": "lookup",
                        "arguments": { "id": 42 }
                    }
                ]
            }
        }))
        .expect("valid session message update");

        assert_eq!(payload.revision, 3);
        assert_eq!(payload.message["content"][0]["type"], "thinking");
        assert_eq!(payload.message["content"][2]["type"], "function_call");
    }

    #[test]
    fn existing_agent_tasks_keep_message_streaming_enabled() {
        let mut task: crate::types::AgentTaskRecord = serde_json::from_value(json!({
            "task_id": "task-1",
            "run_id": "run-1",
            "workflow_session_id": "run-1",
            "agent_session_id": "s_agent",
            "status": "running",
            "created_at": 1,
            "updated_at": 1,
            "options_hash": "hash",
            "stream_name": "nworkflow",
            "stream_scope_id": "run-1"
        }))
        .expect("legacy task record");

        assert!(super::message_stream_enabled(&task));
        task.message_stream_enabled = Some(false);
        assert!(!super::message_stream_enabled(&task));
    }

    #[test]
    fn harness_spawn_payload_uses_required_task_field() {
        let payload = super::spawn_payload(
            Some("analyst"),
            Some("test-model"),
            Some("test-provider"),
            Some("/workspace/project"),
            "Analyze this report",
            json!({}),
            "workflow-session",
        );

        assert_eq!(payload["task"], "Analyze this report");
        assert!(payload.get("message").is_none());
        assert_eq!(payload["agent"], "analyst");
        assert_eq!(payload["model"], "test-model");
        assert_eq!(payload["provider"], "test-provider");
        assert_eq!(payload["filesystem_root"], "/workspace/project");
        assert_eq!(payload["parent_session_id"], "workflow-session");
    }

    #[test]
    fn harness_spawn_payload_omits_agent_for_ad_hoc_identity() {
        let payload = super::spawn_payload(
            None,
            Some("test-model"),
            None,
            None,
            "Analyze this report",
            json!({ "system_prompt": "You are an analyst." }),
            "workflow-session",
        );

        assert!(payload.get("agent").is_none());
        assert_eq!(payload["model"], "test-model");
        assert_eq!(payload["options"]["system_prompt"], "You are an analyst.");
    }

    #[test]
    fn harness_spawn_payload_never_combines_agent_and_system_prompt() {
        let payload = super::spawn_payload(
            Some("analyst"),
            Some("test-model"),
            None,
            None,
            "Analyze this report",
            json!({
                "system_prompt": "Conflicting identity",
                "system_prompt_strategy": "override"
            }),
            "workflow-session",
        );

        assert_eq!(payload["agent"], "analyst");
        assert!(payload["options"].get("system_prompt").is_none());
        assert!(payload["options"].get("system_prompt_strategy").is_none());
    }

    #[test]
    fn harness_send_payload_uses_top_level_provider() {
        let payload = super::send_payload(
            "agent-session",
            "Continue",
            Some("test-model"),
            Some("test-provider"),
            json!({ "max_turns": 4 }),
        );

        assert_eq!(payload["session_id"], "agent-session");
        assert_eq!(payload["model"], "test-model");
        assert_eq!(payload["provider"], "test-provider");
        assert!(payload["options"].get("provider").is_none());
    }

    #[test]
    fn agent_folder_must_be_absolute_and_set_before_session_creation() {
        assert!(super::validate_folder(Some("relative/project"), false).is_err());
        assert!(super::validate_folder(Some("/workspace/project"), true).is_err());
        assert!(super::validate_folder(Some("/workspace/project"), false).is_ok());
        assert!(super::validate_folder(None, true).is_ok());
    }

    #[test]
    fn ui_agent_id_is_not_a_harness_profile() {
        let spec: AgentInvocationSpec = serde_json::from_value(json!({
            "agent": {
                "id": "analyst",
                "display": { "name": "Insight Analyst" }
            }
        }))
        .expect("valid agent spec");

        let (agent_profile, _, _) = super::harness_identity(&spec);
        assert!(agent_profile.is_none());
    }

    #[test]
    fn explicit_profile_is_used_as_harness_agent() {
        let spec: AgentInvocationSpec = serde_json::from_value(json!({
            "agent": {
                "id": "analyst-node",
                "profile": "analyst-profile"
            }
        }))
        .expect("valid agent spec");

        let (agent_profile, _, _) = super::harness_identity(&spec);
        assert_eq!(agent_profile.as_deref(), Some("analyst-profile"));
    }

    #[test]
    fn started_event_contains_agent_correlation() {
        let event = super::started_event("run-1", "agent-node", "task-1", "session-1");

        assert_eq!(event.run_id, "run-1");
        assert_eq!(event.stream, "agents.started");
        assert_eq!(event.node_uid.as_deref(), Some("agent-node"));
        assert_eq!(event.data["task_id"], "task-1");
        assert_eq!(event.data["agent_session_id"], "session-1");
    }

    #[test]
    fn failed_event_contains_start_error() {
        let event = super::failed_event("run-1", "agent-node", "spawn rejected");

        assert_eq!(event.run_id, "run-1");
        assert_eq!(event.stream, "agents.failed");
        assert_eq!(event.node_uid.as_deref(), Some("agent-node"));
        assert_eq!(event.data["task_id"], "agent-node");
        assert_eq!(event.data["error"], "spawn rejected");
    }
}
