use std::collections::{BTreeMap, HashSet};

use iii_sdk::TriggerAction;
use serde_json::{json, Map, Value};

use crate::{
    dag,
    error::WorkflowError,
    ids,
    observability::ObservabilityAdapter,
    state,
    types::{
        FunctionSpec, InputFrom, NodeCheckpoint, NodeDef, NodeMemoryFailPolicy,
        NodeInputReturnType, NodeResultReturnType, NodeState, QueueReceiptRecord, RunStatus,
        WorkflowDef,
        WorkflowRunRecord, WorkflowVarDelta, WorkflowVarRecord,
        WorkflowVarVersionRecord,
    },
};

use super::Deps;

// ---------------------------------------------------------------------------
// TickDecision
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum TickDecision {
    Finalize(RunStatus),
    Fire(Vec<String>),
    Park,
}

fn has_running_nodes(record: &WorkflowRunRecord) -> bool {
    record
        .nodes
        .values()
        .any(|cp| matches!(cp.state, NodeState::Running))
}

fn parked_run_is_stuck(record: &WorkflowRunRecord) -> bool {
    !has_running_nodes(record)
}

// ---------------------------------------------------------------------------
// decide (pure)
// ---------------------------------------------------------------------------

pub fn decide(def: &WorkflowDef, record: &WorkflowRunRecord) -> TickDecision {
    // Abort flag always wins.
    if record.abort {
        return TickDecision::Finalize(RunStatus::Cancelled);
    }

    // Check quiescence for terminal states.
    let q = dag::quiescence(def, record);
    if q == RunStatus::Completed || q == RunStatus::Failed {
        return TickDecision::Finalize(q);
    }

    // If there are nodes ready to fire, Fire them; otherwise Park.
    let ready = dag::ready_frontier(def, record);
    if ready.is_empty() {
        TickDecision::Park
    } else {
        TickDecision::Fire(ready)
    }
}

fn dispatch_queue_for(function: &FunctionSpec) -> String {
    function
        .queue
        .as_deref()
        .filter(|q| !q.trim().is_empty())
        .unwrap_or("default")
        .to_string()
}

fn is_terminal_node_state(state: NodeState) -> bool {
    matches!(state, NodeState::Done | NodeState::Failed | NodeState::Cancelled)
}

fn node_group_terminal(def: &WorkflowDef, record: &WorkflowRunRecord, node_id: &str) -> bool {
    let is_fanout = def
        .nodes
        .get(node_id)
        .and_then(|n| n.fanout.as_ref())
        .is_some();

    if !is_fanout {
        return record
            .nodes
            .get(node_id)
            .map(|cp| is_terminal_node_state(cp.state))
            .unwrap_or(false);
    }

    if matches!(
        record.nodes.get(node_id).map(|c| c.state),
        Some(NodeState::Failed) | Some(NodeState::Cancelled)
    ) {
        return true;
    }

    let Some(items) = record.fanout_src.get(node_id) else {
        return false;
    };

    for i in 0..*items {
        let uid = ids::node_uid(node_id, Some(i as u32));
        match record.nodes.get(uid.as_str()).map(|cp| cp.state) {
            Some(state) if is_terminal_node_state(state) => {}
            _ => return false,
        }
    }

    true
}

fn node_result_mode(def: &WorkflowDef, node_uid: &str) -> NodeResultReturnType {
    let base_id = node_uid.split('#').next().unwrap_or(node_uid);
    def.nodes
        .get(base_id)
        .and_then(|node| node.result.as_ref())
        .map(|result| result.return_type)
        .unwrap_or(NodeResultReturnType::Memory)
}

fn node_on_memory_fail(def: &WorkflowDef, node_uid: &str) -> Option<NodeMemoryFailPolicy> {
    let base_id = node_uid.split('#').next().unwrap_or(node_uid);
    def.nodes
        .get(base_id)
        .and_then(|node| node.result.as_ref())
        .and_then(|result| result.on_memory_fail)
}

fn node_input_mode(def: &WorkflowDef, node_uid: &str) -> NodeInputReturnType {
    let base_id = node_uid.split('#').next().unwrap_or(node_uid);
    def.nodes
        .get(base_id)
        .and_then(|node| node.input_policy.as_ref())
        .map(|input| input.return_type)
        .unwrap_or(NodeInputReturnType::Memory)
}

fn node_input_on_memory_fail(def: &WorkflowDef, node_uid: &str) -> Option<NodeMemoryFailPolicy> {
    let base_id = node_uid.split('#').next().unwrap_or(node_uid);
    def.nodes
        .get(base_id)
        .and_then(|node| node.input_policy.as_ref())
        .and_then(|input| input.on_memory_fail)
}

    fn fanout_item_mode(def: &WorkflowDef, node_id: &str) -> NodeInputReturnType {
        def.nodes
        .get(node_id)
        .and_then(|node| node.fanout.as_ref())
        .and_then(|fanout| fanout.item_return_type)
        .unwrap_or(NodeInputReturnType::Memory)
    }

async fn load_run_input_for_node(
    deps: &Deps,
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    node_uid: &str,
) -> Result<Value, WorkflowError> {
    let mode = node_input_mode(def, node_uid);
    let on_memory_fail = node_input_on_memory_fail(def, node_uid);

    match mode {
        NodeInputReturnType::Store => state::get_run_input_store(&deps.iii, &record.input_ref)
            .await?
            .ok_or_else(|| {
                WorkflowError::State(format!(
                    "run input missing in store for {} (node {})",
                    record.run_id, node_uid
                ))
            }),
        NodeInputReturnType::Memory => {
            if let Some(input) = state::get_run_input_memory(&record.run_id)? {
                return Ok(input);
            }

            if matches!(on_memory_fail, Some(NodeMemoryFailPolicy::Store)) {
                return state::get_run_input_store(&deps.iii, &record.input_ref)
                    .await?
                    .ok_or_else(|| {
                        WorkflowError::State(format!(
                            "run input missing (memory+store fallback) for {} (node {})",
                            record.run_id, node_uid
                        ))
                    });
            }

            Err(WorkflowError::State(format!(
                "run input missing in memory for {} (node {})",
                record.run_id, node_uid
            )))
        }
    }
}

fn collect_prunable_memory_result_uids(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
) -> Vec<String> {
    let output_base_id = def
        .output
        .from
        .strip_prefix("node:")
        .unwrap_or(&def.output.from);

    let mut required_by_active: HashSet<String> = HashSet::new();
    for node_id in def.nodes.keys() {
        if node_group_terminal(def, record, node_id) {
            continue;
        }
        if let Some(node) = def.nodes.get(node_id) {
            for dep in &node.depends_on {
                required_by_active.insert(dep.clone());
            }
        }
    }

    let mut to_prune: Vec<String> = Vec::new();
    for (uid, cp) in &record.nodes {
        if cp.state != NodeState::Done || cp.result_ref.is_none() {
            continue;
        }

        if node_result_mode(def, uid) == NodeResultReturnType::Store {
            continue;
        }

        // `onMemoryFail: store` keeps the payload durable instead of pruning.
        // This is the robust fallback mode for memory-heavy/stuck workflows.
        if matches!(node_on_memory_fail(def, uid), Some(NodeMemoryFailPolicy::Store)) {
            continue;
        }

        let base_id = uid.split('#').next().unwrap_or(uid);
        if base_id == output_base_id {
            continue;
        }
        if required_by_active.contains(base_id) {
            continue;
        }

        to_prune.push(uid.clone());
    }

    to_prune
}

fn detach_prunable_memory_result_refs(
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
) -> Vec<String> {
    let to_prune = collect_prunable_memory_result_uids(def, record);

    for uid in &to_prune {
        if let Some(cp) = record.nodes.get_mut(uid.as_str()) {
            cp.result_ref = None;
        }
    }

    to_prune
}

fn input_source_requires_run_input(source: &str) -> bool {
    if source.starts_with("node:") {
        return false;
    }

    source != "fanout_item"
}

fn run_input_required_by_active_nodes(def: &WorkflowDef, record: &WorkflowRunRecord) -> bool {
    for node_id in def.nodes.keys() {
        if node_group_terminal(def, record, node_id) {
            continue;
        }

        let Some(node) = def.nodes.get(node_id) else {
            continue;
        };

        if node.input.value.is_some() {
            continue;
        }

        if node
            .input
            .from
            .sources()
            .iter()
            .any(|src| input_source_requires_run_input(src))
        {
            return true;
        }
    }

    false
}

