/// Logical end-to-end test over the pure orchestration seams.
///
/// No live engine. No III mock. Drives `dag::*`, `tick::decide`, and
/// `reconcile::classify_terminal` directly over an in-memory
/// `WorkflowRunRecord` + `BTreeMap<String, Value>` results map, simulating
/// the tick loop.
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use serde_json::{json, Value};
use workflow::{
    dag,
    functions::tick::{decide, TickDecision},
    reconcile::{classify_terminal, NodeOutcome},
    types::{
        ChildWorkflowSpec, FanoutMode, FanoutSpec, FunctionSpec, InputSpec, NodeCheckpoint,
        NodeDef, NodeInputReturnType, NodeState, OutputRef, RunStatus, WorkflowDef,
        WorkflowRunRecord,
    },
};

fn function_node(
    id: &str,
    input: InputSpec,
    depends_on: Vec<String>,
    fanout: Option<FanoutSpec>,
) -> NodeDef {
    NodeDef {
        label: None,
        function: Some(FunctionSpec {
            id: id.to_string(),
            timeout_ms: None,
            queue: None,
            engine_retry: None,
            runtime: None,
        }),
        agent: None,
        agent_options: None,
        child_workflow: None,
        reduce: None,
        reduce_body: None,
        if_spec: None,
        if_branch: None,
        input,
        depends_on,
        fanout,
        result: None,
        input_policy: None,
    }
}

// ---------------------------------------------------------------------------
// 3-node definition used across all tests
// ---------------------------------------------------------------------------

fn three_node_def() -> WorkflowDef {
    let mut nodes = BTreeMap::new();

    nodes.insert(
        "plan".to_string(),
        function_node(
            "plan-fn",
            InputSpec {
                from: "run_input".into(),
                template: Some("List the docs to read for: {{topic}}".to_string()),
                value: None,
            },
            vec![],
            None,
        ),
    );

    nodes.insert(
        "read".to_string(),
        function_node(
            "read-fn",
            InputSpec {
                from: "fanout_item".into(),
                template: Some("Read and summarize: {{item}}".to_string()),
                value: None,
            },
            vec!["plan".to_string()],
            Some(FanoutSpec {
                over: "node:plan.result.docs".to_string(),
                mode: None,
                batch_size: None,
                item_return_type: None,
            }),
        ),
    );

    nodes.insert(
        "synthesize".to_string(),
        function_node(
            "synthesize-fn",
            InputSpec {
                from: "node:read".into(),
                template: Some("Synthesize from: {{results}}".to_string()),
                value: None,
            },
            vec!["read".to_string()],
            None,
        ),
    );

    WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:synthesize".into(),
        },
        default_functions: None,
        metadata: None,
    }
}

fn two_node_linear_def() -> WorkflowDef {
    let mut nodes = BTreeMap::new();

    nodes.insert(
        "first".to_string(),
        function_node(
            "first-fn",
            InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            },
            vec![],
            None,
        ),
    );

    nodes.insert(
        "second".to_string(),
        function_node(
            "second-fn",
            InputSpec {
                from: "node:first".into(),
                template: None,
                value: None,
            },
            vec!["first".to_string()],
            None,
        ),
    );

    WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:second".into(),
        },
        default_functions: None,
        metadata: None,
    }
}

// ---------------------------------------------------------------------------
// In-memory driver helpers
// ---------------------------------------------------------------------------

/// Create a fresh `WorkflowRunRecord` with no nodes/fanout_src.
fn new_record(def_input: Value) -> WorkflowRunRecord {
    WorkflowRunRecord {
        run_id: "run_test".to_string(),
        workflow_name: None,
        workflow_trace_id: Some("trace_test".to_string()),
        state_scope_id: Some("run_test".to_string()),
        stream_scope_id: Some("run_test".to_string()),
        agent_session_id: None,
        step: 0,
        status: RunStatus::Running,
        abort: false,
        def_ref: "run_test".to_string(),
        input_ref: format!("run_test_input_{}", def_input.to_string().len()),
        vars_ref: Some("run_test".to_string()),
        state_keys_map: BTreeMap::new(),
        stream_ids: Vec::new(),
        queue_receipts: Vec::new(),
        nodes: BTreeMap::new(),
        fanout_src: BTreeMap::new(),
        fanout_active: BTreeMap::new(),
        skipped_nodes: BTreeSet::new(),
        reduce_checkpoints: BTreeMap::new(),
        if_checkpoints: BTreeMap::new(),
        result_ref: None,
        result_error: None,
        notify: None,
        caller_session_id: None,
        parent_run_id: None,
        parent_node_uid: None,
        root_run_id: None,
        root_stream_scope_id: None,
        created_at: 0,
        updated_at: 0,
    }
}

/// Run one tick step (expand fanouts + decide).
///
/// If the decision is `Fire(uids)`, mark each uid as Running with synthetic
/// session/turn ids so the record advances correctly.
fn drive_step(
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
    results: &BTreeMap<String, Value>,
) -> TickDecision {
    dag::expand_ready_fanouts(def, record, results);
    dag::materialize_ready_batch_items(def, record);
    for (node_id, node) in &def.nodes {
        if node
            .fanout
            .as_ref()
            .is_some_and(|fanout| fanout.mode == Some(FanoutMode::Batch))
        {
            dag::compact_completed_batch_checkpoints(def, record, node_id);
        }
    }
    let decision = decide(def, record);
    if let TickDecision::Fire(ref uids) = decision {
        for uid in uids {
            record.nodes.insert(
                uid.clone(),
                NodeCheckpoint {
                    state: NodeState::Running,
                    session_id: Some(format!("wf_run_test_{}", uid)),
                    turn_id: Some(format!("turn_{}", uid)),
                    result_ref: None,
                    result_error: None,
                    child_run_id: None,
                    pending_at: Some(1_000_000),
                    pending_timeout_ms: None,
                    retries: 0,
                    completed_at: None,
                    worker_name: None,
                },
            );
        }
    }
    decision
}

fn drive_child_batch_step(
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
    results: &BTreeMap<String, Value>,
) -> (TickDecision, Vec<String>) {
    dag::expand_ready_fanouts(def, record, results);
    dag::materialize_ready_batch_items(def, record);
    let mut detached_result_uids = Vec::new();
    for (node_id, node) in &def.nodes {
        if node
            .fanout
            .as_ref()
            .is_some_and(|fanout| fanout.mode == Some(FanoutMode::Batch))
        {
            detached_result_uids.extend(dag::compact_completed_batch_checkpoints(
                def, record, node_id,
            ));
        }
    }
    detached_result_uids.sort();
    detached_result_uids.dedup();

    let decision = decide(def, record);
    if let TickDecision::Fire(ref uids) = decision {
        for uid in uids {
            record.nodes.insert(
                uid.clone(),
                NodeCheckpoint {
                    state: NodeState::Running,
                    session_id: None,
                    turn_id: None,
                    result_ref: None,
                    result_error: None,
                    child_run_id: Some(format!("child_run_{}", uid)),
                    pending_at: Some(1_000_000),
                    pending_timeout_ms: None,
                    retries: 0,
                    completed_at: None,
                    worker_name: None,
                },
            );
        }
    }
    (decision, detached_result_uids)
}

/// Mark a node checkpoint as Done and store its result in the results map.
/// Simulates a successful node completion (as reconcile would do).
fn complete(
    record: &mut WorkflowRunRecord,
    results: &mut BTreeMap<String, Value>,
    node_uid_str: &str,
    result_value: Value,
) {
    if let Some(cp) = record.nodes.get_mut(node_uid_str) {
        cp.state = NodeState::Done;
        cp.result_ref = Some(format!("run_test/{}", node_uid_str));
    }
    results.insert(node_uid_str.to_string(), result_value);
}

