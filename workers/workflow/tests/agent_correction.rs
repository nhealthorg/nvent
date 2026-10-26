use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use iii_sdk::{register_worker, InitOptions};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use workflow::{
    config::WorkerConfig,
    functions::{
        agent,
        tick::{decide, TickDecision},
        Deps,
    },
    internal_state::{
        file::FileWorkflowInternalStateStore, AgentPermit, WorkflowInternalStateStore,
    },
    locks::WorkflowLocks,
    state,
    types::{
        AgentTaskRecord, AgentTaskStatus, NodeState, RunStatus, WorkflowDef, WorkflowRunRecord,
    },
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_json_correction_send_rejected_is_terminal() {
    let directory = std::env::temp_dir().join(format!("nvent-correction-{}", uuid::Uuid::new_v4()));
    let config = WorkerConfig {
        internal_state_file_dir: directory.to_string_lossy().into_owned(),
        dispatch_timeout_ms: 2_000,
        max_node_retries: 0,
        ..WorkerConfig::default()
    };
    let store = Arc::new(FileWorkflowInternalStateStore::new(&config));
    state::set_internal_state_store(store.clone());
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let recorded = calls.clone();
    let peer = tokio::spawn(async move {
        let (connection, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(connection).await.unwrap();
        while let Some(Ok(message)) = socket.next().await {
            let Message::Text(text) = message else {
                continue;
            };
            let request: Value = serde_json::from_str(&text).unwrap();
            if request["type"] != "invokefunction" {
                continue;
            }
            recorded.lock().unwrap().push(request.clone());
            let mut reply = json!({
                "type": "invocationresult",
                "invocation_id": request["invocation_id"],
                "function_id": request["function_id"],
                "result": {}
            });
            match request["function_id"].as_str().unwrap() {
                "engine::workers::register" => {
                    reply["result"] = json!({ "worker_id": "correction-test" })
                }
                "engine::functions::list" => reply["result"] = json!({ "functions": [] }),
                "harness::status" => {
                    reply["result"] = json!({
                        "status": "completed", "turn_id": "original-turn", "result": "not-json"
                    })
                }
                "harness::send" => {
                    reply.as_object_mut().unwrap().remove("result");
                    reply["error"] = json!({
                        "code": "REJECTED", "message": "corrective send rejected"
                    });
                }
                "stream::set" | "nworkflow::tick" => {}
                function => panic!("unexpected RPC: {function}"),
            }
            socket
                .send(Message::Text(reply.to_string().into()))
                .await
                .unwrap();
        }
    });
    let client = Arc::new(register_worker(
        &format!("ws://{address}"),
        InitOptions::default(),
    ));
    let discovery =
        tokio::time::timeout(Duration::from_secs(5), workflow::discovery::init(&client))
            .await
            .unwrap();
    let deps = Deps {
        iii: client.clone(),
        cfg: Arc::new(tokio::sync::RwLock::new(Arc::new(config))),
        locks: WorkflowLocks::default(),
        discovery,
        internal_state: store.clone(),
    };

    for grouped in [false, true] {
        for return_error in [false, true] {
            let run_id = format!("correction-{grouped}-{return_error}");
            let session_id = format!("session-{run_id}");
            let mut options = json!({ "model": "test-model", "provider": "test-provider" });
            if return_error {
                options["onError"] = json!("return-error");
            }
            if grouped {
                options["concurrencyGroup"] = json!({ "key": run_id, "limit": 1 });
            }
            let definition: WorkflowDef = serde_json::from_value(json!({
                "version": 1,
                "nodes": {
                    "agent": {
                        "agent": { "prompt": "Return JSON" },
                        "agentOptions": options,
                        "input": { "from": "run_input" }
                    },
                    "successor": {
                        "function": { "id": "test::successor" },
                        "input": { "from": "node:agent" },
                        "depends_on": ["agent"]
                    }
                },
                "output": { "from": "node:successor" }
            }))
            .unwrap();
            let run: WorkflowRunRecord = serde_json::from_value(json!({
                "run_id": run_id, "step": 0, "status": "running",
                "def_ref": run_id, "input_ref": run_id,
                "created_at": 1, "updated_at": 1,
                "nodes": { "agent": {
                    "state": "running", "session_id": session_id,
                    "turn_id": "original-turn", "pending_at": 1, "retries": 0
                }}
            }))
            .unwrap();
            state::put_def(&client, &run_id, &definition).await.unwrap();
            state::put_run(&client, &run).await.unwrap();
            let task: AgentTaskRecord = serde_json::from_value(json!({
                "task_id": run_id, "run_id": run_id, "node_uid": "agent",
                "workflow_session_id": run_id, "agent_session_id": session_id,
                "turn_id": "original-turn", "status": "running",
                "created_at": 1, "updated_at": 1, "options_hash": "test",
                "stream_name": "nworkflow", "stream_scope_id": run_id,
                "response": { "format": "json", "onInvalid": "retry", "maxAttempts": 2 }
            }))
            .unwrap();
            state::put_agent_task(&task).await.unwrap();
            if grouped {
                assert!(store
                    .acquire_agent_permit(&AgentPermit {
                        owner: run_id.clone(),
                        key: run_id.clone(),
                        limit: 1,
                        run_id: run_id.clone(),
                        node_uid: "agent".into(),
                        attempt: 0,
                        session_id: Some(session_id.clone()),
                        turn_id: Some("original-turn".into()),
                        dispatch_uncertain: false,
                        event_claimed: false,
                    })
                    .await
                    .unwrap());
            }
            let event: agent::AgentEventPayload = serde_json::from_value(json!({
                "session_id": session_id, "turn_id": "original-turn",
                "event_type": "completed", "result": "not-json"
            }))
            .unwrap();
            tokio::time::timeout(
                Duration::from_secs(5),
                agent::handle_agent_event(&deps, event.clone()),
            )
            .await
            .unwrap()
            .unwrap();

            let failed = state::get_agent_task(&run_id).await.unwrap().unwrap();
            assert_eq!(failed.status, AgentTaskStatus::Failed, "{run_id}");
            assert_eq!(failed.response_attempts, 1);
            assert!(failed.updated_at > task.updated_at);
            let error = failed.error.as_deref().unwrap();
            assert!(
                error.contains("harness::send validation retry failed"),
                "{error}"
            );
            assert!(error.contains("corrective send rejected"), "{error}");
            assert!(failed.final_result.is_none());
            let mut run = state::get_run(&client, &run_id).await.unwrap().unwrap();
            assert!(run.nodes["agent"].session_id.is_none());
            assert!(run.nodes["agent"].turn_id.is_none());
            let result = state::get_node_result_memory(&run_id, "agent")
                .unwrap()
                .unwrap();
            if return_error {
                assert_eq!(result, json!({ "status": "failed", "error": error }));
            } else {
                assert_eq!(result, json!({ "__workflow_error__": error }));
            }
            workflow::reconcile::reconcile_run(&deps, &definition, &mut run)
                .await
                .unwrap();
            workflow::reconcile::reconcile_function_nodes(
                &deps,
                &definition,
                &mut run,
                &mut Vec::new(),
            )
            .await
            .unwrap();
            if return_error {
                assert_eq!(run.nodes["agent"].state, NodeState::Done);
                assert!(
                    matches!(decide(&definition, &run), TickDecision::Fire(nodes)
                    if nodes == ["successor"])
                );
                let results = BTreeMap::from([("agent".to_string(), result.clone())]);
                assert_eq!(
                    workflow::dag::gather_input(
                        &definition,
                        &run,
                        &Value::Null,
                        "successor",
                        &results
                    ),
                    result
                );
            } else {
                assert_eq!(run.nodes["agent"].state, NodeState::Failed);
                assert!(matches!(
                    decide(&definition, &run),
                    TickDecision::Finalize(RunStatus::Failed)
                ));
                assert!(!run.nodes.contains_key("successor"));
            }
            let permits = store.list_agent_permits().await.unwrap();
            let permit = permits.iter().find(|permit| permit.run_id == run_id);
            if grouped {
                let permit = permit.unwrap();
                assert!(permit.dispatch_uncertain);
                assert!(!permit.event_claimed);
                assert_eq!(permit.session_id.as_deref(), Some(session_id.as_str()));
                assert_eq!(permit.turn_id.as_deref(), Some("original-turn"));
                let mut competing = permit.clone();
                competing.owner = format!("competitor-{run_id}");
                assert!(!store.acquire_agent_permit(&competing).await.unwrap());
            } else {
                assert!(permit.is_none());
            }
            agent::handle_agent_event(&deps, event).await.unwrap();
            let requests = calls.lock().unwrap();
            let sends: Vec<_> = requests
                .iter()
                .filter(|request| {
                    request["function_id"] == "harness::send"
                        && request["data"]["session_id"] == session_id
                })
                .collect();
            assert_eq!(sends.len(), 1);
            assert!(sends[0]["data"].get("model").is_none());
            assert!(sends[0]["data"].get("provider").is_none());
            let events: Vec<_> = requests
                .iter()
                .filter(|request| {
                    request["function_id"] == "stream::set" && request["data"]["group_id"] == run_id
                })
                .collect();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["data"]["data"]["type"], "agents.failed");
            assert_eq!(events[0]["data"]["data"]["data"]["status"], "failed");
            assert_eq!(events[0]["data"]["data"]["data"]["error"], error);
            assert!(requests
                .iter()
                .any(|request| request["function_id"] == "nworkflow::tick"
                    && request["data"]["run_id"] == run_id));
        }
    }
    client.shutdown_async().await;
    peer.abort();
    std::fs::remove_dir_all(directory).unwrap();
}