fn node_requires_run_input(node: &NodeDef) -> bool {
    // Structured payload templates (`input.value`) are fully resolved from
    // embedded literals / node refs / fanout refs at dispatch time.
    if node.input.value.is_some() {
        return false;
    }

    node.input
        .from
        .sources()
        .iter()
        .any(|src| input_source_requires_run_input(src))
}

fn releasable_fanout_memory_nodes(def: &WorkflowDef, record: &WorkflowRunRecord) -> Vec<String> {
    let mut releasable = Vec::new();

    for node_id in def.nodes.keys() {
        if fanout_item_mode(def, node_id) != NodeInputReturnType::Memory {
            continue;
        }

        if !node_group_terminal(def, record, node_id) {
            continue;
        }

        releasable.push(node_id.clone());
    }

    releasable
}

pub(crate) async fn release_consumed_memory_artifacts(
    _deps: &Deps,
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
) -> Result<Vec<String>, WorkflowError> {
    let detached_result_uids = detach_prunable_memory_result_refs(def, record);

    if !run_input_required_by_active_nodes(def, record) {
        let _ = state::delete_run_input_memory(&record.run_id);
    }

    for node_id in releasable_fanout_memory_nodes(def, record) {
        let _ = state::delete_fanout_items_memory(&record.run_id, &node_id);
    }

    Ok(detached_result_uids)
}

// ---------------------------------------------------------------------------
// fire_node
// ---------------------------------------------------------------------------

fn resolve_node_input(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    run_input: &Value,
    node_uid: &str,
    base_id: &str,
    node: &NodeDef,
    fanout_item: Option<&Value>,
    results: &BTreeMap<String, Value>,
) -> Value {
    if node_uid.contains('#') {
        // Per-item binding: parse the index i after '#'
        let idx_str = node_uid.split('#').nth(1).unwrap_or("0");
        let i: usize = idx_str.parse().unwrap_or(0);

        if node.input.from.is_literal("fanout_item") {
            return fanout_item.cloned().unwrap_or(Value::Null);
        }

        // Loop/fanout chaining: for fanout child node `curr#i` reading from
        // `node:dep` where `dep` is also a fanout, feed the matched dep item
        // `dep#i` instead of the whole dep array.
        let maybe_item_from_dep = match &node.input.from {
            InputFrom::One(src) if src.starts_with("node:") && node.fanout.is_some() => {
                let dep = src.strip_prefix("node:").unwrap_or(src.as_str());
                let dep_is_fanout = def.nodes.get(dep).and_then(|n| n.fanout.as_ref()).is_some();

                if dep_is_fanout {
                    let dep_uid = format!("{}#{}", dep, i);
                    results.get(dep_uid.as_str()).cloned()
                } else {
                    None
                }
            }
            _ => None,
        };

        let base = maybe_item_from_dep
            .unwrap_or_else(|| dag::gather_input(def, record, run_input, base_id, results));
        return resolve_dynamic_template(
            def,
            record,
            run_input,
            base_id,
            &node.input,
            &base,
            fanout_item,
            results,
        );
    }

    let base = dag::gather_input(def, record, run_input, base_id, results);
    resolve_dynamic_template(
        def,
        record,
        run_input,
        base_id,
        &node.input,
        &base,
        fanout_item,
        results,
    )
}

fn value_at_path(value: &Value, path: &[String]) -> Value {
    let mut cur = value;
    for segment in path {
        match cur {
            Value::Object(map) => {
                if let Some(next) = map.get(segment) {
                    cur = next;
                } else {
                    return Value::Null;
                }
            }
            Value::Array(arr) => {
                if let Ok(idx) = segment.parse::<usize>() {
                    if let Some(next) = arr.get(idx) {
                        cur = next;
                    } else {
                        return Value::Null;
                    }
                } else {
                    return Value::Null;
                }
            }
            _ => return Value::Null,
        }
    }
    cur.clone()
}

fn resolve_dynamic_payload_value(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    run_input: &Value,
    node_id: &str,
    payload: &Value,
    fanout_item: Option<&Value>,
    results: &BTreeMap<String, Value>,
) -> Value {
    match payload {
        Value::Object(map) => {
            if let Some(ref_source) = map.get("$wf_ref").and_then(|v| v.as_str()) {
                let path = map
                    .get("$wf_path")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(ToString::to_string))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();

                if ref_source.starts_with("node:") {
                    let dep = ref_source.strip_prefix("node:").unwrap_or(ref_source);
                    let dep_value = if def.nodes.get(dep).and_then(|n| n.fanout.as_ref()).is_some()
                    {
                        let n = record.fanout_src.get(dep).copied().unwrap_or(0);
                        let arr = (0..n)
                            .map(|i| {
                                let uid = format!("{}#{}", dep, i);
                                results.get(&uid).cloned().unwrap_or(Value::Null)
                            })
                            .collect::<Vec<_>>();
                        Value::Array(arr)
                    } else {
                        results.get(dep).cloned().unwrap_or(Value::Null)
                    };
                    return value_at_path(&dep_value, &path);
                }

                if ref_source == "fanout_item" {
                    let base = fanout_item.cloned().unwrap_or(Value::Null);
                    return value_at_path(&base, &path);
                }
            }

            let mut out = Map::new();
            for (k, v) in map {
                out.insert(
                    k.clone(),
                    resolve_dynamic_payload_value(
                        def,
                        record,
                        run_input,
                        node_id,
                        v,
                        fanout_item,
                        results,
                    ),
                );
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(
            arr.iter()
                .map(|v| {
                    resolve_dynamic_payload_value(
                        def,
                        record,
                        run_input,
                        node_id,
                        v,
                        fanout_item,
                        results,
                    )
                })
                .collect(),
        ),
        _ => payload.clone(),
    }
}

fn resolve_dynamic_template(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    run_input: &Value,
    node_id: &str,
    input_spec: &crate::types::InputSpec,
    base: &Value,
    fanout_item: Option<&Value>,
    results: &BTreeMap<String, Value>,
) -> Value {
    let Some(payload) = input_spec.value.as_ref() else {
        return base.clone();
    };
    resolve_dynamic_payload_value(
        def,
        record,
        run_input,
        node_id,
        payload,
        fanout_item,
        results,
    )
}

fn flatten_object_paths(prefix: &str, value: &Value, out: &mut BTreeMap<String, Value>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let next = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", prefix, k)
                };
                flatten_object_paths(&next, v, out);
            }
        }
        _ => {
            out.insert(prefix.to_string(), value.clone());
        }
    }
}

fn compute_delta(prev: &Value, next: &Value) -> WorkflowVarDelta {
    if !prev.is_object() || !next.is_object() {
        let mut set = BTreeMap::new();
        set.insert(String::new(), next.clone());
        return WorkflowVarDelta {
            set,
            unset: Vec::new(),
        };
    }

    let mut prev_flat = BTreeMap::new();
    let mut next_flat = BTreeMap::new();
    flatten_object_paths("", prev, &mut prev_flat);
    flatten_object_paths("", next, &mut next_flat);

    let mut set = BTreeMap::new();
    let mut unset = Vec::new();

    for (k, v) in &next_flat {
        if prev_flat.get(k) != Some(v) {
            set.insert(k.clone(), v.clone());
        }
    }
    for k in prev_flat.keys() {
        if !next_flat.contains_key(k) {
            unset.push(k.clone());
        }
    }

    WorkflowVarDelta { set, unset }
}