/// Mark a node checkpoint as Failed using `classify_terminal` with a result_error.
///
/// Asserts that `classify_terminal` returns `NodeOutcome::Failed`, then applies
/// the failure to the checkpoint.
fn complete_with_error(record: &mut WorkflowRunRecord, node_uid_str: &str, error: &str) {
    // classify_terminal("completed", garbage_value, error) → must be Failed
    let outcome = classify_terminal(
        "completed",
        Some(json!({"unexpected": "garbage"})),
        Some(error.to_string()),
    );
    assert!(
        matches!(outcome, NodeOutcome::Failed(_)),
        "classify_terminal should return Failed when result_error is set"
    );

    if let Some(cp) = record.nodes.get_mut(node_uid_str) {
        cp.state = NodeState::Failed;
        cp.result_error = Some(error.to_string());
    }
}

/// Mirrors the runtime invariant from state::load_done_results:
/// a Done checkpoint with missing stored payload must fail deterministically.
fn mark_missing_done_payloads_as_failed(
    record: &mut WorkflowRunRecord,
    results: &BTreeMap<String, Value>,
) {
    let missing: Vec<String> = record
        .nodes
        .iter()
        .filter(|(uid, cp)| {
            cp.state == NodeState::Done
                && cp.result_ref.is_some()
                && !results.contains_key(uid.as_str())
        })
        .map(|(uid, _)| uid.clone())
        .collect();

    for uid in missing {
        if let Some(cp) = record.nodes.get_mut(&uid) {
            cp.state = NodeState::Failed;
            cp.result_ref = None;
            cp.result_error = Some(
                "Done checkpoint has a result_ref but the stored result is missing (state corruption)"
                    .to_string(),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Test 1: fanout_barrier_synthesize_completes_in_order
// ---------------------------------------------------------------------------

#[test]
fn fanout_barrier_synthesize_completes_in_order() {
    let def = three_node_def();
    let mut record = new_record(json!({"topic": "rust"}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    // Step 1: fresh record → should Fire(["plan"])
    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["plan".to_string()], "step 1 must fire plan");
        }
        other => panic!("expected Fire([plan]) at step 1, got {:?}", other),
    }

    // Complete plan with 2 docs.
    complete(
        &mut record,
        &mut results,
        "plan",
        json!({"docs": ["a", "b"]}),
    );

    // Step 2: expand fanout + fire read#0, read#1
    let step2 = drive_step(&def, &mut record, &results);
    let fired_uids = match &step2 {
        TickDecision::Fire(uids) => uids.clone(),
        other => panic!("expected Fire([read#0, read#1]) at step 2, got {:?}", other),
    };
    assert!(
        fired_uids.contains(&"read#0".to_string()),
        "read#0 should be fired"
    );
    assert!(
        fired_uids.contains(&"read#1".to_string()),
        "read#1 should be fired"
    );
    assert_eq!(fired_uids.len(), 2, "exactly 2 read items should fire");

    // Complete out of order: read#1 first, then read#0.
    complete(&mut record, &mut results, "read#1", json!({"summary": "B"}));
    complete(&mut record, &mut results, "read#0", json!({"summary": "A"}));

    // Assert gather_input returns results in NUMERIC order (read#0 first, then read#1),
    // NOT in completion order (which was read#1, read#0).
    let gathered = dag::gather_input(
        &def,
        &record,
        &json!({"topic": "rust"}),
        "synthesize",
        &results,
    );
    let arr = gathered
        .as_array()
        .expect("gather_input must return an array");
    assert_eq!(arr.len(), 2, "gather_input must have 2 elements");
    assert_eq!(
        arr[0],
        json!({"summary": "A"}),
        "element 0 must be read#0's result (summary A), not B (completion order)"
    );
    assert_eq!(
        arr[1],
        json!({"summary": "B"}),
        "element 1 must be read#1's result (summary B)"
    );

    // Step 3: all read#i done → expand synthesize, fire it
    let step3 = drive_step(&def, &mut record, &results);
    match &step3 {
        TickDecision::Fire(uids) => {
            assert_eq!(
                uids,
                &vec!["synthesize".to_string()],
                "step 3 must fire synthesize"
            );
        }
        other => panic!("expected Fire([synthesize]) at step 3, got {:?}", other),
    }

    // Complete synthesize.
    complete(
        &mut record,
        &mut results,
        "synthesize",
        json!({"report": "done"}),
    );

    // Final quiescence: must be Completed.
    let q = dag::quiescence(&def, &record);
    assert_eq!(
        q,
        RunStatus::Completed,
        "run must be Completed after synthesize done"
    );
}

#[test]
fn batch_child_workflow_materializes_final_progress_item() {
    let mut nodes = BTreeMap::new();
    nodes.insert(
        "children".to_string(),
        NodeDef {
            child_workflow: Some(ChildWorkflowSpec {
                workflow: "child-workflow".to_string(),
            }),
            fanout: Some(FanoutSpec {
                over: "node:source.items".to_string(),
                mode: Some(FanoutMode::Batch),
                batch_size: Some(50),
                item_return_type: Some(NodeInputReturnType::Store),
            }),
            input: InputSpec {
                from: "fanout_item".into(),
                template: None,
                value: None,
            },
            depends_on: vec!["source".to_string()],
            label: None,
            function: None,
            agent: None,
            agent_options: None,
            reduce: None,
            reduce_body: None,
            if_spec: None,
            if_branch: None,
            result: None,
            input_policy: None,
        },
    );
    nodes.insert(
        "progress".to_string(),
        NodeDef {
            child_workflow: None,
            fanout: Some(FanoutSpec {
                over: "node:source.items".to_string(),
                mode: Some(FanoutMode::Batch),
                batch_size: Some(50),
                item_return_type: Some(NodeInputReturnType::Memory),
            }),
            input: InputSpec {
                from: "fanout_item".into(),
                template: None,
                value: None,
            },
            depends_on: vec!["children".to_string()],
            label: None,
            function: Some(FunctionSpec {
                id: "publish-progress".to_string(),
                timeout_ms: None,
                queue: None,
                engine_retry: None,
                runtime: None,
            }),
            agent: None,
            agent_options: None,
            reduce: None,
            reduce_body: None,
            if_spec: None,
            if_branch: None,
            result: None,
            input_policy: None,
        },
    );
    nodes.insert(
        "source".to_string(),
        function_node(
            "source-fn",
            InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            },
            vec![],
            None,
        ),
    );

    let def = WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:progress".to_string(),
        },
        default_functions: None,
        metadata: None,
    };
    let mut record = new_record(json!({}));
    let mut results = BTreeMap::new();
    let mut source_items = vec![];
    for index in 0..750 {
        source_items.push(json!({"id": index}));
    }
    match drive_step(&def, &mut record, &results) {
        TickDecision::Fire(uids) => assert_eq!(uids, vec!["source".to_string()]),
        other => panic!("expected source node, got {:?}", other),
    }
    complete(
        &mut record,
        &mut results,
        "source",
        json!({"items": source_items}),
    );

    let mut tick_durations = Vec::new();
    for start in (0..750).step_by(50) {
        let end = (start + 50).min(750);
        let expected_children: Vec<String> = (start..end)
            .map(|index| format!("children#{index}"))
            .collect();
        let tick_started = Instant::now();
        match drive_step(&def, &mut record, &results) {
            TickDecision::Fire(uids) => assert_eq!(uids, expected_children),
            other => panic!("expected child batch {start}..{end}, got {:?}", other),
        }
        tick_durations.push(tick_started.elapsed());
        if start == 0 {
            assert_eq!(
                record.nodes.len(),
                101,
                "only source plus two active batches should exist"
            );
            let active_bytes = serde_json::to_vec(&record)
                .expect("serialize active record")
                .len();
            let mut fully_materialized = record.clone();
            let template = fully_materialized
                .nodes
                .get("children#0")
                .cloned()
                .expect("first batch checkpoint");
            for index in 0..750 {
                fully_materialized
                    .nodes
                    .entry(format!("children#{index}"))
                    .or_insert_with(|| template.clone());
                fully_materialized
                    .nodes
                    .entry(format!("progress#{index}"))
                    .or_insert_with(|| template.clone());
            }
            let fully_materialized_bytes = serde_json::to_vec(&fully_materialized)
                .expect("serialize fully materialized record")
                .len();
            assert!(
                active_bytes * 5 < fully_materialized_bytes,
                "lazy batch record should be substantially smaller: active={active_bytes}, full={fully_materialized_bytes}"
            );
        }
        for index in start..end {
            complete(
                &mut record,
                &mut results,
                &format!("children#{index}"),
                json!({"ok": true, "id": index}),
            );
        }

        let expected_progress: Vec<String> = (start..end)
            .map(|index| format!("progress#{index}"))
            .collect();
        let tick_started = Instant::now();
        match drive_step(&def, &mut record, &results) {
            TickDecision::Fire(uids) => assert_eq!(uids, expected_progress),
            other => panic!("expected progress batch {start}..{end}, got {:?}", other),
        }
        tick_durations.push(tick_started.elapsed());
        assert!(
            record.nodes.len() <= 101,
            "completed batches must be compacted: start={start} nodes={}",
            record.nodes.len()
        );
        for index in start..end {
            complete(
                &mut record,
                &mut results,
                &format!("progress#{index}"),
                json!({"ok": true}),
            );
        }
    }

    let early: u128 = tick_durations
        .iter()
        .take(4)
        .map(|duration| duration.as_nanos())
        .sum();
    let late: u128 = tick_durations
        .iter()
        .rev()
        .take(4)
        .map(|duration| duration.as_nanos())
        .sum();
    assert!(
        late <= early.saturating_mul(4).saturating_add(5_000_000),
        "late batch ticks degraded unexpectedly: early={early}ns late={late}ns"
    );
}

#[test]
fn batch_record_scaling_stays_bounded_for_750_and_2000_items() {
    let mut nodes = BTreeMap::new();
    nodes.insert(
        "source".to_string(),
        function_node(
            "source-fn",
            InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            },
            vec![],
            None,
        ),
    );
    nodes.insert(
        "children".to_string(),
        function_node(
            "child-fn",
            InputSpec {
                from: "fanout_item".into(),
                template: None,
                value: None,
            },
            vec!["source".to_string()],
            Some(FanoutSpec {
                over: "node:source.items".to_string(),
                mode: Some(FanoutMode::Batch),
                batch_size: Some(50),
                item_return_type: Some(NodeInputReturnType::Store),
            }),
        ),
    );
    let def = WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:children".into(),
        },
        default_functions: None,
        metadata: None,
    };

    struct BatchMeasurement {
        item_count: usize,
        max_nodes: usize,
        max_payload_bytes: usize,
        early_tick_nanos: u128,
        late_tick_nanos: u128,
    }

    let mut measurements = Vec::new();
    for item_count in [750usize, 2_000] {
        let mut record = new_record(json!({}));
        let mut results = BTreeMap::new();
        let items = (0..item_count)
            .map(|index| json!({"id": index}))
            .collect::<Vec<_>>();
        assert!(matches!(
            drive_step(&def, &mut record, &results),
            TickDecision::Fire(ref uids) if uids == &["source".to_string()]
        ));
        complete(&mut record, &mut results, "source", json!({"items": items}));

        let mut max_nodes = record.nodes.len();
        let mut max_payload_bytes = serde_json::to_vec(&record).unwrap().len();
        let mut tick_nanos = Vec::new();
        for start in (0..item_count).step_by(50) {
            let end = (start + 50).min(item_count);
            let tick_started = Instant::now();
            let decision = drive_step(&def, &mut record, &results);
            tick_nanos.push(tick_started.elapsed().as_nanos());
            let expected = (start..end)
                .map(|index| format!("children#{index}"))
                .collect::<Vec<_>>();
            assert!(matches!(decision, TickDecision::Fire(ref uids) if uids == &expected));
            for index in start..end {
                complete(
                    &mut record,
                    &mut results,
                    &format!("children#{index}"),
                    json!({"ok": true}),
                );
            }
            max_nodes = max_nodes.max(record.nodes.len());
            max_payload_bytes = max_payload_bytes.max(serde_json::to_vec(&record).unwrap().len());
        }

        let early_tick_nanos = tick_nanos.iter().take(4).sum();
        let late_tick_nanos = tick_nanos.iter().rev().take(4).sum();
        eprintln!(
            "batch baseline items={item_count} max_nodes={max_nodes} max_payload_bytes={max_payload_bytes} early_ticks={early_tick_nanos}ns late_ticks={late_tick_nanos}ns"
        );
        measurements.push(BatchMeasurement {
            item_count,
            max_nodes,
            max_payload_bytes,
            early_tick_nanos,
            late_tick_nanos,
        });
    }

    let first = &measurements[0];
    let second = &measurements[1];
    assert_eq!(first.item_count, 750);
    assert_eq!(second.item_count, 2_000);
    assert!(
        first.max_nodes <= 51,
        "750-item batch state grew beyond one active batch"
    );
    assert!(
        second.max_nodes <= 51,
        "2000-item batch state grew beyond one active batch"
    );
    assert!(second.max_payload_bytes <= first.max_payload_bytes.saturating_mul(2));
    assert!(
        second.late_tick_nanos
            <= first
                .late_tick_nanos
                .saturating_mul(8)
                .saturating_add(20_000_000)
    );
    assert!(
        first.late_tick_nanos
            <= first
                .early_tick_nanos
                .saturating_mul(8)
                .saturating_add(20_000_000)
    );
}

#[test]
fn batch_child_workflow_lifecycle_releases_results_for_750_and_2000_items() {
    let mut nodes = BTreeMap::new();
    nodes.insert(
        "source".to_string(),
        function_node(
            "source-fn",
            InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            },
            vec![],
            None,
        ),
    );
    let mut children_node = function_node(
        "unused",
        InputSpec {
            from: "fanout_item".into(),
            template: None,
            value: None,
        },
        vec!["source".to_string()],
        Some(FanoutSpec {
            over: "node:source.items".to_string(),
            mode: Some(FanoutMode::Batch),
            batch_size: Some(50),
            item_return_type: Some(NodeInputReturnType::Store),
        }),
    );
    children_node.function = None;
    children_node.child_workflow = Some(ChildWorkflowSpec {
        workflow: "cohort::patient-extraction".to_string(),
    });
    nodes.insert("children".to_string(), children_node);
    let def = WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:children".into(),
        },
        default_functions: None,
        metadata: None,
    };

    for item_count in [750usize, 2_000] {
        let mut record = new_record(json!({}));
        let mut results = BTreeMap::new();
        let items = (0..item_count)
            .map(|index| json!({"patient_id": format!("patient-{index}")}))
            .collect::<Vec<_>>();
        assert!(matches!(
            drive_step(&def, &mut record, &results),
            TickDecision::Fire(ref uids) if uids == &["source".to_string()]
        ));
        complete(&mut record, &mut results, "source", json!({"items": items}));

        let mut completed_children = 0;
        let mut max_nodes = record.nodes.len();
        let mut max_result_bytes = 0;
        let mut max_record_bytes = serde_json::to_vec(&record).unwrap().len();
        loop {
            let (decision, detached_result_uids) =
                drive_child_batch_step(&def, &mut record, &results);
            results.remove("source");
            for uid in detached_result_uids {
                assert!(
                    results.remove(&uid).is_some(),
                    "cleanup UID must identify a stored child result: {uid}"
                );
            }
            max_nodes = max_nodes.max(record.nodes.len());
            max_result_bytes = max_result_bytes.max(
                results
                    .values()
                    .map(|value| serde_json::to_vec(value).unwrap().len())
                    .sum::<usize>(),
            );
            max_record_bytes = max_record_bytes.max(serde_json::to_vec(&record).unwrap().len());

            match decision {
                TickDecision::Fire(uids) => {
                    assert!(uids.iter().all(|uid| uid.starts_with("children#")));
                    for uid in &uids {
                        complete(
                            &mut record,
                            &mut results,
                            uid,
                            json!({
                                "patient_id": uid,
                                "extraction": "x".repeat(4096)
                            }),
                        );
                    }
                    completed_children += uids.len();
                }
                TickDecision::Finalize(status) => {
                    assert_eq!(status, RunStatus::Completed);
                    break;
                }
                TickDecision::Park => panic!("child batch unexpectedly parked"),
            }
        }

        eprintln!(
            "child batch lifecycle items={item_count} completed={completed_children} max_nodes={max_nodes} max_result_bytes={max_result_bytes} max_record_bytes={max_record_bytes}"
        );
        assert_eq!(completed_children, item_count);
        assert!(record.nodes.len() <= 51);
        assert_eq!(results.len(), 50);
        assert!(max_nodes <= 51);
        assert!(max_result_bytes <= 50 * 5_000);
    }
}