fn apply_path_set(root: &mut Value, path: &str, value: Value) {
    if path.is_empty() {
        *root = value;
        return;
    }
    let parts: Vec<&str> = path.split('.').collect();
    let mut cur = root;
    for (i, part) in parts.iter().enumerate() {
        let is_last = i + 1 == parts.len();
        if is_last {
            if !cur.is_object() {
                *cur = Value::Object(Map::new());
            }
            if let Some(obj) = cur.as_object_mut() {
                obj.insert((*part).to_string(), value.clone());
            }
            return;
        }

        if !cur.is_object() {
            *cur = Value::Object(Map::new());
        }
        let obj = cur.as_object_mut().expect("object after normalization");
        cur = obj
            .entry((*part).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }
}

fn apply_path_unset(root: &mut Value, path: &str) {
    if path.is_empty() {
        *root = Value::Null;
        return;
    }
    let parts: Vec<&str> = path.split('.').collect();
    let mut cur = root;
    for (i, part) in parts.iter().enumerate() {
        let is_last = i + 1 == parts.len();
        if let Some(obj) = cur.as_object_mut() {
            if is_last {
                obj.remove(*part);
                return;
            }
            if let Some(next) = obj.get_mut(*part) {
                cur = next;
            } else {
                return;
            }
        } else {
            return;
        }
    }
}

fn apply_delta(base: &Value, delta: &WorkflowVarDelta) -> Value {
    let mut out = base.clone();
    for path in &delta.unset {
        apply_path_unset(&mut out, path);
    }
    for (path, value) in &delta.set {
        apply_path_set(&mut out, path, value.clone());
    }
    out
}

fn truncate_for_trace(v: &Value) -> Value {
    match v {
        Value::String(s) if s.len() > 200 => Value::String(format!("{}...", &s[..200])),
        Value::Object(_) | Value::Array(_) => {
            let blob = serde_json::to_string(v).unwrap_or_default();
            if blob.len() > 500 {
                Value::String(format!("{}...[truncated]", &blob[..500]))
            } else {
                v.clone()
            }
        }
        _ => v.clone(),
    }
}

fn should_store_var_checkpoint(cfg: &crate::config::WorkerConfig, version: u64) -> bool {
    if cfg.var_checkpoint_every_versions == 0 {
        return false;
    }
    if version < cfg.var_checkpoint_start_version {
        return false;
    }
    version % cfg.var_checkpoint_every_versions == 0
}

async fn execute_internal_var_set(
    deps: &Deps,
    record: &mut WorkflowRunRecord,
    node_uid: &str,
    input_val: &Value,
) -> Result<(), WorkflowError> {
    let key = input_val
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            WorkflowError::State("workflow::internal-var-set requires input.key".to_string())
        })?
        .to_string();
    let next_value = input_val.get("value").cloned().unwrap_or(Value::Null);

    let now = deps.now_ms();
    let vars_ref = record
        .vars_ref
        .as_deref()
        .ok_or_else(|| WorkflowError::State("vars_ref missing".to_string()))?;
    let mut vars = state::get_run_vars(&deps.iii, vars_ref).await?;

    let prior = vars.get(&key).cloned();
    let prev_value = prior
        .as_ref()
        .map(|v| v.value.clone())
        .unwrap_or(Value::Null);
    let prior_version = prior.as_ref().map(|v| v.version).unwrap_or(0);
    let next_version = prior_version.saturating_add(1);

    let delta = compute_delta(&prev_value, &next_value);
    let rebuilt = apply_delta(&prev_value, &delta);
    let cfg = deps.cfg().await;
    let checkpoint_value = if should_store_var_checkpoint(&cfg, next_version) {
        Some(next_value.clone())
    } else {
        None
    };

    let mut versions = prior.map(|v| v.versions).unwrap_or_default();
    versions.push(WorkflowVarVersionRecord {
        version: next_version,
        ts_unix_ms: now,
        delta: delta.clone(),
        checkpoint_value,
    });

    vars.insert(
        key.clone(),
        WorkflowVarRecord {
            key: key.clone(),
            version: next_version,
            updated_at: now,
            value: rebuilt.clone(),
            versions,
        },
    );
    state::put_run_vars(&deps.iii, vars_ref, &vars).await?;

    state::put_node_result(&deps.iii, &record.run_id, node_uid, &rebuilt).await?;

    record.nodes.insert(
        node_uid.to_string(),
        NodeCheckpoint {
            state: NodeState::Done,
            session_id: None,
            turn_id: None,
            result_ref: Some(crate::ids::new_ref_id("node_result")),
            result_error: None,
            pending_at: Some(now),
            pending_timeout_ms: None,
            retries: 0,
            completed_at: Some(now),
            worker_name: Some(format!("workflow-internal-var:{}", key)),
        },
    );

    crate::observability::adapter()
        .write_trace(
            &deps.iii,
            &state::WorkflowRunTraceRecord {
                id: format!("tr_{}_{}", now, crate::ids::new_trace_id()),
                run_id: record.run_id.clone(),
                node_uid: Some(node_uid.to_string()),
                function_id: Some("workflow::internal-var-set".to_string()),
                runtime: Some("rust".to_string()),
                event_name: "workflow.var.updated".to_string(),
                ts_unix_ms: now,
                attributes: Some(json!({
                    "workflow.var.key": key,
                    "workflow.var.version": next_version,
                    "workflow.var.preview": truncate_for_trace(&rebuilt),
                })),
                trace_id: None,
                span_id: None,
            },
        )
        .await?;

    Ok(())
}

fn effective_pending_timeout_ms(
    prior_timeout: Option<u64>,
    function_timeout_ms: Option<u64>,
    dispatch_timeout_ms: u64,
) -> Option<u64> {
    prior_timeout
        .or(function_timeout_ms)
        .or(Some(dispatch_timeout_ms))
}