#[test]
fn batch_compaction_returns_removed_result_uids_for_cleanup() {
    let mut nodes = BTreeMap::new();
    nodes.insert(
        "children".to_string(),
        function_node(
            "child-fn",
            InputSpec {
                from: "fanout_item".into(),
                template: None,
                value: None,
            },
            vec![],
            Some(FanoutSpec {
                over: "node:source.items".to_string(),
                mode: Some(FanoutMode::Batch),
                batch_size: Some(50),
                item_return_type: Some(NodeInputReturnType::Store),
            }),
        ),
    );
    let def = WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:children".into(),
        },
        default_functions: None,
        metadata: None,
    };
    let mut record = new_record(json!({}));
    record.fanout_src.insert("children".to_string(), 100);
    record.fanout_active.insert("children".to_string(), 50);
    for index in 0..50 {
        record.nodes.insert(
            format!("children#{index}"),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: Some(format!("run_test/children#{index}")),
                result_error: None,
                child_run_id: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: Some(1),
                worker_name: None,
            },
        );
    }
    for index in 50..100 {
        record.nodes.insert(
            format!("children#{index}"),
            NodeCheckpoint {
                state: NodeState::Pending,
                session_id: None,
                turn_id: None,
                result_ref: None,
                result_error: None,
                child_run_id: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: None,
                worker_name: None,
            },
        );
    }

    let removed = dag::compact_completed_batch_checkpoints(&def, &mut record, "children");
    let expected_removed: Vec<String> = (0..50).map(|index| format!("children#{index}")).collect();
    assert_eq!(removed, expected_removed);
    assert_eq!(record.nodes.len(), 50);
    assert!(record.nodes.keys().all(|uid| {
        uid.strip_prefix("children#")
            .and_then(|index| index.parse::<usize>().ok())
            .is_some_and(|index| index >= 50)
    }));
    assert_eq!(record.fanout_active["children"], 50);
    assert_eq!(record.fanout_src["children"], 100);
}

#[test]
fn child_workflow_fanout_results_are_forwarded_without_nulls() {
    let mut def = three_node_def();
    let child_node = def.nodes.get_mut("read").expect("read node");
    child_node.function = None;
    child_node.child_workflow = Some(ChildWorkflowSpec {
        workflow: "cohort::child".to_string(),
    });

    let mut record = new_record(json!({"topic": "rust"}));
    let mut results = BTreeMap::new();
    assert!(matches!(
        drive_step(&def, &mut record, &results),
        TickDecision::Fire(ref uids) if uids == &["plan"]
    ));
    complete(
        &mut record,
        &mut results,
        "plan",
        json!({"docs": ["a", "b"]}),
    );

    let fired = drive_step(&def, &mut record, &results);
    assert!(matches!(fired, TickDecision::Fire(ref uids) if uids == &["read#0", "read#1"]));

    // Child runs may complete out of order, but their materialized results must
    // still be forwarded by item index and must never be replaced with null.
    complete(&mut record, &mut results, "read#1", json!({"status": "B"}));
    complete(&mut record, &mut results, "read#0", json!({"status": "A"}));

    let gathered = dag::gather_input(
        &def,
        &record,
        &json!({"topic": "rust"}),
        "synthesize",
        &results,
    );
    assert_eq!(
        gathered,
        json!([{"status": "A"}, {"status": "B"}]),
        "completed child results must be forwarded in fanout order"
    );
    assert!(!gathered.as_array().unwrap().iter().any(Value::is_null));
}

// ---------------------------------------------------------------------------
// Test 2: redelivered_drive_is_stable
// ---------------------------------------------------------------------------

#[test]
fn redelivered_drive_is_stable() {
    let def = three_node_def();
    let mut record = new_record(json!({"topic": "rust"}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    // Complete plan so read fanout can be expanded.
    record.nodes.insert(
        "plan".to_string(),
        NodeCheckpoint {
            state: NodeState::Done,
            session_id: Some("wf_run_test_plan".to_string()),
            turn_id: Some("turn_plan".to_string()),
            result_ref: Some("run_test/plan".to_string()),
            result_error: None,
            child_run_id: None,
            pending_at: None,
            pending_timeout_ms: None,
            retries: 0,
            completed_at: None,
            worker_name: None,
        },
    );
    results.insert("plan".to_string(), json!({"docs": ["a", "b"]}));

    // First expand: should expand "read" and insert read#0, read#1.
    let first_expanded = dag::expand_ready_fanouts(&def, &mut record, &results);
    assert_eq!(
        first_expanded,
        vec!["read".to_string()],
        "first expand must expand read"
    );
    let uid_count_after_first = dag::fanned_uids(&record, "read").len();
    assert_eq!(
        uid_count_after_first, 2,
        "must have 2 fanned uids after first expand"
    );

    // Second call to expand_ready_fanouts: must be idempotent — returns empty, frozen.
    let second_expanded = dag::expand_ready_fanouts(&def, &mut record, &results);
    assert!(
        second_expanded.is_empty(),
        "second expand must return empty (already expanded)"
    );

    let uid_count_after_second = dag::fanned_uids(&record, "read").len();
    assert_eq!(
        uid_count_after_second, uid_count_after_first,
        "fanned_uids count must be unchanged after re-expand"
    );

    // The fanout_src snapshot must be frozen (same items).
    assert_eq!(
        record.fanout_src["read"], 2,
        "fanout_src must be frozen after first expansion"
    );
}

// ---------------------------------------------------------------------------
// Test 3: completed_with_result_error_marks_node_failed
// ---------------------------------------------------------------------------

#[test]
fn completed_with_result_error_marks_node_failed() {
    let def = three_node_def();
    let mut record = new_record(json!({"topic": "rust"}));

    // Set up record with plan Running.
    record.nodes.insert(
        "plan".to_string(),
        NodeCheckpoint {
            state: NodeState::Running,
            session_id: Some("wf_run_test_plan".to_string()),
            turn_id: Some("turn_plan".to_string()),
            result_ref: None,
            result_error: None,
            child_run_id: None,
            pending_at: Some(1_000_000),
            pending_timeout_ms: None,
            retries: 0,
            completed_at: None,
            worker_name: None,
        },
    );

    // Apply result_error to plan using complete_with_error.
    complete_with_error(&mut record, "plan", "schema validation failed");

    // Checkpoint must be Failed.
    let plan_cp = record
        .nodes
        .get("plan")
        .expect("plan checkpoint must exist");
    assert_eq!(
        plan_cp.state,
        NodeState::Failed,
        "plan checkpoint state must be Failed"
    );
    assert_eq!(
        plan_cp.result_error.as_deref(),
        Some("schema validation failed"),
        "plan checkpoint must carry the error message"
    );

    // quiescence with a failed node required for output → must be Failed.
    let q = dag::quiescence(&def, &record);
    assert_eq!(
        q,
        RunStatus::Failed,
        "run must be Failed when a node has failed"
    );

    // decide must also Finalize(Failed).
    let decision = decide(&def, &record);
    match decision {
        TickDecision::Finalize(RunStatus::Failed) => {}
        other => panic!(
            "expected Finalize(Failed) when node failed, got {:?}",
            other
        ),
    }
}

// ---------------------------------------------------------------------------
// Diamond definition: a → {b, c} → d
// ---------------------------------------------------------------------------

fn diamond_def() -> WorkflowDef {
    let mut nodes = BTreeMap::new();

    nodes.insert(
        "a".to_string(),
        function_node(
            "a-fn",
            InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            },
            vec![],
            None,
        ),
    );

    nodes.insert(
        "b".to_string(),
        function_node(
            "b-fn",
            InputSpec {
                from: "node:a".into(),
                template: None,
                value: None,
            },
            vec!["a".to_string()],
            None,
        ),
    );

    nodes.insert(
        "c".to_string(),
        function_node(
            "c-fn",
            InputSpec {
                from: "node:a".into(),
                template: None,
                value: None,
            },
            vec!["a".to_string()],
            None,
        ),
    );

    nodes.insert(
        "d".to_string(),
        function_node(
            "d-fn",
            InputSpec {
                // Join node: read BOTH branches. depends_on lists b and c, so the
                // input must consume both (a single `from` would drop one).
                from: workflow::types::InputFrom::Many(vec![
                    "node:b".to_string(),
                    "node:c".to_string(),
                ]),
                template: None,
                value: None,
            },
            vec!["b".to_string(), "c".to_string()],
            None,
        ),
    );

    WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:d".into(),
        },
        default_functions: None,
        metadata: None,
    }
}

// ---------------------------------------------------------------------------
// Test 4: diamond_advances_both_branches_then_joins
// ---------------------------------------------------------------------------

#[test]
fn diamond_advances_both_branches_then_joins() {
    let def = diamond_def();
    let mut record = new_record(json!({}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    // Step 1: fresh record → should Fire(["a"])
    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["a".to_string()], "step 1 must fire only a");
        }
        other => panic!("expected Fire([a]) at step 1, got {:?}", other),
    }

    // Complete a.
    complete(&mut record, &mut results, "a", json!({"x": 1}));

    // Step 2: both b and c become ready in the SAME frontier — both must fire.
    let step2 = drive_step(&def, &mut record, &results);
    let fired2 = match &step2 {
        TickDecision::Fire(uids) => uids.clone(),
        other => panic!("expected Fire([b, c]) at step 2, got {:?}", other),
    };
    assert!(
        fired2.contains(&"b".to_string()) && fired2.contains(&"c".to_string()),
        "step 2 must fire both b and c concurrently; got {:?}",
        fired2
    );
    assert_eq!(fired2.len(), 2, "exactly 2 nodes should fire at step 2");

    // Complete c out of order (before b).
    complete(&mut record, &mut results, "c", json!({"x": 3}));

    // d still waits on b — the join/barrier must block it.
    let frontier_after_c = dag::ready_frontier(&def, &record);
    assert!(
        frontier_after_c.is_empty(),
        "frontier must be empty after only c is done (d still waits on b); got {:?}",
        frontier_after_c
    );

    // Now complete b as well.
    complete(&mut record, &mut results, "b", json!({"x": 2}));

    // Step 3: both b and c done → d's join fires.
    let step3 = drive_step(&def, &mut record, &results);
    match &step3 {
        TickDecision::Fire(uids) => {
            assert_eq!(
                uids,
                &vec!["d".to_string()],
                "step 3 must fire d after join"
            );
        }
        other => panic!("expected Fire([d]) at step 3, got {:?}", other),
    }

    // Complete d.
    complete(&mut record, &mut results, "d", json!({"x": 4}));

    // Final quiescence: the run must be Completed.
    let q = dag::quiescence(&def, &record);
    assert_eq!(
        q,
        RunStatus::Completed,
        "run must be Completed after d finishes"
    );
}

// ---------------------------------------------------------------------------
// Test 5: abort_while_node_running_finalizes_cancelled
// ---------------------------------------------------------------------------

/// Logical abort e2e: set abort=true on a run with a Running node and assert
/// that decide returns Finalize(Cancelled). This validates that the abort flag
/// wins over a non-empty ready frontier and over any Running node state.
#[test]
fn abort_while_node_running_finalizes_cancelled() {
    let def = three_node_def();
    let mut record = new_record(json!({"topic": "rust"}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    // Drive one step so "plan" is Running.
    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["plan".to_string()], "step 1 must fire plan");
        }
        other => panic!("expected Fire([plan]) at step 1, got {:?}", other),
    }

    // Sanity: plan is now Running in the record.
    let plan_cp = record
        .nodes
        .get("plan")
        .expect("plan checkpoint must exist");
    assert_eq!(
        plan_cp.state,
        NodeState::Running,
        "plan must be Running after drive_step"
    );

    // Set abort flag — simulates workflow::stop marking the run for cancellation.
    record.abort = true;

    // decide must return Finalize(Cancelled) regardless of the Running node or
    // any ready frontier.
    let decision = decide(&def, &record);
    match decision {
        TickDecision::Finalize(RunStatus::Cancelled) => {}
        other => panic!(
            "expected Finalize(Cancelled) when abort=true, got {:?}",
            other
        ),
    }

    // quiescence also short-circuits on abort and returns Cancelled.
    let q = dag::quiescence(&def, &record);
    assert_eq!(
        q,
        RunStatus::Cancelled,
        "quiescence must return Cancelled when abort=true"
    );

    // Simulate completing plan with a result (abort still set) — decide must
    // still return Finalize(Cancelled), not Fire or Park.
    complete(&mut record, &mut results, "plan", json!({"docs": ["x"]}));
    let decision2 = decide(&def, &record);
    match decision2 {
        TickDecision::Finalize(RunStatus::Cancelled) => {}
        other => panic!(
            "expected Finalize(Cancelled) even after plan done (abort=true), got {:?}",
            other
        ),
    }
}

// ---------------------------------------------------------------------------
// Test 6 (empty-fanout acceptance): empty_fanout_completes_run
// ---------------------------------------------------------------------------

fn fanout_empty_def() -> WorkflowDef {
    let mut nodes = BTreeMap::new();

    nodes.insert(
        "a".to_string(),
        function_node(
            "a-fn",
            InputSpec {
                from: "run_input".into(),
                template: Some("t".to_string()),
                value: None,
            },
            vec![],
            None,
        ),
    );

    nodes.insert(
        "b".to_string(),
        function_node(
            "b-fn",
            InputSpec {
                from: "fanout_item".into(),
                template: Some("t".to_string()),
                value: None,
            },
            vec!["a".to_string()],
            Some(FanoutSpec {
                over: "node:a.result.items".to_string(),
                mode: None,
                batch_size: None,
                item_return_type: None,
            }),
        ),
    );

    nodes.insert(
        "c".to_string(),
        function_node(
            "c-fn",
            InputSpec {
                from: "node:b".into(),
                template: Some("t".to_string()),
                value: None,
            },
            vec!["b".to_string()],
            None,
        ),
    );

    WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:c".into(),
        },
        default_functions: None,
        metadata: None,
    }
}

#[test]
fn empty_fanout_completes_run() {
    let def = fanout_empty_def();
    let mut record = new_record(json!({}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    // Step 1: fresh record → Fire(["a"])
    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["a".to_string()], "step 1 must fire a");
        }
        other => panic!("expected Fire([a]) at step 1, got {:?}", other),
    }

    // Complete a with zero items.
    complete(&mut record, &mut results, "a", json!({"items": []}));

    // Step 2: expand b to empty (zero b#i), then c becomes ready (b vacuously Done).
    let step2 = drive_step(&def, &mut record, &results);
    match &step2 {
        TickDecision::Fire(uids) => {
            assert_eq!(
                uids,
                &vec!["c".to_string()],
                "step 2 must fire c after empty fanout expansion"
            );
        }
        other => panic!("expected Fire([c]) at step 2, got {:?}", other),
    }

    // Complete c.
    complete(&mut record, &mut results, "c", json!({"done": true}));

    // Final quiescence: must be Completed.
    let q = dag::quiescence(&def, &record);
    assert_eq!(
        q,
        RunStatus::Completed,
        "run must be Completed after empty fanout + c done"
    );
}