pub(crate) async fn fire_node(
    deps: &Deps,
    record: &mut WorkflowRunRecord,
    def: &WorkflowDef,
    node_uid: &str,
    results: &BTreeMap<String, Value>,
) -> Result<(), WorkflowError> {
    // Abort guard: covers both the tick Fire branch and the sweep refire path.
    // `decide` already returns Finalize(Cancelled) first when abort=true (so the
    // Fire branch in tick::handle is never reached for an aborting run), but the
    // sweep refire path calls fire_node directly without going through decide —
    // a node timing out on an already-aborting run would otherwise be re-fired.
    // One guard here covers both call sites.
    if record.abort {
        return Ok(());
    }

    let base_id = node_uid.split('#').next().unwrap();
    let node = def
        .nodes
        .get(base_id)
        .ok_or_else(|| WorkflowError::State(format!("node '{}' not in def", base_id)))?;

    let attempt = record.nodes.get(node_uid).map(|c| c.retries).unwrap_or(0);

    let run_input = match if node_requires_run_input(node) {
        load_run_input_for_node(deps, def, record, node_uid).await
    } else {
        Ok(Value::Null)
    } {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                run_id = %record.run_id,
                node_uid = %node_uid,
                error = %e,
                "node input load failed, marking node as failed"
            );

            let now = deps.now_ms();
            if let Some(cp) = record.nodes.get_mut(node_uid) {
                cp.state = NodeState::Failed;
                cp.result_ref = None;
                cp.result_error = Some(format!("node input load failed: {e}"));
                cp.completed_at = Some(now);
                let dur = cp
                    .pending_at
                    .map(|p| (now - p).max(0) as f64)
                    .unwrap_or(0.0);
                crate::telemetry::record_node_terminal(false, dur);
            } else {
                record.nodes.insert(
                    node_uid.to_string(),
                    NodeCheckpoint {
                        state: NodeState::Failed,
                        session_id: None,
                        turn_id: None,
                        result_ref: None,
                        result_error: Some(format!("node input load failed: {e}")),
                        pending_at: Some(now),
                        pending_timeout_ms: None,
                        retries: attempt,
                        completed_at: Some(now),
                        worker_name: None,
                    },
                );
                crate::telemetry::record_node_terminal(false, 0.0);
            }

            return Ok(());
        }
    };

    // Read attempt and prior_timeout BEFORE the input-resolution borrows.
    let prior_timeout = record
        .nodes
        .get(node_uid)
        .and_then(|c| c.pending_timeout_ms);

    let fanout_item = if node_uid.contains('#') {
        let idx_str = node_uid.split('#').nth(1).unwrap_or("0");
        let idx: usize = idx_str.parse().unwrap_or(0);
        match fanout_item_mode(def, base_id) {
            NodeInputReturnType::Store => {
                state::get_fanout_item(&deps.iii, &record.run_id, base_id, idx).await?
            }
            NodeInputReturnType::Memory => {
                state::get_fanout_items_memory(&record.run_id, base_id)?
                    .and_then(|items| items.get(idx).cloned())
            }
        }
    } else {
        None
    };

    // Resolve the input value. Read everything from `node`/`record` into owned values
    // BEFORE the .await so we don't hold a borrow across the await point.
    let input_val = resolve_node_input(
        def,
        record,
        &run_input,
        node_uid,
        base_id,
        node,
        fanout_item.as_ref(),
        results,
    );

    if node.function.id == "workflow::internal-var-set" {
        execute_internal_var_set(deps, record, node_uid, &input_val).await?;
        record.updated_at = deps.now_ms();
        state::put_run(&deps.iii, record).await?;

        // Internal var updates complete synchronously and do not emit a
        // node-completed queue event. Re-drive tick immediately so dependent
        // nodes do not wait for the sweep timeout.
        super::start::enqueue_tick(&deps.iii, &record.run_id, record.step + 1).await?;
        return Ok(());
    }

    let dispatch_timeout_ms = deps.cfg().await.dispatch_timeout_ms;

    // Fire the function asynchronously via queue (non-blocking)
    let function = &node.function;
    let node_pending_timeout_ms =
        effective_pending_timeout_ms(prior_timeout, function.timeout_ms, dispatch_timeout_ms);
    let max_retries = node
        .function
        .engine_retry
        .as_ref()
        .and_then(|r| r.max_attempts)
        .unwrap_or(deps.cfg().await.max_node_retries);

    // Discovery check: if the function is not in the registry, fail immediately
    // instead of enqueuing into a black hole.
    if !crate::discovery::is_function_available(&deps.discovery, &function.id).await {
        if attempt >= max_retries {
            tracing::error!(
                run_id = %record.run_id,
                node_uid = %node_uid,
                function_id = %function.id,
                retries = attempt,
                max_retries,
                "node fire failed: function missing after discovery retries"
            );

            record.nodes.insert(
                node_uid.to_string(),
                NodeCheckpoint {
                    state: NodeState::Failed,
                    session_id: None,
                    turn_id: None,
                    result_ref: None,
                    result_error: Some(format!(
                        "Function not found after retries: {}",
                        function.id
                    )),
                    pending_at: Some(deps.now_ms()),
                    pending_timeout_ms: None,
                    retries: attempt,
                    completed_at: Some(deps.now_ms()),
                    worker_name: None,
                },
            );
        } else {
            // Discovery is eventually consistent across worker reconnects.
            // Treat early misses as transient and re-drive via sweep timeout.
            tracing::warn!(
                run_id = %record.run_id,
                node_uid = %node_uid,
                function_id = %function.id,
                retries = attempt,
                max_retries,
                "function missing in discovery snapshot; will retry"
            );

            record.nodes.insert(
                node_uid.to_string(),
                NodeCheckpoint {
                    state: NodeState::Running,
                    session_id: None,
                    turn_id: None,
                    result_ref: None,
                    result_error: Some("function_missing_discovery_snapshot".to_string()),
                    pending_at: Some(deps.now_ms()),
                    pending_timeout_ms: Some(10_000),
                    retries: attempt,
                    completed_at: None,
                    worker_name: None,
                },
            );
        }

        record.updated_at = deps.now_ms();
        state::put_run(&deps.iii, record).await?;
        return Ok(());
    }

    let queue = dispatch_queue_for(function);

    // Wrap input with workflow metadata so functions can emit completion events
    let wrapped_input = json!({
        "_workflow": {
            "run_id": record.run_id,
            "node_uid": node_uid,
            "trace_id": record.workflow_trace_id,
            "result_policy": node.result
        },
        "input": input_val
    });

    tracing::info!(
        run_id = %record.run_id,
        node_uid = %node_uid,
        function_id = %function.id,
        "firing node via queue enqueue"
    );

    let trigger_res = deps
        .iii
        .trigger(iii_sdk::protocol::TriggerRequest {
            function_id: function.id.clone(),
            payload: wrapped_input,
            action: Some(TriggerAction::Enqueue {
                queue: queue.clone(),
            }),
            timeout_ms: function.timeout_ms.or(Some(dispatch_timeout_ms)),
        })
        .await;

    match trigger_res {
        Ok(v) => {
            // Check if the engine returned a logic error (e.g. function not found)
            // even though the RPC request itself was technically successful (Ok).
            let logic_error = v.get("error").or_else(|| v.get("result_error"));

            if let Some(err_val) = logic_error {
                let err_msg = err_val
                    .as_str()
                    .unwrap_or("Unknown trigger error")
                    .to_string();
                tracing::warn!(
                    run_id = %record.run_id,
                    node_uid = %node_uid,
                    error = %err_msg,
                    response = ?v,
                    "node fire returned logic error, marking as Failed"
                );

                record.nodes.insert(
                    node_uid.to_string(),
                    NodeCheckpoint {
                        state: NodeState::Failed,
                        session_id: None,
                        turn_id: None,
                        result_ref: None,
                        result_error: Some(format!("Trigger logic error: {}", err_msg)),
                        pending_at: Some(deps.now_ms()),
                        pending_timeout_ms: None,
                        retries: attempt,
                        completed_at: Some(deps.now_ms()),
                        worker_name: None,
                    },
                );
            } else {
                let maybe_session_id = v
                    .get("session_id")
                    .or_else(|| v.get("sessionId"))
                    .and_then(|x| x.as_str())
                    .map(str::to_string);

                if let Some(session_id) = maybe_session_id.as_deref() {
                    if let Err(e) = deps
                        .internal_state
                        .put_session_index(session_id, &record.run_id)
                        .await
                    {
                        tracing::warn!(
                            run_id = %record.run_id,
                            node_uid = %node_uid,
                            session_id = %session_id,
                            error = %e,
                            "failed to persist session index"
                        );
                    }
                }

                if let Some(receipt_id) = v.get("messageReceiptId").and_then(|x| x.as_str()) {
                    let receipt = QueueReceiptRecord {
                        id: format!("{}:{}:{}", &record.run_id, node_uid, receipt_id),
                        run_id: record.run_id.clone(),
                        node_uid: node_uid.to_string(),
                        function_id: function.id.clone(),
                        queue: queue.clone(),
                        receipt_id: receipt_id.to_string(),
                        attempt,
                        ts_unix_ms: deps.now_ms(),
                    };
                    if let Err(e) = deps.internal_state.put_queue_receipt(&receipt).await {
                        tracing::warn!(
                            run_id = %record.run_id,
                            node_uid = %node_uid,
                            error = %e,
                            "failed to persist queue receipt"
                        );
                    }
                }

                tracing::info!(
                    run_id = %record.run_id,
                    node_uid = %node_uid,
                    response = ?v,
                    "node enqueued successfully, marking as Running"
                );

                record.nodes.insert(
                    node_uid.to_string(),
                    NodeCheckpoint {
                        state: NodeState::Running,
                        session_id: maybe_session_id,
                        turn_id: None,
                        result_ref: None, // Result written by function when complete
                        result_error: None,
                        pending_at: Some(deps.now_ms()),
                        pending_timeout_ms: node_pending_timeout_ms,
                        retries: attempt,
                        completed_at: None,
                        worker_name: None,
                    },
                );
            }
        }
        Err(e) => {
            tracing::warn!(
                run_id = %record.run_id,
                node_uid = %node_uid,
                error = %e,
                "node fire failed (trigger error), marking as Failed"
            );

            record.nodes.insert(
                node_uid.to_string(),
                NodeCheckpoint {
                    state: NodeState::Failed,
                    session_id: None,
                    turn_id: None,
                    result_ref: None,
                    result_error: Some(format!("Trigger failed: {}", e)),
                    pending_at: Some(deps.now_ms()),
                    pending_timeout_ms: None,
                    retries: attempt,
                    completed_at: Some(deps.now_ms()),
                    worker_name: None,
                },
            );
        }
    }

    // Persist immediately to avoid race condition: if the function executes
    // synchronously (fast handler), it might emit node-completed before the
    // calling tick's state::put_run is reached. Persisting here ensures
    // node_completed::handle and reconcile_function_nodes see the Running state.
    record.updated_at = deps.now_ms();
    state::put_run(&deps.iii, record).await?;

    tracing::info!(
        run_id = %record.run_id,
        node_uid = %node_uid,
        "node state persisted"
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

/// Flip every still-`Running` checkpoint to `Cancelled`. Called by `finalize`
/// after the stop cascade: the cascade stops the live sessions, this records it in
/// the run so a terminal run doesn't report siblings as "running" in
/// workflow::status forever. Pure (no I/O), so it's unit-testable.
fn cancel_running_checkpoints(nodes: &mut BTreeMap<String, NodeCheckpoint>) {
    for cp in nodes.values_mut() {
        if matches!(cp.state, NodeState::Running) {
            cp.state = NodeState::Cancelled;
        }
    }
}

async fn finalize(
    deps: &Deps,
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
    status: RunStatus,
    results: &BTreeMap<String, Value>,
) -> Result<(), WorkflowError> {
    record.status = status;
    record.updated_at = deps.now_ms();

    let duration_ms = (record.updated_at - record.created_at).max(0) as f64;
    crate::telemetry::record_run_terminal(status, duration_ms);

    // Output node id (strip "node:") for result extraction.
    let out_node = def
        .output
        .from
        .strip_prefix("node:")
        .unwrap_or(&def.output.from);

    if status == RunStatus::Completed {
        // Check if the output node is a fanout group.
        let out_val = if def
            .nodes
            .get(out_node)
            .and_then(|n| n.fanout.as_ref())
            .is_some()
        {
            // Fanout group: collect results as an array in numeric order.
            let n = dag::fanned_uids(record, out_node).len();
            let arr: Vec<Value> = (0..n)
                .map(|i| {
                    let uid = ids::node_uid(out_node, Some(i as u32));
                    results.get(&uid).cloned().unwrap_or(Value::Null)
                })
                .collect();
            Value::Array(arr)
        } else {
            // Normal single-result node.
            results.get(out_node).cloned().unwrap_or(Value::Null)
        };

        let result_ref = record
            .result_ref
            .as_deref()
            .ok_or_else(|| WorkflowError::State("result_ref missing".to_string()))?;
        state::put_run_result(&deps.iii, result_ref, &out_val).await?;
    } else if status == RunStatus::Failed {
        // Surface WHY the run failed. Without this, `notify` delivers
        // result_error: null and workflow::status shows a bare "failed" — the
        // caller can't tell a bad model id from a crashed node and gives up.
        let summarized = summarize_failure(&record.nodes);
        if summarized.is_some() {
            record.result_error = summarized;
        } else if record.result_error.is_none() {
            record.result_error = Some("workflow failed without explicit node error".to_string());
        }
    }

    // Mark any sibling nodes still Running as Cancelled in the run record.
    // A fast-fail (or a Completed run with branches that don't feed the output node)
    // can finalize while siblings are mid-turn.
    cancel_running_checkpoints(&mut record.nodes);

    // Emit terminal callbacks BEFORE `put_run` persists the terminal status (in
    // tick::handle): emit-first is at-least-once — a crash before persist re-ticks
    // and re-fires, and consumers dedup on run_id.
    // Persisting first would instead risk a LOST delivery on a crash mid-emit, which
    // is strictly worse for a delivery guarantee.
    let rec: &WorkflowRunRecord = record;
    crate::events::emit_notify(deps, rec).await;

    let hook_result = if status == RunStatus::Completed {
        match record.result_ref.as_deref() {
            Some(result_ref) => state::get_run_result(&deps.iii, result_ref).await?,
            None => None,
        }
    } else {
        None
    };
    super::lifecycle_hooks::emit_terminal(deps, def, rec, hook_result).await;

    Ok(())
}

/// Summarize the failed nodes' errors into one run-level message, so
/// the run's `notify` callback (result_error) and `workflow::status` can report
/// WHY a run failed instead of a bare "failed". Returns None when nothing failed.
pub(crate) fn summarize_failure(nodes: &BTreeMap<String, NodeCheckpoint>) -> Option<String> {
    let mut errs: Vec<String> = nodes
        .iter()
        .filter(|(_, cp)| cp.state == NodeState::Failed)
        .map(|(uid, cp)| match &cp.result_error {
            Some(e) => format!("node '{uid}': {e}"),
            None => format!("node '{uid}' failed"),
        })
        .collect();
    errs.sort();
    if errs.is_empty() {
        None
    } else {
        Some(errs.join("; "))
    }
}

// ---------------------------------------------------------------------------
// handle
// ---------------------------------------------------------------------------

/// A tick should be skipped if its step is below the run's monotonic dequeue
/// floor (a re-delivered / duplicate tick — producers always enqueue
/// `record.step + 1`) or the run is already terminal. This IS the crash-resume /
/// at-least-once redelivery guard, pulled out as a pure fn so it's unit-testable
/// without a live engine. Note the comparison is strict `<`: a duplicate tick at
/// the SAME step (e.g. two fast-wakes firing `step+1` before either persists)
/// is NOT stale and runs a redundant-but-idempotent reconcile pass.
fn tick_is_stale(req_step: u64, record_step: u64, run_is_terminal: bool) -> bool {
    req_step < record_step || run_is_terminal
}

pub async fn handle(
    deps: &Deps,
    req: super::TickRequest,
) -> Result<super::TickResponse, WorkflowError> {
    // 1. Acquire per-run lock.
    let _g = deps.locks.guard(&req.run_id).await;

    // 2. Load the run record (None → skipped).
    let Some(mut record) = state::get_run(&deps.iii, &req.run_id).await? else {
        return Ok(super::TickResponse { skipped: true });
    };

    // 3. Stale guard.
    if tick_is_stale(req.step, record.step, record.status.is_terminal()) {
        return Ok(super::TickResponse { skipped: true });
    }

    // Advance the monotonic dequeue floor: a re-delivered tick at this step is now
    // rejected by the guard above. Producers (start/sweep/stop/resume) enqueue
    // `record.step + 1`, so a legitimate tick is never below this floor.
    record.step = req.step + 1;

    // 4. Load the workflow definition.
    let def = state::get_def(&deps.iii, &record.def_ref)
        .await?
        .map(|d| super::start::prepare_definition_for_execution(&d))
        .ok_or_else(|| WorkflowError::State("def missing".into()))?;

    // 5. Reconcile running nodes.
    crate::reconcile::reconcile_run(deps, &mut record).await?;
    crate::reconcile::reconcile_function_nodes(deps, &def, &mut record).await?;

    // 6. Load done results.
    let results = state::load_done_results(&deps.iii, &mut record).await?;

    // 7. Expand any ready fanouts.
    let expanded_fanouts = dag::expand_ready_fanouts(&def, &mut record, &results);
    for node_id in expanded_fanouts {
        let node_failed = matches!(
            record.nodes.get(&node_id).map(|cp| cp.state),
            Some(NodeState::Failed) | Some(NodeState::Cancelled)
        );
        if node_failed {
            let _ = state::delete_fanout_items_memory(&record.run_id, &node_id);
            state::delete_fanout_items(&deps.iii, &record.run_id, &node_id).await?;
            continue;
        }

        let Some(node_def) = def.nodes.get(&node_id) else {
            continue;
        };
        let Some(fanout) = node_def.fanout.as_ref() else {
            continue;
        };

        if let Ok(items) = dag::resolve_over_path(&fanout.over, &results) {
            match fanout.item_return_type.unwrap_or(NodeInputReturnType::Memory) {
                NodeInputReturnType::Store => {
                    let _ = state::delete_fanout_items_memory(&record.run_id, &node_id);
                    state::put_fanout_items(&deps.iii, &record.run_id, &node_id, &items).await?;
                }
                NodeInputReturnType::Memory => {
                    state::put_fanout_items_memory(&record.run_id, &node_id, &items)?;
                    state::delete_fanout_items(&deps.iii, &record.run_id, &node_id).await?;
                }
            }
        }
    }

    // 7b. Enforce liveness-based memory lifecycle cleanup.
    // Important ordering: detach result refs now, but only delete payload rows
    // after the updated run record is persisted to avoid ref/payload skew.
    let detached_result_uids = release_consumed_memory_artifacts(deps, &def, &mut record).await?;

    // 8. Decide and act.
    let decision = decide(&def, &record);
    tracing::info!(
        run_id = %req.run_id,
        decision = ?decision,
        "tick decision made"
    );

    match decision {
        TickDecision::Finalize(status) => {
            tracing::info!(
                run_id = %req.run_id,
                status = ?status,
                "finalizing workflow run"
            );
            finalize(deps, &def, &mut record, status, &results).await?;
            state::put_run(&deps.iii, &record).await?;

            for uid in &detached_result_uids {
                if let Err(e) = state::delete_node_result(&deps.iii, &record.run_id, uid).await {
                    tracing::warn!(
                        run_id = %record.run_id,
                        node_uid = %uid,
                        error = %e,
                        "failed to delete detached node result payload"
                    );
                }
            }

            // Terminal runs do not need in-process per-run payload caches.
            let _ = state::delete_run_input_memory(&record.run_id);
            let _ = state::delete_all_fanout_items_memory(&record.run_id);
            let _ = state::delete_all_node_results_memory(&record.run_id);
            Ok(super::TickResponse { skipped: false })
        }
        TickDecision::Fire(uids) => {
            tracing::info!(
                run_id = %req.run_id,
                nodes = ?uids,
                "firing ready nodes"
            );
            for uid in &uids {
                fire_node(deps, &mut record, &def, uid, &results).await?;
            }
            record.status = RunStatus::AwaitingNodes;
            record.updated_at = deps.now_ms();
            state::put_run(&deps.iii, &record).await?;

            for uid in &detached_result_uids {
                if let Err(e) = state::delete_node_result(&deps.iii, &record.run_id, uid).await {
                    tracing::warn!(
                        run_id = %record.run_id,
                        node_uid = %uid,
                        error = %e,
                        "failed to delete detached node result payload"
                    );
                }
            }
            Ok(super::TickResponse { skipped: false })
        }
        TickDecision::Park => {
            if parked_run_is_stuck(&record) {
                tracing::warn!(
                    run_id = %req.run_id,
                    "run is parked without running nodes; marking as failed to avoid hang"
                );
                record.result_error = Some(
                    "workflow stalled: no ready nodes and no running nodes (deadlock/stuck run)"
                        .to_string(),
                );
                finalize(deps, &def, &mut record, RunStatus::Failed, &results).await?;
                state::put_run(&deps.iii, &record).await?;

                for uid in &detached_result_uids {
                    if let Err(e) = state::delete_node_result(&deps.iii, &record.run_id, uid).await {
                        tracing::warn!(
                            run_id = %record.run_id,
                            node_uid = %uid,
                            error = %e,
                            "failed to delete detached node result payload"
                        );
                    }
                }

                let _ = state::delete_run_input_memory(&record.run_id);
                let _ = state::delete_all_fanout_items_memory(&record.run_id);
                let _ = state::delete_all_node_results_memory(&record.run_id);
                return Ok(super::TickResponse { skipped: false });
            }

            tracing::debug!(
                run_id = %req.run_id,
                "parking - no ready nodes"
            );
            record.status = RunStatus::AwaitingNodes;
            record.updated_at = deps.now_ms();
            state::put_run(&deps.iii, &record).await?;

            for uid in &detached_result_uids {
                if let Err(e) = state::delete_node_result(&deps.iii, &record.run_id, uid).await {
                    tracing::warn!(
                        run_id = %record.run_id,
                        node_uid = %uid,
                        error = %e,
                        "failed to delete detached node result payload"
                    );
                }
            }
            Ok(super::TickResponse { skipped: false })
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        FanoutSpec, FunctionSpec, InputSpec, NodeCheckpoint, NodeDef, NodeMemoryFailPolicy,
        NodeResultReturnType, NodeResultSpec, NodeState, OutputRef, WorkflowDef,
        WorkflowRunRecord,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    // -----------------------------------------------------------------------
    // Test helpers
    // -----------------------------------------------------------------------

    fn three_node_def() -> WorkflowDef {
        let mut nodes = BTreeMap::new();

        nodes.insert(
            "plan".to_string(),
            NodeDef {
                label: None,
                function: FunctionSpec {
                    id: "plan_function".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                },
                input: InputSpec {
                    from: "run_input".into(),
                    template: None,
                    value: None,
                },
                depends_on: vec![],
                fanout: None,
                result: None,
                input_policy: None,
            },
        );

        nodes.insert(
            "read".to_string(),
            NodeDef {
                label: None,
                function: FunctionSpec {
                    id: "read_function".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                },
                input: InputSpec {
                    from: "fanout_item".into(),
                    template: None,
                    value: None,
                },
                depends_on: vec!["plan".to_string()],
                fanout: Some(FanoutSpec {
                    over: "node:plan.result.docs".to_string(),
                    mode: None,
                    item_return_type: None,
                }),
                result: None,
                input_policy: None,
            },
        );

        nodes.insert(
            "synthesize".to_string(),
            NodeDef {
                label: None,
                function: FunctionSpec {
                    id: "synthesize_function".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                },
                input: InputSpec {
                    from: "node:read".into(),
                    template: None,
                    value: None,
                },
                depends_on: vec!["read".to_string()],
                fanout: None,
                result: None,
                input_policy: None,
            },
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

    fn fresh_record() -> WorkflowRunRecord {
        WorkflowRunRecord {
            run_id: "run_test".to_string(),
            workflow_name: None,
            workflow_trace_id: Some("trace_test".to_string()),
            state_scope_id: Some("run_test".to_string()),
            stream_scope_id: Some("run_test".to_string()),
            step: 0,
            status: RunStatus::Running,
            abort: false,
            def_ref: "run_test".to_string(),
            input_ref: "run_test".to_string(),
            vars_ref: Some("run_test".to_string()),
            state_keys_map: BTreeMap::new(),
            stream_ids: Vec::new(),
            queue_receipts: Vec::new(),
            nodes: BTreeMap::new(),
            fanout_src: BTreeMap::new(),
            result_ref: None,
            result_error: None,
            notify: None,
            caller_session_id: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn done_cp() -> NodeCheckpoint {
        NodeCheckpoint {
            state: NodeState::Done,
            session_id: None,
            turn_id: None,
            result_ref: None,
            result_error: None,
            pending_at: None,
            pending_timeout_ms: None,
            retries: 0,
            completed_at: None,
            worker_name: None,
        }
    }

    #[test]
    fn prune_selection_keeps_default_memory_result_for_output_node_until_finalize() {
        // Single-node workflow: output node result must stay available for finalize.
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "plan".to_string(),
            NodeDef {
                label: None,
                function: FunctionSpec {
                    id: "plan_function".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                },
                input: InputSpec {
                    from: "run_input".into(),
                    template: None,
                    value: None,
                },
                depends_on: vec![],
                fanout: None,
                result: None, // default = memory
                input_policy: None,
            },
        );

        let def = WorkflowDef {
            version: 1,
            nodes,
            output: OutputRef {
                from: "node:plan".to_string(),
            },
            default_functions: None,
            metadata: None,
        };

        let mut record = fresh_record();
        record.nodes.insert(
            "plan".to_string(),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: Some("run_test/plan".to_string()),
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: Some(1),
                worker_name: None,
            },
        );

        let to_prune = collect_prunable_memory_result_uids(&def, &record);
        assert!(
            to_prune.is_empty(),
            "output node memory result must not be pruned before finalize"
        );
    }

    #[test]
    fn run_input_liveness_depends_on_active_source_kinds() {
        let mut def = three_node_def();
        let mut record = fresh_record();

        record.nodes.insert(
            "plan".to_string(),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: Some("run_test/plan".to_string()),
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: Some(1),
                worker_name: None,
            },
        );

        assert!(
            !run_input_required_by_active_nodes(&def, &record),
            "active nodes currently read fanout_item/node refs only, so run_input is releasable"
        );

        if let Some(read) = def.nodes.get_mut("read") {
            read.input = InputSpec {
                from: "run_input".into(),
                template: None,
                value: None,
            };
        }

        assert!(
            run_input_required_by_active_nodes(&def, &record),
            "an active node reading run_input must keep run_input in memory"
        );

        if let Some(read) = def.nodes.get_mut("read") {
            read.input = InputSpec {
                from: "node:plan".into(),
                template: None,
                value: None,
            };
        }

        assert!(
            !run_input_required_by_active_nodes(&def, &record),
            "when all active nodes read only node:* refs, run input can be released"
        );
    }

    #[test]
    fn run_input_liveness_ignores_value_driven_nodes() {
        let mut def = three_node_def();
        let mut record = fresh_record();

        record.nodes.insert(
            "plan".to_string(),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: Some("run_test/plan".to_string()),
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: Some(1),
                worker_name: None,
            },
        );

        if let Some(read) = def.nodes.get_mut("read") {
            read.input = InputSpec {
                from: "run_input".into(),
                template: None,
                value: Some(json!({ "text": "literal" })),
            };
        }

        assert!(
            !run_input_required_by_active_nodes(&def, &record),
            "value-driven nodes should not pin run_input memory"
        );
    }

    #[test]
    fn releasable_fanout_memory_nodes_only_after_group_terminal() {
        let def = three_node_def();
        let mut record = fresh_record();
        record.fanout_src.insert("read".to_string(), 2);

        record.nodes.insert(
            "read#0".to_string(),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: Some("run_test/read#0".to_string()),
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: Some(1),
                worker_name: None,
            },
        );
        record.nodes.insert(
            "read#1".to_string(),
            NodeCheckpoint {
                state: NodeState::Running,
                session_id: None,
                turn_id: None,
                result_ref: None,
                result_error: None,
                pending_at: Some(1),
                pending_timeout_ms: None,
                retries: 0,
                completed_at: None,
                worker_name: None,
            },
        );

        assert!(
            releasable_fanout_memory_nodes(&def, &record).is_empty(),
            "fanout items must not be released while any item in group is active"
        );

        if let Some(cp) = record.nodes.get_mut("read#1") {
            cp.state = NodeState::Done;
            cp.completed_at = Some(2);
            cp.result_ref = Some("run_test/read#1".to_string());
        }

        assert_eq!(
            releasable_fanout_memory_nodes(&def, &record),
            vec!["read".to_string()],
            "fanout items become releasable once the full group is terminal"
        );
    }

    #[test]
    fn prune_selection_keeps_store_mode_results() {
        let mut def = three_node_def();
        if let Some(plan) = def.nodes.get_mut("plan") {
            plan.result = Some(NodeResultSpec {
                return_type: NodeResultReturnType::Store,
                stream_chunk_size: None,
                on_memory_fail: None,
            });
        }

        let mut record = fresh_record();
        record.nodes.insert(
            "plan".to_string(),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: Some("run_test/plan".to_string()),
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: Some(1),
                worker_name: None,
            },
        );

        let to_prune = collect_prunable_memory_result_uids(&def, &record);
        assert!(to_prune.is_empty(), "store results must stay durable");
    }

    #[test]
    fn prune_selection_keeps_memory_with_store_fallback() {
        let mut def = three_node_def();
        if let Some(plan) = def.nodes.get_mut("plan") {
            plan.result = Some(NodeResultSpec {
                return_type: NodeResultReturnType::Memory,
                stream_chunk_size: None,
                on_memory_fail: Some(NodeMemoryFailPolicy::Store),
            });
        }

        let mut record = fresh_record();
        record.nodes.insert(
            "plan".to_string(),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: Some("run_test/plan".to_string()),
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: Some(1),
                worker_name: None,
            },
        );

        let to_prune = collect_prunable_memory_result_uids(&def, &record);
        assert!(
            to_prune.is_empty(),
            "memory+onMemoryFail=store must be treated as durable"
        );
    }

    #[test]
    fn prune_selection_keeps_results_required_by_active_nodes() {
        let def = three_node_def();

        let mut record = fresh_record();
        record.nodes.insert(
            "plan".to_string(),
            NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: Some("run_test/plan".to_string()),
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: Some(1),
                worker_name: None,
            },
        );
        record.nodes.insert(
            "read#0".to_string(),
            NodeCheckpoint {
                state: NodeState::Running,
                session_id: None,
                turn_id: None,
                result_ref: None,
                result_error: None,
                pending_at: Some(1),
                pending_timeout_ms: None,
                retries: 0,
                completed_at: None,
                worker_name: None,
            },
        );
        record.fanout_src.insert("read".to_string(), 1);

        let to_prune = collect_prunable_memory_result_uids(&def, &record);
        assert!(
            to_prune.is_empty(),
            "must not prune when downstream nodes still depend on the result"
        );
    }

    // -----------------------------------------------------------------------
    // RED → GREEN tests for `decide`
    // -----------------------------------------------------------------------

    /// abort=true + ready frontier present → Finalize(Cancelled). Abort wins.
    #[test]
    fn decide_abort_finalizes_cancelled() {
        let def = three_node_def();
        let mut record = fresh_record();
        // Mark abort AND leave plan in the ready frontier.
        record.abort = true;

        // Sanity: ready_frontier returns ["plan"] without abort.
        let frontier = dag::ready_frontier(&def, &record);
        assert_eq!(frontier, vec!["plan".to_string()], "plan should be ready");

        match decide(&def, &record) {
            TickDecision::Finalize(RunStatus::Cancelled) => {}
            other => panic!("expected Finalize(Cancelled), got {:?}", other),
        }
    }

    /// Fresh 3-node record → Fire(["plan"]).
    #[test]
    fn decide_fires_root_then_parks() {
        let def = three_node_def();
        let record = fresh_record();

        match decide(&def, &record) {
            TickDecision::Fire(uids) => {
                assert_eq!(uids, vec!["plan".to_string()], "should fire plan first");
            }
            other => panic!("expected Fire([\"plan\"]), got {:?}", other),
        }
    }

    /// All nodes done → Finalize(Completed).
    #[test]
    fn decide_finalizes_when_completed() {
        let def = three_node_def();
        let mut record = fresh_record();
        record.nodes.insert("plan".into(), done_cp());
        // Expand read fanout with 1 item.
        record.fanout_src.insert("read".into(), 1);
        record.nodes.insert("read#0".into(), done_cp());
        record.nodes.insert("synthesize".into(), done_cp());

        match decide(&def, &record) {
            TickDecision::Finalize(RunStatus::Completed) => {}
            other => panic!("expected Finalize(Completed), got {:?}", other),
        }
    }

    /// No ready nodes (plan is Running) → Park.
    #[test]
    fn decide_parks_when_nothing_ready() {
        let def = three_node_def();
        let mut record = fresh_record();
        record.nodes.insert(
            "plan".into(),
            NodeCheckpoint {
                state: NodeState::Running,
                session_id: None,
                turn_id: None,
                result_ref: None,
                result_error: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: None,
                worker_name: None,
            },
        );

        match decide(&def, &record) {
            TickDecision::Park => {}
            other => panic!("expected Park, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // tick_is_stale — the crash-resume / at-least-once redelivery guard.
    // -----------------------------------------------------------------------

    #[test]
    fn tick_is_stale_below_floor_not_at_or_above() {
        // A re-delivered tick below the monotonic dequeue floor is skipped.
        assert!(tick_is_stale(0, 1, false));
        assert!(tick_is_stale(4, 5, false));
        // Strict `<`: a duplicate tick AT the floor still runs (idempotent re-pass),
        // and a fresh tick above the floor runs.
        assert!(!tick_is_stale(5, 5, false));
        assert!(!tick_is_stale(6, 5, false));
    }

    #[test]
    fn tick_is_stale_when_terminal_regardless_of_step() {
        // Once the run is terminal, NO tick re-runs finalize — this is what stops a
        // re-delivered tick from re-emitting notify + double telemetry.
        assert!(tick_is_stale(99, 0, true));
        assert!(tick_is_stale(0, 0, true));
    }

    // -----------------------------------------------------------------------
    // cancel_running_checkpoints — terminal run reflects the stop cascade.
    // -----------------------------------------------------------------------

    #[test]
    fn cancel_running_checkpoints_flips_only_running() {
        let mut nodes: BTreeMap<String, NodeCheckpoint> = BTreeMap::new();
        let mut running = done_cp();
        running.state = NodeState::Running;
        nodes.insert("live".into(), running);
        nodes.insert("done".into(), done_cp());
        nodes.insert("failed".into(), failed_cp(Some("boom")));

        cancel_running_checkpoints(&mut nodes);

        assert_eq!(nodes["live"].state, NodeState::Cancelled);
        assert_eq!(nodes["done"].state, NodeState::Done); // untouched
        assert_eq!(nodes["failed"].state, NodeState::Failed); // untouched
    }

    // -----------------------------------------------------------------------
    // summarize_failure — the "failed to run" diagnosability gap: a node failed
    // with "no provider registered for model claude-sonnet-4-5" but `notify` /
    // workflow::status returned result_error: null and showed a bare "failed".
    // -----------------------------------------------------------------------

    fn failed_cp(err: Option<&str>) -> NodeCheckpoint {
        NodeCheckpoint {
            state: NodeState::Failed,
            session_id: None,
            turn_id: None,
            result_ref: None,
            result_error: err.map(|s| s.to_string()),
            pending_at: None,
            pending_timeout_ms: None,
            retries: 0,
            completed_at: None,
            worker_name: None,
        }
    }

    #[test]
    fn summarize_failure_reports_node_error() {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "researcher".to_string(),
            failed_cp(Some("no provider registered for model claude-sonnet-4-5")),
        );
        nodes.insert("writer".to_string(), done_cp()); // Done nodes are ignored
        let got = summarize_failure(&nodes).expect("a failure summary");
        assert_eq!(
            got,
            "node 'researcher': no provider registered for model claude-sonnet-4-5"
        );
    }

    #[test]
    fn summarize_failure_joins_multiple_and_handles_missing_detail() {
        let mut nodes = BTreeMap::new();
        nodes.insert("a".to_string(), failed_cp(Some("boom")));
        nodes.insert("b".to_string(), failed_cp(None));
        assert_eq!(
            summarize_failure(&nodes),
            Some("node 'a': boom; node 'b' failed".to_string())
        );
    }

    #[test]
    fn summarize_failure_none_when_nothing_failed() {
        let mut nodes = BTreeMap::new();
        nodes.insert("a".to_string(), done_cp());
        assert_eq!(summarize_failure(&nodes), None);
    }

    #[test]
    fn dispatch_queue_for_uses_configured_queue() {
        let function = FunctionSpec {
            id: "fn::critical".to_string(),
            timeout_ms: None,
            queue: Some("critical".to_string()),
            engine_retry: None,
            runtime: None,
        };

        assert_eq!(dispatch_queue_for(&function), "critical");
    }

    #[test]
    fn dispatch_queue_for_falls_back_to_default() {
        let none = FunctionSpec {
            id: "fn::none".to_string(),
            timeout_ms: None,
            queue: None,
            engine_retry: None,
            runtime: None,
        };
        let empty = FunctionSpec {
            id: "fn::empty".to_string(),
            timeout_ms: None,
            queue: Some("   ".to_string()),
            engine_retry: None,
            runtime: None,
        };

        assert_eq!(dispatch_queue_for(&none), "default");
        assert_eq!(dispatch_queue_for(&empty), "default");
    }

    #[test]
    fn effective_pending_timeout_prefers_prior_then_function_then_dispatch() {
        assert_eq!(
            effective_pending_timeout_ms(Some(5_000), Some(10_000), 30_000),
            Some(5_000)
        );
        assert_eq!(
            effective_pending_timeout_ms(None, Some(10_000), 30_000),
            Some(10_000)
        );
        assert_eq!(
            effective_pending_timeout_ms(None, None, 30_000),
            Some(30_000)
        );
    }

    #[test]
    fn parked_run_is_stuck_without_running_nodes() {
        let record = fresh_record();
        assert!(parked_run_is_stuck(&record));
    }

    #[test]
    fn parked_run_is_not_stuck_with_running_nodes() {
        let mut record = fresh_record();
        record.nodes.insert(
            "plan".to_string(),
            NodeCheckpoint {
                state: NodeState::Running,
                session_id: Some("wf_run_test_plan".to_string()),
                turn_id: Some("turn_plan".to_string()),
                result_ref: None,
                result_error: None,
                pending_at: Some(1),
                pending_timeout_ms: Some(10_000),
                retries: 0,
                completed_at: None,
                worker_name: None,
            },
        );

        assert!(!parked_run_is_stuck(&record));
    }

    #[test]
    fn resolve_node_input_fanout_chain_uses_matching_dep_item() {
        let mut def = three_node_def();

        // Override read as fanout over plan docs and synthesize as fanout over same docs,
        // reading each matching read#i item via input.from = node:read.
        if let Some(read) = def.nodes.get_mut("read") {
            read.fanout = Some(FanoutSpec {
                over: "node:plan.result.docs".to_string(),
                mode: None,
                item_return_type: None,
            });
            read.input = InputSpec {
                from: "fanout_item".into(),
                template: None,
                value: None,
            };
        }
        if let Some(synth) = def.nodes.get_mut("synthesize") {
            synth.fanout = Some(FanoutSpec {
                over: "node:plan.result.docs".to_string(),
                mode: None,
                item_return_type: None,
            });
            synth.input = InputSpec {
                from: "node:read".into(),
                template: None,
                value: None,
            };
        }

        let mut record = fresh_record();
        record
            .fanout_src
            .insert("synthesize".to_string(), 2);

        let mut results: BTreeMap<String, Value> = BTreeMap::new();
        results.insert("read#0".to_string(), json!({ "summary": "A" }));
        results.insert("read#1".to_string(), json!({ "summary": "B" }));

        let node = def
            .nodes
            .get("synthesize")
            .expect("synthesize node present");
        let val = resolve_node_input(
            &def,
            &record,
            &json!({"topic": "rust"}),
            "synthesize#1",
            "synthesize",
            node,
            Some(&json!("b")),
            &results,
        );

        assert_eq!(val, json!({ "summary": "B" }));
    }

    #[test]
    fn resolve_node_input_falls_back_when_dep_is_not_fanout() {
        let def = three_node_def();
        let mut record = fresh_record();
        record
            .fanout_src
            .insert("read".to_string(), 1);

        let mut results: BTreeMap<String, Value> = BTreeMap::new();
        results.insert("plan".to_string(), json!({ "docs": ["x"] }));
        results.insert("read#0".to_string(), json!({ "summary": "X" }));

        // synthesize#0 reads node:read, but dep fanout behavior for this non-fanout node
        // should fall back to gather_input and return array of read child results.
        let node = def
            .nodes
            .get("synthesize")
            .expect("synthesize node present");
        let val = resolve_node_input(
            &def,
            &record,
            &json!({"topic": "rust"}),
            "synthesize#0",
            "synthesize",
            node,
            Some(&json!("x")),
            &results,
        );

        assert_eq!(val, json!([{ "summary": "X" }]));
    }

    #[test]
    fn fanout_item_mode_defaults_to_memory() {
        let def = three_node_def();
        assert_eq!(fanout_item_mode(&def, "read"), NodeInputReturnType::Memory);
    }

    #[test]
    fn fanout_item_mode_honors_store_override() {
        let mut def = three_node_def();
        if let Some(read) = def.nodes.get_mut("read") {
            if let Some(fanout) = read.fanout.as_mut() {
                fanout.item_return_type = Some(NodeInputReturnType::Store);
            }
        }

        assert_eq!(fanout_item_mode(&def, "read"), NodeInputReturnType::Store);
    }

    #[test]
    fn compute_delta_tracks_set_and_unset_paths() {
        let prev = json!({
            "active": true,
            "nested": {
                "a": 1,
                "b": 2
            },
            "removed": "bye"
        });
        let next = json!({
            "active": false,
            "nested": {
                "a": 42,
                "c": 3
            }
        });

        let delta = compute_delta(&prev, &next);

        assert_eq!(delta.set.get("active"), Some(&json!(false)));
        assert_eq!(delta.set.get("nested.a"), Some(&json!(42)));
        assert_eq!(delta.set.get("nested.c"), Some(&json!(3)));
        assert!(delta.unset.contains(&"nested.b".to_string()));
        assert!(delta.unset.contains(&"removed".to_string()));
    }

    #[test]
    fn apply_delta_rebuilds_target_state() {
        let prev = json!({
            "a": 1,
            "nested": {
                "x": 1,
                "y": 2
            }
        });
        let target = json!({
            "a": 2,
            "nested": {
                "x": 1,
                "z": 3
            }
        });

        let delta = compute_delta(&prev, &target);
        let rebuilt = apply_delta(&prev, &delta);

        assert_eq!(rebuilt, target);
    }

    #[test]
    fn var_checkpoint_policy_skips_early_versions_by_default() {
        let cfg = crate::config::WorkerConfig::default();
        assert!(!should_store_var_checkpoint(&cfg, 1));
        assert!(!should_store_var_checkpoint(&cfg, 24));
        assert!(should_store_var_checkpoint(&cfg, 25));
        assert!(should_store_var_checkpoint(&cfg, 50));
    }

    #[test]
    fn var_checkpoint_policy_can_be_disabled() {
        let mut cfg = crate::config::WorkerConfig::default();
        cfg.var_checkpoint_every_versions = 0;
        assert!(!should_store_var_checkpoint(&cfg, 25));
        assert!(!should_store_var_checkpoint(&cfg, 250));
    }
}