// ---------------------------------------------------------------------------
// Test 7: sweep_refires_then_fails_after_budget
// ---------------------------------------------------------------------------

#[test]
fn sweep_refires_then_fails_after_budget() {
    use workflow::timeout::{timeout_action, TimeoutAction};
    use workflow::types::*;
    // A Running node, pending_at far in the past, max_retries = 1.
    let mut cp = NodeCheckpoint {
        state: NodeState::Running,
        session_id: Some("wf_r_n@r0".into()),
        turn_id: Some("t0".into()),
        result_ref: None,
        result_error: None,
        child_run_id: None,
        pending_at: Some(0),
        pending_timeout_ms: Some(1_000),
        retries: 0,
        completed_at: None,
        worker_name: None,
    };
    let now = 10_000;
    // first sweep: under budget -> refire attempt 1
    match timeout_action(&cp, 30_000, 1, now) {
        TimeoutAction::Refire { attempt } => {
            cp.retries = attempt;
            cp.pending_at = Some(now);
        }
        other => panic!("expected Refire, got {other:?}"),
    }
    assert_eq!(cp.retries, 1);
    // second sweep (still stuck): at budget -> fail out
    assert!(matches!(
        timeout_action(&cp, 30_000, 1, now + 10_000),
        TimeoutAction::FailOut
    ));
}

// ---------------------------------------------------------------------------
// Test 8: diamond_failed_branch_blocks_join_and_fails_run
// ---------------------------------------------------------------------------

#[test]
fn diamond_failed_branch_blocks_join_and_fails_run() {
    let def = diamond_def();
    let mut record = new_record(json!({}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    // Step 1: a fires, then completes.
    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["a".to_string()], "step 1 must fire a");
        }
        other => panic!("expected Fire([a]) at step 1, got {:?}", other),
    }
    complete(&mut record, &mut results, "a", json!({"x": 1}));

    // Step 2: b and c fire as parallel siblings.
    let step2 = drive_step(&def, &mut record, &results);
    let fired2 = match &step2 {
        TickDecision::Fire(uids) => uids.clone(),
        other => panic!("expected Fire([b, c]) at step 2, got {:?}", other),
    };
    assert!(fired2.contains(&"b".to_string()));
    assert!(fired2.contains(&"c".to_string()));

    // One branch succeeds, one branch fails.
    complete(&mut record, &mut results, "b", json!({"x": 2}));
    complete_with_error(&mut record, "c", "branch c failed");

    // Join d must NOT become ready when one dependency failed.
    let frontier = dag::ready_frontier(&def, &record);
    assert!(
        frontier.is_empty(),
        "join node d must stay blocked when a dependency failed; got {:?}",
        frontier
    );

    // Run must finalize as Failed.
    let decision = decide(&def, &record);
    match decision {
        TickDecision::Finalize(RunStatus::Failed) => {}
        other => panic!(
            "expected Finalize(Failed) after failed branch, got {:?}",
            other
        ),
    }

    let q = dag::quiescence(&def, &record);
    assert_eq!(q, RunStatus::Failed, "quiescence must return Failed");
}

// ---------------------------------------------------------------------------
// Test 9: diamond_join_waits_while_other_branch_running
// ---------------------------------------------------------------------------

#[test]
fn diamond_join_waits_while_other_branch_running() {
    let def = diamond_def();
    let mut record = new_record(json!({}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    // Step 1: a fires, then completes.
    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["a".to_string()], "step 1 must fire a");
        }
        other => panic!("expected Fire([a]) at step 1, got {:?}", other),
    }
    complete(&mut record, &mut results, "a", json!({"x": 1}));

    // Step 2: b and c fire.
    let step2 = drive_step(&def, &mut record, &results);
    let fired2 = match &step2 {
        TickDecision::Fire(uids) => uids.clone(),
        other => panic!("expected Fire([b, c]) at step 2, got {:?}", other),
    };
    assert!(fired2.contains(&"b".to_string()));
    assert!(fired2.contains(&"c".to_string()));

    // Only b completes; c remains Running.
    complete(&mut record, &mut results, "b", json!({"x": 2}));

    // No join yet; scheduler should park.
    let frontier = dag::ready_frontier(&def, &record);
    assert!(
        frontier.is_empty(),
        "join must not be ready while c is still running"
    );

    let decision = decide(&def, &record);
    match decision {
        TickDecision::Park => {}
        other => panic!(
            "expected Park while one branch still running, got {:?}",
            other
        ),
    }
}

// ---------------------------------------------------------------------------
// Test 10: abort_while_diamond_branches_running_finalizes_cancelled
// ---------------------------------------------------------------------------

#[test]
fn abort_while_diamond_branches_running_finalizes_cancelled() {
    let def = diamond_def();
    let mut record = new_record(json!({}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    // Step 1: a fires, then completes so b and c can start.
    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["a".to_string()], "step 1 must fire a");
        }
        other => panic!("expected Fire([a]) at step 1, got {:?}", other),
    }
    complete(&mut record, &mut results, "a", json!({"x": 1}));

    // Step 2: b and c fire and become Running in the record.
    let step2 = drive_step(&def, &mut record, &results);
    let fired2 = match &step2 {
        TickDecision::Fire(uids) => uids.clone(),
        other => panic!("expected Fire([b, c]) at step 2, got {:?}", other),
    };
    assert!(fired2.contains(&"b".to_string()));
    assert!(fired2.contains(&"c".to_string()));

    // While both branch nodes are still running, abort must short-circuit.
    record.abort = true;

    let decision = decide(&def, &record);
    match decision {
        TickDecision::Finalize(RunStatus::Cancelled) => {}
        other => panic!(
            "expected Finalize(Cancelled) when abort=true with running branches, got {:?}",
            other
        ),
    }

    let q = dag::quiescence(&def, &record);
    assert_eq!(
        q,
        RunStatus::Cancelled,
        "quiescence must return Cancelled when abort=true"
    );
}

fn orphan_after_output_def() -> WorkflowDef {
    let mut nodes = BTreeMap::new();

    nodes.insert(
        "process".to_string(),
        function_node(
            "process-text",
            InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            },
            vec![],
            None,
        ),
    );

    nodes.insert(
        "wait-error".to_string(),
        function_node(
            "wait-error",
            InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            },
            vec!["process".to_string()],
            None,
        ),
    );

    WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:process".into(),
        },
        default_functions: None,
        metadata: None,
    }
}

#[test]
fn output_node_done_still_runs_later_declared_steps() {
    let def = orphan_after_output_def();
    let mut record = new_record(json!({ "text": "Hello" }));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(
                uids,
                &vec!["process".to_string()],
                "step 1 must fire process"
            );
        }
        other => panic!("expected Fire([process]) at step 1, got {:?}", other),
    }

    complete(&mut record, &mut results, "process", json!({ "ok": true }));

    let frontier = dag::ready_frontier(&def, &record);
    assert_eq!(
        frontier,
        vec!["wait-error".to_string()],
        "wait-error is technically ready after process"
    );

    let step2 = drive_step(&def, &mut record, &results);
    match step2 {
        TickDecision::Fire(uids) => {
            assert_eq!(
                uids,
                vec!["wait-error".to_string()],
                "decide must fire later declared step before finalizing"
            );
        }
        other => panic!(
            "expected Fire([wait-error]) after process done, got {:?}",
            other
        ),
    }

    complete(
        &mut record,
        &mut results,
        "wait-error",
        json!({ "ok": true }),
    );

    let q = dag::quiescence(&def, &record);
    assert_eq!(
        q,
        RunStatus::Completed,
        "run should complete after wait-error"
    );
}

#[test]
fn missing_done_payload_is_treated_as_failure_not_null_flow() {
    let def = two_node_linear_def();
    let mut record = new_record(json!({"topic": "x"}));
    let results: BTreeMap<String, Value> = BTreeMap::new();

    // Simulate a corrupted checkpoint: node marked Done with a result_ref,
    // but no payload is available in the loaded result map.
    record.nodes.insert(
        "first".to_string(),
        NodeCheckpoint {
            state: NodeState::Done,
            session_id: Some("wf_run_test_first".to_string()),
            turn_id: Some("turn_first".to_string()),
            result_ref: Some("run_test/first".to_string()),
            result_error: None,
            child_run_id: None,
            pending_at: Some(1),
            pending_timeout_ms: None,
            retries: 0,
            completed_at: Some(2),
            worker_name: None,
        },
    );

    mark_missing_done_payloads_as_failed(&mut record, &results);

    let first = record.nodes.get("first").expect("first checkpoint");
    assert_eq!(first.state, NodeState::Failed);
    assert!(
        first.result_ref.is_none(),
        "stale result ref must be removed"
    );

    match decide(&def, &record) {
        TickDecision::Finalize(RunStatus::Failed) => {}
        other => panic!("expected Finalize(Failed), got {:?}", other),
    }
}

#[test]
fn output_node_result_is_retained_pre_finalize() {
    let mut def = orphan_after_output_def();
    if let Some(wait) = def.nodes.get_mut("wait-error") {
        wait.input = InputSpec {
            from: "node:process".into(),
            template: None,
            value: None,
        };
    }
    let mut record = new_record(json!({"text": "Hello"}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    // process fires and completes first.
    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => assert_eq!(uids, &vec!["process".to_string()]),
        other => panic!("expected Fire([process]), got {:?}", other),
    }
    complete(&mut record, &mut results, "process", json!({"ok": true}));

    // Even though process is the run output node, later declared steps still run.
    let step2 = drive_step(&def, &mut record, &results);
    match &step2 {
        TickDecision::Fire(uids) => assert_eq!(uids, &vec!["wait-error".to_string()]),
        other => panic!("expected Fire([wait-error]), got {:?}", other),
    }

    // The completed output result must remain available while workflow is not finalized.
    let gathered = dag::gather_input(
        &def,
        &record,
        &json!({"text": "Hello"}),
        "wait-error",
        &results,
    );
    assert_eq!(gathered, json!({"ok": true}));
}

fn loop_pipeline_def(mode: FanoutMode) -> WorkflowDef {
    let mut nodes = BTreeMap::new();

    nodes.insert(
        "plan".to_string(),
        function_node(
            "plan-fn",
            InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            },
            vec![],
            None,
        ),
    );

    nodes.insert(
        "transform-item".to_string(),
        function_node(
            "transform-item-fn",
            InputSpec {
                from: "fanout_item".into(),
                template: None,
                value: None,
            },
            vec!["plan".to_string()],
            Some(FanoutSpec {
                over: "node:plan.result.items".to_string(),
                mode: Some(mode),
                batch_size: None,
                item_return_type: None,
            }),
        ),
    );

    nodes.insert(
        "score-item".to_string(),
        function_node(
            "score-item-fn",
            InputSpec {
                from: "fanout_item".into(),
                template: None,
                value: None,
            },
            vec!["transform-item".to_string()],
            Some(FanoutSpec {
                over: "node:plan.result.items".to_string(),
                mode: Some(mode),
                batch_size: None,
                item_return_type: None,
            }),
        ),
    );

    WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:score-item".into(),
        },
        default_functions: None,
        metadata: None,
    }
}

#[test]
fn sequential_loop_pipeline_enforces_item_order() {
    let def = loop_pipeline_def(FanoutMode::Sequential);
    let mut record = new_record(json!({}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["plan".to_string()], "step 1 must fire plan");
        }
        other => panic!("expected Fire([plan]) at step 1, got {:?}", other),
    }

    complete(
        &mut record,
        &mut results,
        "plan",
        json!({"items": ["a", "b"]}),
    );

    let step2 = drive_step(&def, &mut record, &results);
    match &step2 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["transform-item#0".to_string()]);
        }
        other => panic!(
            "expected Fire([transform-item#0]) at step 2, got {:?}",
            other
        ),
    }

    complete(
        &mut record,
        &mut results,
        "transform-item#0",
        json!({"ok": true}),
    );

    let step3 = drive_step(&def, &mut record, &results);
    match &step3 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["score-item#0".to_string()]);
        }
        other => panic!("expected Fire([score-item#0]) at step 3, got {:?}", other),
    }

    complete(
        &mut record,
        &mut results,
        "score-item#0",
        json!({"score": 1}),
    );

    let step4 = drive_step(&def, &mut record, &results);
    match &step4 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["transform-item#1".to_string()]);
        }
        other => panic!(
            "expected Fire([transform-item#1]) at step 4, got {:?}",
            other
        ),
    }
}

#[test]
fn parallel_loop_pipeline_releases_matching_items_without_global_barrier() {
    let def = loop_pipeline_def(FanoutMode::Parallel);
    let mut record = new_record(json!({}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["plan".to_string()], "step 1 must fire plan");
        }
        other => panic!("expected Fire([plan]) at step 1, got {:?}", other),
    }

    complete(
        &mut record,
        &mut results,
        "plan",
        json!({"items": ["a", "b"]}),
    );

    let step2 = drive_step(&def, &mut record, &results);
    let fired2 = match &step2 {
        TickDecision::Fire(uids) => uids.clone(),
        other => panic!(
            "expected Fire([transform-item#0, transform-item#1]) at step 2, got {:?}",
            other
        ),
    };
    assert!(fired2.contains(&"transform-item#0".to_string()));
    assert!(fired2.contains(&"transform-item#1".to_string()));

    complete(
        &mut record,
        &mut results,
        "transform-item#0",
        json!({"ok": true}),
    );

    let step3 = drive_step(&def, &mut record, &results);
    match &step3 {
        TickDecision::Fire(uids) => {
            assert!(uids.contains(&"score-item#0".to_string()));
            assert!(
                !uids.contains(&"score-item#1".to_string()),
                "score-item#1 must wait for transform-item#1"
            );
        }
        other => panic!(
            "expected Fire including score-item#0 at step 3, got {:?}",
            other
        ),
    }
}

fn sequential_loop_with_parallel_all_def() -> WorkflowDef {
    let mut nodes = BTreeMap::new();

    nodes.insert(
        "plan".to_string(),
        function_node(
            "plan-fn",
            InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            },
            vec![],
            None,
        ),
    );

    nodes.insert(
        "transform-item".to_string(),
        function_node(
            "transform-item-fn",
            InputSpec {
                from: "fanout_item".into(),
                template: None,
                value: None,
            },
            vec!["plan".to_string()],
            Some(FanoutSpec {
                over: "node:plan.result.items".to_string(),
                mode: Some(FanoutMode::Sequential),
                batch_size: None,
                item_return_type: None,
            }),
        ),
    );

    nodes.insert(
        "score-a".to_string(),
        function_node(
            "score-a-fn",
            InputSpec {
                from: "node:transform-item".into(),
                template: None,
                value: None,
            },
            vec!["transform-item".to_string()],
            Some(FanoutSpec {
                over: "node:plan.result.items".to_string(),
                mode: Some(FanoutMode::Sequential),
                batch_size: None,
                item_return_type: None,
            }),
        ),
    );

    nodes.insert(
        "score-b".to_string(),
        function_node(
            "score-b-fn",
            InputSpec {
                from: "node:transform-item".into(),
                template: None,
                value: None,
            },
            vec!["transform-item".to_string()],
            Some(FanoutSpec {
                over: "node:plan.result.items".to_string(),
                mode: Some(FanoutMode::Sequential),
                batch_size: None,
                item_return_type: None,
            }),
        ),
    );

    nodes.insert(
        "merge-item".to_string(),
        function_node(
            "merge-item-fn",
            InputSpec {
                from: workflow::types::InputFrom::Many(vec![
                    "node:score-a".to_string(),
                    "node:score-b".to_string(),
                ]),
                template: None,
                value: None,
            },
            vec!["score-a".to_string(), "score-b".to_string()],
            Some(FanoutSpec {
                over: "node:plan.result.items".to_string(),
                mode: Some(FanoutMode::Sequential),
                batch_size: None,
                item_return_type: None,
            }),
        ),
    );

    WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:merge-item".into(),
        },
        default_functions: None,
        metadata: None,
    }
}

#[test]
fn sequential_loop_allows_parallel_all_within_same_item() {
    let def = sequential_loop_with_parallel_all_def();
    let mut record = new_record(json!({}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["plan".to_string()], "step 1 must fire plan");
        }
        other => panic!("expected Fire([plan]) at step 1, got {:?}", other),
    }

    complete(
        &mut record,
        &mut results,
        "plan",
        json!({"items": ["a", "b"]}),
    );

    let step2 = drive_step(&def, &mut record, &results);
    match &step2 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["transform-item#0".to_string()]);
        }
        other => panic!(
            "expected Fire([transform-item#0]) at step 2, got {:?}",
            other
        ),
    }

    complete(
        &mut record,
        &mut results,
        "transform-item#0",
        json!({"v": 1}),
    );

    let step3 = drive_step(&def, &mut record, &results);
    let fired3 = match &step3 {
        TickDecision::Fire(uids) => uids.clone(),
        other => panic!(
            "expected Fire([score-a#0, score-b#0]) at step 3, got {:?}",
            other
        ),
    };
    assert!(fired3.contains(&"score-a#0".to_string()));
    assert!(fired3.contains(&"score-b#0".to_string()));
    assert_eq!(
        fired3.len(),
        2,
        "both all-branches for item #0 must fire in parallel"
    );

    complete(&mut record, &mut results, "score-a#0", json!({"sa": 1}));

    let step4 = drive_step(&def, &mut record, &results);
    match step4 {
        TickDecision::Park => {}
        other => panic!(
            "expected Park while score-b#0 is still pending before item #1 can advance, got {:?}",
            other
        ),
    }

    complete(&mut record, &mut results, "score-b#0", json!({"sb": 1}));

    let step5 = drive_step(&def, &mut record, &results);
    match &step5 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["merge-item#0".to_string()]);
        }
        other => panic!("expected Fire([merge-item#0]) at step 5, got {:?}", other),
    }

    complete(&mut record, &mut results, "merge-item#0", json!({"m": 1}));

    let step6 = drive_step(&def, &mut record, &results);
    match &step6 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["transform-item#1".to_string()]);
        }
        other => panic!(
            "expected Fire([transform-item#1]) at step 6, got {:?}",
            other
        ),
    }
}

fn sequential_loop_with_parallel_all_three_branches_def() -> WorkflowDef {
    let mut nodes = BTreeMap::new();

    nodes.insert(
        "plan".to_string(),
        function_node(
            "plan-fn",
            InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            },
            vec![],
            None,
        ),
    );

    nodes.insert(
        "transform-item".to_string(),
        function_node(
            "transform-item-fn",
            InputSpec {
                from: "fanout_item".into(),
                template: None,
                value: None,
            },
            vec!["plan".to_string()],
            Some(FanoutSpec {
                over: "node:plan.result.items".to_string(),
                mode: Some(FanoutMode::Sequential),
                batch_size: None,
                item_return_type: None,
            }),
        ),
    );

    for branch in ["score-a", "score-b", "score-c"] {
        nodes.insert(
            branch.to_string(),
            function_node(
                &format!("{}-fn", branch),
                InputSpec {
                    from: "node:transform-item".into(),
                    template: None,
                    value: None,
                },
                vec!["transform-item".to_string()],
                Some(FanoutSpec {
                    over: "node:plan.result.items".to_string(),
                    mode: Some(FanoutMode::Sequential),
                    batch_size: None,
                    item_return_type: None,
                }),
            ),
        );
    }

    nodes.insert(
        "merge-item".to_string(),
        function_node(
            "merge-item-fn",
            InputSpec {
                from: workflow::types::InputFrom::Many(vec![
                    "node:score-a".to_string(),
                    "node:score-b".to_string(),
                    "node:score-c".to_string(),
                ]),
                template: None,
                value: None,
            },
            vec![
                "score-a".to_string(),
                "score-b".to_string(),
                "score-c".to_string(),
            ],
            Some(FanoutSpec {
                over: "node:plan.result.items".to_string(),
                mode: Some(FanoutMode::Sequential),
                batch_size: None,
                item_return_type: None,
            }),
        ),
    );

    WorkflowDef {
        version: 1,
        nodes,
        output: OutputRef {
            from: "node:merge-item".into(),
        },
        default_functions: None,
        metadata: None,
    }
}

#[test]
fn sequential_loop_parallel_all_three_branches_fails_if_one_branch_fails() {
    let def = sequential_loop_with_parallel_all_three_branches_def();
    let mut record = new_record(json!({}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["plan".to_string()], "step 1 must fire plan");
        }
        other => panic!("expected Fire([plan]) at step 1, got {:?}", other),
    }

    complete(
        &mut record,
        &mut results,
        "plan",
        json!({"items": ["a", "b"]}),
    );

    let step2 = drive_step(&def, &mut record, &results);
    match &step2 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["transform-item#0".to_string()]);
        }
        other => panic!(
            "expected Fire([transform-item#0]) at step 2, got {:?}",
            other
        ),
    }

    complete(
        &mut record,
        &mut results,
        "transform-item#0",
        json!({"v": 1}),
    );

    let step3 = drive_step(&def, &mut record, &results);
    let fired3 = match &step3 {
        TickDecision::Fire(uids) => uids.clone(),
        other => panic!(
            "expected Fire([score-a#0, score-b#0, score-c#0]) at step 3, got {:?}",
            other
        ),
    };
    assert!(fired3.contains(&"score-a#0".to_string()));
    assert!(fired3.contains(&"score-b#0".to_string()));
    assert!(fired3.contains(&"score-c#0".to_string()));
    assert_eq!(
        fired3.len(),
        3,
        "all three branches for item #0 must fire in parallel"
    );

    complete(&mut record, &mut results, "score-a#0", json!({"sa": 1}));
    complete_with_error(&mut record, "score-b#0", "score-b failed");
    complete(&mut record, &mut results, "score-c#0", json!({"sc": 1}));

    let frontier = dag::ready_frontier(&def, &record);
    assert!(
        !frontier.contains(&"merge-item#0".to_string()),
        "merge-item#0 must not become ready if one all-branch failed"
    );
    assert!(
        !frontier.contains(&"transform-item#1".to_string()),
        "sequential loop must not advance to item #1 when item #0 failed"
    );

    let decision = decide(&def, &record);
    match decision {
        TickDecision::Finalize(RunStatus::Failed) => {}
        other => panic!(
            "expected Finalize(Failed) after one all-branch failed, got {:?}",
            other
        ),
    }

    let q = dag::quiescence(&def, &record);
    assert_eq!(q, RunStatus::Failed, "quiescence must return Failed");
}

#[test]
fn regression_first_done_immediately_unblocks_second() {
    let def = two_node_linear_def();
    let mut record = new_record(json!({"topic": "x"}));
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    // Step 1: first node must fire.
    let step1 = drive_step(&def, &mut record, &results);
    match &step1 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["first".to_string()]);
        }
        other => panic!("expected Fire([first]) at step 1, got {:?}", other),
    }

    // Simulate persisted result for first node (the critical edge in this regression).
    complete(&mut record, &mut results, "first", json!({"ok": true}));

    // Step 2: second must fire right away. It must not Park/Retry/Finalize.
    let step2 = drive_step(&def, &mut record, &results);
    match &step2 {
        TickDecision::Fire(uids) => {
            assert_eq!(uids, &vec!["second".to_string()]);
        }
        other => panic!(
            "expected Fire([second]) after first result, got {:?}",
            other
        ),
    }

    // Sanity-check checkpoint states to catch regressions in state transitions.
    assert_eq!(
        record.nodes.get("first").map(|cp| &cp.state),
        Some(&NodeState::Done),
        "first checkpoint must stay Done"
    );
    assert_eq!(
        record.nodes.get("second").map(|cp| &cp.state),
        Some(&NodeState::Running),
        "second checkpoint must be Running after fire"
    );
}
