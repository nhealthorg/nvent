use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::Value;

use crate::ids::node_uid;
use crate::types::{
    FanoutMode, IfBranchPath, IfCheckpoint, IfPredicate, IfState, NodeCheckpoint, NodeDef,
    NodeState, ReduceCheckpoint, ReduceState, RunStatus, WorkflowDef, WorkflowRunRecord,
};

// ponytail: generous cap so a runaway `over` array can't materialize unbounded
// per-item state/sessions; tighten if abused.
const MAX_FANOUT_ITEMS: usize = 10_000;

// Per-RUN ceiling on total materialized node sessions. MAX_FANOUT_ITEMS bounds a
// SINGLE fanout, but multiple/chained fanouts multiply (10k × N could reach 100M),
// and the `over` array is LLM-controlled. This caps the product so one run can't
// fan out into a resource bomb (each item is a harness session + a checkpoint
// stored in the run's single JSON record). Safety ceiling, not a tuning knob.
const MAX_TOTAL_NODES: usize = 50_000;
const DEFAULT_FANOUT_BATCH_SIZE: usize = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Returns a zeroed-out Pending checkpoint (caller sets node_uid as the map key).
fn pending_checkpoint() -> NodeCheckpoint {
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
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Returns the materialized uids for a fanned-out node, e.g. `["read#0","read#1"]`,
/// in NUMERIC (not lexical) order. Returns an empty vec if the node has not yet been
/// expanded (i.e. `record.fanout_src` has no entry for `node_id`).
pub fn fanned_uids(record: &WorkflowRunRecord, node_id: &str) -> Vec<String> {
    match record.fanout_src.get(node_id) {
        None => vec![],
        Some(total_items) => (0..*total_items)
            .map(|i| node_uid(node_id, Some(i as u32)))
            .collect(),
    }
}

/// JSON value kind, for diagnostics.
fn json_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Resolve an `over` path like `"node:plan.result.docs"` against a prefetched results map
/// (node_uid → that node's result Value).
///
/// Protocol:
/// 1. Strip the `"node:"` prefix; everything that follows is a dotted path.
/// 2. The first segment is the node_id — look it up in `results`.
/// 3. Skip a literal `"result"` segment (the next one after the node_id).
/// 4. Walk the remaining segments into the JSON tree.
/// 5. Return the value only if it is an array (`Value::Array`).
///
/// On failure returns `Err(<reason>)` that NAMES the actual problem (missing node,
/// missing key with the keys that ARE present, a non-object on the way down, or a
/// non-array leaf) — never a misleading size-cap phrasing.
pub fn resolve_over_path(
    over: &str,
    results: &BTreeMap<String, Value>,
) -> Result<Vec<Value>, String> {
    let path = over
        .strip_prefix("node:")
        .ok_or_else(|| "path must start with \"node:\"".to_string())?;

    let parts = path.splitn(2, '.').collect::<Vec<_>>();
    let node_id = parts[0];

    let root = results
        .get(node_id)
        .ok_or_else(|| format!("node '{node_id}' has no result in scope"))?
        .clone();

    let rest = if parts.len() > 1 { parts[1] } else { "" };
    let segments: Vec<&str> = rest.split('.').filter(|s| !s.is_empty()).collect();

    // Skip the literal "result" segment (first of the remaining segments).
    let walk_segments: &[&str] = if segments.first() == Some(&"result") {
        &segments[1..]
    } else {
        &segments[..]
    };

    let mut cur = root;
    for seg in walk_segments {
        match cur {
            Value::Object(mut map) => {
                cur = map.remove(*seg).ok_or_else(|| {
                    let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
                    keys.sort();
                    format!(
                        "path segment '{seg}' missing; node '{node_id}' produced keys: {{{}}}",
                        keys.join(", ")
                    )
                })?;
            }
            other => {
                return Err(format!(
                    "path segment '{seg}' cannot be resolved: parent value is {} (not an object)",
                    json_type_name(&other)
                ));
            }
        }
    }

    match cur {
        Value::Array(arr) => Ok(arr),
        other => Err(format!(
            "value at path is {} (not an array)",
            json_type_name(&other)
        )),
    }
}

/// Resolve a reduce source whose `over` points at a fanout node. Fanout item
/// results are persisted under `<node>#<index>`, so expose them as an ordered
/// array under the base node before applying the regular path resolution.
pub fn resolve_reduce_over_path(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    over: &str,
    results: &BTreeMap<String, Value>,
) -> Result<Vec<Value>, String> {
    let Some(path) = over.strip_prefix("node:") else {
        return resolve_over_path(over, results);
    };
    let node_id = path.split('.').next().unwrap_or(path);
    let Some(node) = def.nodes.get(node_id) else {
        return resolve_over_path(over, results);
    };
    if node.fanout.is_none() || results.contains_key(node_id) {
        return resolve_over_path(over, results);
    }

    let Some(total_items) = record.fanout_src.get(node_id) else {
        return Err(format!("fanout node '{node_id}' has not been expanded"));
    };
    let mut item_results = Vec::with_capacity(*total_items);
    for index in 0..*total_items {
        let uid = node_uid(node_id, Some(index as u32));
        let Some(value) = results.get(&uid) else {
            let checkpoint = record.nodes.get(&uid);
            tracing::warn!(
                workflow = ?record.workflow_name,
                node = %node_id,
                fanout_index = index,
                node_uid = %uid,
                child_run_id = ?checkpoint.and_then(|cp| cp.child_run_id.as_deref()),
                result_store_key = ?checkpoint.and_then(|cp| cp.result_ref.as_deref()),
                result_state = ?checkpoint.map(|cp| cp.state),
                resolved_value = "null",
                "fanout item result is missing while resolving reduce input"
            );
            return Err(format!(
                "fanout node '{node_id}' item {index} has no result"
            ));
        };
        item_results.push(value.clone());
    }

    let mut resolved = results.clone();
    resolved.insert(node_id.to_string(), Value::Array(item_results));
    resolve_over_path(over, &resolved)
}

/// For each fanout node in `def` whose dependencies are Done and which has not yet been
/// expanded (no entry in `record.fanout_src`), store the item COUNT in
/// `record.fanout_src[node_id]` and insert a `Pending` `NodeCheckpoint` for each
/// `node_uid(node_id, Some(i))`.
///
/// Returns the list of expanded `node_id`s (not uids).  Caller is responsible for
/// persisting the record once.
pub fn expand_ready_fanouts(
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
    results: &BTreeMap<String, Value>,
) -> Vec<String> {
    let mut expanded = Vec::new();

    // Collect candidates first to avoid borrow-checker issues on `record`.
    let candidates: Vec<(&str, &NodeDef)> = def
        .nodes
        .iter()
        .filter_map(|(id, node_def)| {
            if node_def.fanout.is_some() && !record.fanout_src.contains_key(id.as_str()) {
                Some((id.as_str(), node_def))
            } else {
                None
            }
        })
        .collect();

    for (node_id, node_def) in candidates {
        let fanout_spec = node_def.fanout.as_ref().unwrap();

        // Expansion readiness is driven by `fanout.over` source availability, not
        // by the full depends_on barrier. This allows downstream fanout nodes in a
        // loop pipeline to materialize their #i checkpoints early, so readiness can
        // be decided item-wise (`dep#i -> curr#i`) instead of waiting for all dep#*.
        let over_source_ready = fanout_spec
            .over
            .strip_prefix("node:")
            .and_then(|path| path.split('.').next())
            .map(|source_node_id| results.contains_key(source_node_id))
            .unwrap_or_else(|| deps_done(def, record, node_id));

        if !over_source_ready {
            continue;
        }

        // Resolve the over path. The source is Done; if `over` doesn't resolve
        // to an array (missing path / wrong shape) or is oversized, the fanout
        // can never expand — fail it fast (base-id Failed checkpoint) so the run
        // fails instead of parking in AwaitingNodes forever.
        let items = match resolve_over_path(&fanout_spec.over, results) {
            Ok(v) if v.len() <= MAX_FANOUT_ITEMS => v,
            outcome => {
                // Two distinct failures, each with an honest message:
                // - the path didn't resolve to an array (structural: names what was there)
                // - the array is genuinely oversize (the cap, stated as a cap)
                let reason = match outcome {
                    Ok(v) => format!(
                        "fanout '{}' over '{}': array has {} items, exceeds the cap of {}",
                        node_id,
                        fanout_spec.over,
                        v.len(),
                        MAX_FANOUT_ITEMS
                    ),
                    Err(detail) => {
                        format!(
                            "fanout '{}' over '{}': {}",
                            node_id, fanout_spec.over, detail
                        )
                    }
                };
                record.fanout_src.insert(node_id.to_string(), 0);
                let mut cp = pending_checkpoint();
                cp.state = NodeState::Failed;
                cp.result_error = Some(reason);
                record.nodes.insert(node_id.to_string(), cp);
                expanded.push(node_id.to_string());
                continue;
            }
        };

        // Run-wide cap: the per-node MAX_FANOUT_ITEMS bounds ONE fanout, but
        // chained/multiple fanouts multiply. Fail the fanout (base-id Failed, same
        // as the oversize path) if expanding it would push the run past the total
        // materialized-node ceiling, so an LLM-controlled `over` can't blow up the
        // record / spawn a session storm.
        if record.nodes.len() + items.len() > MAX_TOTAL_NODES {
            record.fanout_src.insert(node_id.to_string(), 0);
            let mut cp = pending_checkpoint();
            cp.state = NodeState::Failed;
            cp.result_error = Some(format!(
                "fanout '{}' over '{}': expanding {} items would exceed the run-wide cap of {} \
                 materialized nodes",
                node_id,
                fanout_spec.over,
                items.len(),
                MAX_TOTAL_NODES
            ));
            record.nodes.insert(node_id.to_string(), cp);
            expanded.push(node_id.to_string());
            continue;
        }

        // Atomically snapshot + insert Pending checkpoints.
        let n = items.len();
        record.fanout_src.insert(node_id.to_string(), n);
        for i in 0..n {
            let uid = node_uid(node_id, Some(i as u32));
            record.nodes.entry(uid).or_insert_with(pending_checkpoint);
        }

        expanded.push(node_id.to_string());
    }

    expanded
}

/// Initializes each reduce whose source result is available.
///
/// Only the source cardinality and the initial accumulator are persisted here.
/// Iteration execution is deliberately handled by the reduce scheduler, so a
/// redelivered tick cannot re-resolve or replace an existing checkpoint.
pub fn initialize_ready_reductions(
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
    results: &BTreeMap<String, Value>,
) -> Vec<String> {
    let candidates: Vec<(&str, &NodeDef)> = def
        .nodes
        .iter()
        .filter_map(|(id, node_def)| {
            if node_def.reduce.is_some() && !record.reduce_checkpoints.contains_key(id.as_str()) {
                Some((id.as_str(), node_def))
            } else {
                None
            }
        })
        .collect();

    let mut initialized = Vec::new();
    for (node_id, node_def) in candidates {
        let reduce = node_def.reduce.as_ref().expect("candidate has reduce spec");
        let source_node_id = reduce
            .over
            .strip_prefix("node:")
            .and_then(|path| path.split('.').next())
            .unwrap_or_default();

        let source_is_fanout = def
            .nodes
            .get(source_node_id)
            .and_then(|node| node.fanout.as_ref())
            .is_some();
        if source_is_fanout {
            let Some(total_items) = record.fanout_src.get(source_node_id) else {
                continue;
            };
            if (0..*total_items)
                .any(|index| !results.contains_key(&node_uid(source_node_id, Some(index as u32))))
            {
                continue;
            }
        }

        if !source_node_id.is_empty() && !results.contains_key(source_node_id) && !source_is_fanout
        {
            continue;
        }
        if source_node_id.is_empty() && !deps_done(def, record, node_id) {
            continue;
        }

        match resolve_reduce_over_path(def, record, &reduce.over, results) {
            Ok(items) => {
                record.reduce_checkpoints.insert(
                    node_id.to_string(),
                    ReduceCheckpoint {
                        next_index: 0,
                        total_items: items.len(),
                        accumulator: reduce.initial.clone(),
                        state: ReduceState::Pending,
                        active_body_uids: Vec::new(),
                        error: None,
                    },
                );
                initialized.push(node_id.to_string());
            }
            Err(detail) => {
                record.reduce_checkpoints.insert(
                    node_id.to_string(),
                    ReduceCheckpoint {
                        next_index: 0,
                        total_items: 0,
                        accumulator: reduce.initial.clone(),
                        state: ReduceState::Failed,
                        active_body_uids: Vec::new(),
                        error: Some(format!(
                            "reduce '{}' over '{}': {detail}",
                            node_id, reduce.over
                        )),
                    },
                );
                initialized.push(node_id.to_string());
            }
        }
    }

    initialized
}

fn if_value_at_path(value: &Value, path: &[String]) -> Value {
    let mut current = value;
    for segment in path {
        current = match current {
            Value::Object(map) => map.get(segment).unwrap_or(&Value::Null),
            Value::Array(items) => segment
                .parse::<usize>()
                .ok()
                .and_then(|index| items.get(index))
                .unwrap_or(&Value::Null),
            _ => return Value::Null,
        };
    }
    current.clone()
}

fn if_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().map(|number| number != 0.0).unwrap_or(false),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

fn if_operand_value(value: &Value, results: &BTreeMap<String, Value>, run_input: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    let Some(reference) = object.get("$ref").and_then(Value::as_str) else {
        return value.clone();
    };
    let resolved = if reference == "run_input" {
        run_input.clone()
    } else {
        let source = reference.strip_prefix("node:").unwrap_or(reference);
        results.get(source).cloned().unwrap_or(Value::Null)
    };
    let path = object
        .get("$path")
        .and_then(Value::as_array)
        .map(|segments| {
            segments
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if_value_at_path(&resolved, &path)
}

fn if_predicate_matches(
    predicate: &IfPredicate,
    results: &BTreeMap<String, Value>,
    run_input: &Value,
) -> bool {
    let numeric_compare = |left: &Value, right: &Value, compare: fn(f64, f64) -> bool| match (
        if_operand_value(left, results, run_input).as_f64(),
        if_operand_value(right, results, run_input).as_f64(),
    ) {
        (Some(left), Some(right)) => compare(left, right),
        _ => false,
    };

    match predicate {
        IfPredicate::Equals { left, right } => {
            if_operand_value(left, results, run_input)
                == if_operand_value(right, results, run_input)
        }
        IfPredicate::NotEquals { left, right } => {
            if_operand_value(left, results, run_input)
                != if_operand_value(right, results, run_input)
        }
        IfPredicate::Gt { left, right } => numeric_compare(left, right, |left, right| left > right),
        IfPredicate::Gte { left, right } => {
            numeric_compare(left, right, |left, right| left >= right)
        }
        IfPredicate::Lt { left, right } => numeric_compare(left, right, |left, right| left < right),
        IfPredicate::Lte { left, right } => {
            numeric_compare(left, right, |left, right| left <= right)
        }
        IfPredicate::And { args } => args
            .iter()
            .all(|arg| if_predicate_matches(arg, results, run_input)),
        IfPredicate::Or { args } => args
            .iter()
            .any(|arg| if_predicate_matches(arg, results, run_input)),
        IfPredicate::Not { arg } => !if_predicate_matches(arg, results, run_input),
    }
}

/// Evaluates each ready conditional exactly once and cancels the skipped path.
pub fn initialize_ready_ifs(
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
    results: &BTreeMap<String, Value>,
    run_input: &Value,
) -> Vec<String> {
    let candidates: Vec<String> = def
        .nodes
        .iter()
        .filter_map(|(id, node)| {
            (node.if_spec.is_some() && !record.if_checkpoints.contains_key(id))
                .then_some(id.clone())
        })
        .collect();
    let mut initialized = Vec::new();

    for node_id in candidates {
        let node = &def.nodes[&node_id];
        if !deps_done(def, record, &node_id) {
            continue;
        }
        let spec = node
            .if_spec
            .as_ref()
            .expect("conditional candidate has spec");
        let source = match &spec.source {
            Value::Bool(value) => Value::Bool(*value),
            Value::String(source) if source == "run_input" => run_input.clone(),
            Value::String(source) if source.starts_with("node:") => {
                let source_id = source.strip_prefix("node:").unwrap_or(source);
                results.get(source_id).cloned().unwrap_or(Value::Null)
            }
            value => value.clone(),
        };
        let selected = match &spec.predicate {
            Some(predicate) => if_predicate_matches(predicate, results, run_input),
            None => if_truthy(&if_value_at_path(&source, &spec.path)),
        };
        let selected_path = if selected {
            IfBranchPath::Then
        } else {
            IfBranchPath::Else
        };
        record.if_checkpoints.insert(
            node_id.clone(),
            IfCheckpoint {
                state: IfState::Done,
                selected: Some(selected_path),
                error: None,
            },
        );
        record
            .nodes
            .entry(node_id.clone())
            .and_modify(|checkpoint| {
                checkpoint.state = NodeState::Done;
            })
            .or_insert_with(|| NodeCheckpoint {
                state: NodeState::Done,
                session_id: None,
                turn_id: None,
                result_ref: None,
                result_error: None,
                child_run_id: None,
                pending_at: None,
                pending_timeout_ms: None,
                retries: 0,
                completed_at: None,
                worker_name: Some("workflow-internal-if".to_string()),
            });
        for (branch_id, branch_node) in def.nodes.iter() {
            if let Some(branch) = &branch_node.if_branch {
                if branch.if_node == node_id && branch.path != selected_path {
                    record.nodes.insert(
                        branch_id.clone(),
                        NodeCheckpoint {
                            state: NodeState::Cancelled,
                            session_id: None,
                            turn_id: None,
                            result_ref: None,
                            result_error: Some("conditional branch skipped".to_string()),
                            child_run_id: None,
                            pending_at: None,
                            pending_timeout_ms: None,
                            retries: 0,
                            completed_at: None,
                            worker_name: None,
                        },
                    );
                }
            }
        }
        initialized.push(node_id);
    }
    initialized
}

/// Materializes the body nodes for the current reduce index exactly once.
/// Body nodes remain hidden from the ordinary frontier until they are listed in
/// the reduce checkpoint's active set.
pub fn materialize_reduce_iterations(
    def: &WorkflowDef,
    record: &mut WorkflowRunRecord,
) -> Vec<String> {
    let reduce_ids: Vec<String> = record.reduce_checkpoints.keys().cloned().collect();
    let mut materialized = Vec::new();

    for reduce_id in reduce_ids {
        let Some(reduce_node) = def.nodes.get(&reduce_id) else {
            continue;
        };
        let Some(reduce) = reduce_node.reduce.as_ref() else {
            continue;
        };
        let Some(checkpoint) = record.reduce_checkpoints.get_mut(&reduce_id) else {
            continue;
        };
        if checkpoint.state != ReduceState::Pending
            || checkpoint.next_index >= checkpoint.total_items
            || !checkpoint.active_body_uids.is_empty()
        {
            continue;
        }

        let index = checkpoint.next_index;
        let mut body_uids = Vec::new();
        for body_id in &reduce.body {
            let uid = node_uid(body_id, Some(index as u32));
            record
                .nodes
                .entry(uid.clone())
                .or_insert_with(pending_checkpoint);
            body_uids.push(uid);
        }

        checkpoint.active_body_uids = body_uids.clone();
        checkpoint.state = ReduceState::Running;
        materialized.push(reduce_id);
    }

    materialized
}

/// Advances a completed sequential reduce iteration in memory.
///
/// The caller persists the resulting accumulator as the reduce node result.
/// Returning `None` keeps incomplete and failed iterations untouched, which is
/// important for retrying only the active body UIDs after a restart.
pub fn advance_reduce_checkpoint(
    checkpoint: &mut ReduceCheckpoint,
    body_results: &[Value],
) -> Option<Value> {
    if checkpoint.state != ReduceState::Running || checkpoint.active_body_uids.is_empty() {
        return None;
    }
    if body_results.iter().any(Value::is_null) {
        return None;
    }

    let next_accumulator = body_results
        .last()
        .cloned()
        .unwrap_or_else(|| checkpoint.accumulator.clone());
    checkpoint.next_index = checkpoint.next_index.saturating_add(1);
    checkpoint.accumulator = next_accumulator.clone();
    checkpoint.active_body_uids.clear();
    checkpoint.state = if checkpoint.next_index >= checkpoint.total_items {
        ReduceState::Done
    } else {
        ReduceState::Pending
    };
    Some(next_accumulator)
}

fn fanout_dep_item_done(record: &WorkflowRunRecord, dep_id: &str, item_idx: usize) -> bool {
    if matches!(
        record.nodes.get(dep_id).map(|c| c.state),
        Some(NodeState::Failed) | Some(NodeState::Cancelled)
    ) {
        return false;
    }

    let Some(total_items) = record.fanout_src.get(dep_id) else {
        return false;
    };

    if item_idx >= *total_items {
        return false;
    }

    let dep_uid = node_uid(dep_id, Some(item_idx as u32));
    checkpoint_done_with_result(record, &dep_uid)
}

fn checkpoint_done_with_result(record: &WorkflowRunRecord, node_uid: &str) -> bool {
    record.nodes.get(node_uid).is_some_and(|checkpoint| {
        checkpoint.state == NodeState::Done && checkpoint.result_ref.is_some()
    })
}

fn reduce_body_item_ready(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    node_id: &str,
) -> Vec<String> {
    let Some(body) = def
        .nodes
        .get(node_id)
        .and_then(|node| node.reduce_body.as_ref())
    else {
        return Vec::new();
    };
    let Some(checkpoint) = record.reduce_checkpoints.get(&body.reduce) else {
        return Vec::new();
    };
    let mut ready = Vec::new();
    for uid in &checkpoint.active_body_uids {
        if uid.split('#').next() != Some(node_id) {
            continue;
        }
        if record.nodes.get(uid).map(|cp| cp.state) != Some(NodeState::Pending) {
            continue;
        }
        let index = uid
            .split('#')
            .nth(1)
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let deps_ready = def
            .nodes
            .get(node_id)
            .map(|node| {
                node.depends_on.iter().all(|dep| {
                    if def
                        .nodes
                        .get(dep)
                        .and_then(|candidate| candidate.reduce_body.as_ref())
                        .is_some_and(|candidate| candidate.reduce == body.reduce)
                    {
                        checkpoint_done_with_result(record, &node_uid(dep, Some(index as u32)))
                    } else if def
                        .nodes
                        .get(dep)
                        .and_then(|candidate| candidate.fanout.as_ref())
                        .is_some()
                    {
                        fanout_dep_item_done(record, dep, index)
                    } else {
                        checkpoint_done_with_result(record, dep)
                    }
                })
            })
            .unwrap_or(false);
        if deps_ready {
            ready.push(uid.clone());
        }
    }
    ready
}

fn deps_done_for_fanout_item(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    node_id: &str,
    item_idx: usize,
) -> bool {
    let node_def = match def.nodes.get(node_id) {
        Some(n) => n,
        None => return false,
    };

    for dep_id in &node_def.depends_on {
        let dep_is_fanout = def
            .nodes
            .get(dep_id.as_str())
            .and_then(|n| n.fanout.as_ref())
            .is_some();

        if dep_is_fanout {
            if !fanout_dep_item_done(record, dep_id, item_idx) {
                return false;
            }
        } else {
            match record.nodes.get(dep_id.as_str()) {
                Some(cp) if cp.state == NodeState::Done => {}
                _ => return false,
            }
        }
    }

    true
}

fn same_ordered_fanout_group(def: &WorkflowDef, a: &str, b: &str, mode: FanoutMode) -> bool {
    if a == b {
        return true;
    }

    let Some(a_def) = def.nodes.get(a) else {
        return false;
    };
    let Some(b_def) = def.nodes.get(b) else {
        return false;
    };
    let Some(a_fanout) = a_def.fanout.as_ref() else {
        return false;
    };
    let Some(b_fanout) = b_def.fanout.as_ref() else {
        return false;
    };

    if a_fanout.mode != Some(mode) || b_fanout.mode != Some(mode) {
        return false;
    }

    if a_fanout.over != b_fanout.over {
        return false;
    }

    // Keep unrelated loops independent: only nodes connected by a dependency edge
    // are considered part of one sequential loop execution group.
    a_def.depends_on.iter().any(|dep| dep == b) || b_def.depends_on.iter().any(|dep| dep == a)
}

fn ordered_group_members(def: &WorkflowDef, seed: &str, mode: FanoutMode) -> Vec<String> {
    let mut out = Vec::new();
    let mut queue = vec![seed.to_string()];
    let mut seen = BTreeSet::new();

    while let Some(current) = queue.pop() {
        if !seen.insert(current.clone()) {
            continue;
        }
        out.push(current.clone());

        for candidate in def.nodes.keys() {
            if seen.contains(candidate) {
                continue;
            }
            if same_ordered_fanout_group(def, &current, candidate, mode) {
                queue.push(candidate.clone());
            }
        }
    }

    out.sort();
    out
}

fn ordered_group_active_index(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    seed: &str,
    mode: FanoutMode,
) -> Option<usize> {
    let members = ordered_group_members(def, seed, mode);
    if members.is_empty() {
        return None;
    }

    let mut max_len = 0usize;
    for member in &members {
        let len = record.fanout_src.get(member).copied().unwrap_or(0);
        max_len = max_len.max(len);
    }

    for idx in 0..max_len {
        let mut all_done = true;
        for member in &members {
            let uid = node_uid(member, Some(idx as u32));
            match record.nodes.get(&uid).map(|cp| cp.state) {
                Some(NodeState::Done) if checkpoint_done_with_result(record, &uid) => {}
                _ => {
                    all_done = false;
                    break;
                }
            }
        }
        if !all_done {
            return Some(idx);
        }
    }

    None
}

/// Returns `true` when every dependency of `node_id` is fully Done:
/// - For a normal (non-fanout) dependency: its checkpoint must be `NodeState::Done`.
/// - For a fanned-out dependency `dep_id`: the expansion must have occurred (entry in
///   `fanout_src`); an empty expansion is vacuously satisfied (0 items → 0..0 loop);
///   a non-empty expansion requires every `dep_id#i` checkpoint to be `NodeState::Done`.
///   An *un-expanded* fanout (no `fanout_src` entry) still blocks, as does a fanout that
///   FAILED to expand (a base-id `Failed`/`Cancelled` checkpoint).
pub fn deps_done(def: &WorkflowDef, record: &WorkflowRunRecord, node_id: &str) -> bool {
    let node_def = match def.nodes.get(node_id) {
        Some(n) => n,
        None => return false,
    };

    for dep_id in &node_def.depends_on {
        if def
            .nodes
            .get(dep_id)
            .and_then(|n| n.fanout.as_ref())
            .is_some()
        {
            // A base-id Failed/Cancelled checkpoint means the fanout FAILED to expand
            // (over path unresolvable / oversized / cap): `fanout_src` count is zero,
            // which the 0..0 loop below would otherwise read as vacuously Done. A failed
            // expansion must BLOCK its dependents (else an orphan-branch dependent fires
            // on Null input), not satisfy them. quiescence catches this for required
            // nodes; this covers orphan branches and the internal expand-time caller.
            if matches!(
                record.nodes.get(dep_id.as_str()).map(|c| c.state),
                Some(NodeState::Failed) | Some(NodeState::Cancelled)
            ) {
                return false;
            }
            // Fanned dependency: expansion must exist AND every #i must be Done.
            match record.fanout_src.get(dep_id.as_str()) {
                None => return false, // not yet expanded
                Some(total_items) => {
                    // Expanded-empty fanout (zero items) is vacuously Done — the 0..0 loop
                    // below satisfies the dependency. Only an *un-expanded* fanout (the `None`
                    // arm above) or a failed expansion (guard above) still blocks.
                    for i in 0..*total_items {
                        let uid = node_uid(dep_id, Some(i as u32));
                        match record.nodes.get(&uid) {
                            Some(cp) if cp.state == NodeState::Done && cp.result_ref.is_some() => {}
                            _ => return false,
                        }
                    }
                }
            }
        } else {
            // Normal dependency: checkpoint must be Done.
            match record.nodes.get(dep_id.as_str()) {
                Some(cp) if cp.state == NodeState::Done => {}
                Some(cp) if cp.state == NodeState::Cancelled => {
                    let skipped = def
                        .nodes
                        .get(dep_id)
                        .and_then(|node| node.if_branch.as_ref())
                        .and_then(|branch| {
                            record
                                .if_checkpoints
                                .get(&branch.if_node)
                                .map(|checkpoint| checkpoint.selected != Some(branch.path))
                        })
                        .unwrap_or(false);
                    if !skipped {
                        return false;
                    }
                }
                _ => return false,
            }
        }
    }

    true
}

/// Returns node uids that are not yet started and have all dependencies Done.
///
/// - For a fanout node that has been expanded: each materialized `#i` uid that is still
///   `Pending` (i.e. exists in `record.nodes` with state `Pending`).
/// - For a fanout node not yet expanded: skip (expansion happens first via
///   `expand_ready_fanouts`).
/// - For a normal node: the `node_id` itself if no checkpoint exists yet, or if it was
///   pre-initialized as `Pending` by `nworkflow::start` (still not started).
pub fn ready_frontier(def: &WorkflowDef, record: &WorkflowRunRecord) -> Vec<String> {
    let mut frontier = Vec::new();

    for (node_id, node_def) in &def.nodes {
        if node_def.reduce.is_some() {
            continue;
        }
        if node_def.if_spec.is_some() {
            continue;
        }
        // Reduce body nodes are materialized and scheduled by the reduce
        // controller, never as ordinary DAG roots.
        if node_def.reduce_body.is_some() {
            frontier.extend(reduce_body_item_ready(def, record, node_id));
            continue;
        }
        if let Some(branch) = &node_def.if_branch {
            let Some(checkpoint) = record.if_checkpoints.get(&branch.if_node) else {
                continue;
            };
            if checkpoint.selected != Some(branch.path) {
                continue;
            }
        }

        if node_def.fanout.is_some() {
            // Fanout node: only emit already-materialized Pending items.
            if let Some(total_items) = record.fanout_src.get(node_id.as_str()) {
                let sequential = matches!(
                    node_def.fanout.as_ref().and_then(|f| f.mode),
                    Some(FanoutMode::Sequential)
                );
                let batch = matches!(
                    node_def.fanout.as_ref().and_then(|f| f.mode),
                    Some(FanoutMode::Batch)
                );

                let active_index = if sequential {
                    ordered_group_active_index(
                        def,
                        record,
                        node_id.as_str(),
                        FanoutMode::Sequential,
                    )
                } else if batch {
                    ordered_group_active_index(def, record, node_id.as_str(), FanoutMode::Batch)
                } else {
                    None
                };

                if sequential {
                    // Only one item at a time: first pending item whose predecessors are Done.
                    for i in 0..*total_items {
                        let uid = node_uid(node_id, Some(i as u32));
                        let state = record.nodes.get(&uid).map(|cp| cp.state);

                        if state == Some(NodeState::Pending) {
                            if !deps_done_for_fanout_item(def, record, node_id, i) {
                                continue;
                            }

                            let prev_done = (0..i).all(|j| {
                                let prev_uid = node_uid(node_id, Some(j as u32));
                                matches!(
                                    record.nodes.get(&prev_uid).map(|cp| cp.state),
                                    Some(NodeState::Done)
                                )
                            });
                            let in_active_slice = active_index.map(|idx| idx == i).unwrap_or(true);
                            if prev_done && in_active_slice {
                                frontier.push(uid);
                            }
                            break;
                        }
                    }
                } else {
                    let fanout = node_def.fanout.as_ref();
                    if batch {
                        let batch_size = fanout
                            .and_then(|f| f.batch_size)
                            .filter(|v| *v > 0)
                            .unwrap_or(DEFAULT_FANOUT_BATCH_SIZE);
                        let start = active_index.unwrap_or(0);
                        let end = start.saturating_add(batch_size).min(*total_items);

                        for i in start..end {
                            let uid = node_uid(node_id, Some(i as u32));
                            if let Some(cp) = record.nodes.get(&uid) {
                                if cp.state == NodeState::Pending
                                    && deps_done_for_fanout_item(def, record, node_id, i)
                                {
                                    frontier.push(uid);
                                }
                            }
                        }
                    } else {
                        for i in 0..*total_items {
                            let uid = node_uid(node_id, Some(i as u32));
                            if let Some(cp) = record.nodes.get(&uid) {
                                if cp.state == NodeState::Pending
                                    && deps_done_for_fanout_item(def, record, node_id, i)
                                {
                                    frontier.push(uid);
                                }
                            }
                        }
                    }
                }
            }
        } else {
            // Normal node: ready if still unstarted (missing or Pending) and deps are done.
            let is_unstarted = match record.nodes.get(node_id.as_str()) {
                None => true,
                Some(cp) => cp.state == NodeState::Pending,
            };
            if is_unstarted && deps_done(def, record, node_id) {
                frontier.push(node_id.clone());
            }
        }
    }

    frontier
}

/// Build the input value for `node_id` by gathering results from its declared source.
///
/// - `input.from == "node:<dep>"` and `<dep>` is a FANOUT node → return a JSON array
///   `[results["<dep>#0"], results["<dep>#1"], …]` in strict NUMERIC order.
/// - `input.from == "node:<dep>"` and `<dep>` is a normal node → return that single
///   node's result, or `Value::Null` if not yet present.
/// - Any other `from` value (`run_input`, `literal`, `fanout_item`) → return
///   the run input value (template/dispatch layer handles substitution later).
pub fn gather_input(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    run_input: &Value,
    node_id: &str,
    results: &BTreeMap<String, Value>,
) -> Value {
    let node_def = match def.nodes.get(node_id) {
        Some(n) => n,
        None => return run_input.clone(),
    };

    match &node_def.input.from {
        crate::types::InputFrom::One(from) => gather_one(def, record, run_input, from, results),
        crate::types::InputFrom::Many(sources) => {
            // Join: gather each `node:<id>` into a field keyed by the dep id, so a
            // synthesis node can read every dependency it declared (a single
            // `from` could only deliver one — the silent-data-loss footgun).
            let mut obj = serde_json::Map::new();
            for src in sources {
                if let Some(dep) = src.strip_prefix("node:") {
                    let key = dep.split('.').next().unwrap_or(dep).to_string();
                    obj.insert(key, gather_one(def, record, run_input, src, results));
                }
                // Non-`node:` entries are rejected at nworkflow::start; ignore here.
            }
            Value::Object(obj)
        }
    }
}

/// Resolve a single `from` source against the results map (the per-source logic
/// shared by `One` and each element of `Many`).
fn gather_one(
    def: &WorkflowDef,
    record: &WorkflowRunRecord,
    run_input: &Value,
    from: &str,
    results: &BTreeMap<String, Value>,
) -> Value {
    if let Some(dep) = from.strip_prefix("node:") {
        // Check if dep is a fanout node.
        if def.nodes.get(dep).and_then(|n| n.fanout.as_ref()).is_some() {
            // Fan-in: iterate 0..N in NUMERIC order (not BTreeMap/lexical order).
            let n = fanned_uids(record, dep).len();
            let arr: Vec<Value> = (0..n)
                .map(|i| {
                    let uid = node_uid(dep, Some(i as u32));
                    match results.get(&uid).cloned() {
                        Some(value) => value,
                        None => {
                            let checkpoint = record.nodes.get(&uid);
                            tracing::warn!(
                                workflow = ?record.workflow_name,
                                node = %dep,
                                fanout_index = i,
                                node_uid = %uid,
                                child_run_id = ?checkpoint.and_then(|cp| cp.child_run_id.as_deref()),
                                result_store_key = ?checkpoint.and_then(|cp| cp.result_ref.as_deref()),
                                result_state = ?checkpoint.map(|cp| cp.state),
                                resolved_value = "null",
                                "fanout item result is missing while gathering node input"
                            );
                            Value::Null
                        }
                    }
                })
                .collect();
            Value::Array(arr)
        } else {
            // Normal node: return its single result.
            results.get(dep).cloned().unwrap_or(Value::Null)
        }
    } else {
        // run_input / literal / fanout_item → delegate to the template layer.
        run_input.clone()
    }
}

/// Compute the current quiescence state of a workflow run.
///
/// Evaluation order (first matching rule wins):
/// 1. `record.abort` → `Cancelled`
/// 2. Any declared node (or fanned item) is `Failed`/`Cancelled` → `Failed`
/// 3. Every declared node (and every `#i` of each fanned node) is `Done` → `Completed`
/// 4. Otherwise → `AwaitingNodes`
///
/// This preserves imperative workflow semantics from the JS DSL: if a step is
/// declared in the handler, it must run before the workflow can complete,
/// even when the returned output references an earlier node.
pub fn quiescence(def: &WorkflowDef, record: &WorkflowRunRecord) -> RunStatus {
    if record.abort {
        return RunStatus::Cancelled;
    }

    let mut all_done = true;
    for node_id in def.nodes.keys() {
        let Some(node_def) = def.nodes.get(node_id.as_str()) else {
            continue;
        };
        if node_def.reduce_body.is_some() {
            continue;
        }
        if node_def.if_branch.is_some()
            && record.nodes.get(node_id).map(|cp| cp.state) == Some(NodeState::Cancelled)
        {
            continue;
        }
        if node_def.reduce.is_some() {
            match record.reduce_checkpoints.get(node_id) {
                Some(checkpoint) if checkpoint.state == ReduceState::Done => {}
                Some(checkpoint) if checkpoint.state == ReduceState::Failed => {
                    return RunStatus::Failed;
                }
                _ => all_done = false,
            }
            continue;
        }
        let is_fanout = def
            .nodes
            .get(node_id.as_str())
            .map(|n| n.fanout.is_some())
            .unwrap_or(false);
        // Expand a node to the uids that actually carry state: a fanout
        // node contributes all its #i items, a normal node is itself.
        let uids = if is_fanout {
            fanned_uids(record, node_id.as_str())
        } else {
            vec![node_id.to_string()]
        };
        // A fanout that hasn't expanded yet is not done. An expanded-empty fanout
        // (fanout_src entry present, zero items) is vacuously Done, so only an *un-expanded*
        // fanout blocks completion.
        if is_fanout {
            if !record.fanout_src.contains_key(node_id.as_str()) {
                all_done = false;
                continue;
            }
            // A base-id Failed/Cancelled checkpoint marks a fanout that failed to
            // expand (over path unresolvable / oversized).
            if matches!(
                record.nodes.get(node_id.as_str()).map(|c| c.state),
                Some(NodeState::Failed) | Some(NodeState::Cancelled)
            ) {
                return RunStatus::Failed;
            }
        }
        for uid in uids {
            match record.nodes.get(&uid).map(|c| c.state) {
                Some(NodeState::Failed) | Some(NodeState::Cancelled) => return RunStatus::Failed,
                Some(NodeState::Done) => {}
                _ => all_done = false, // Pending / Running / unstarted
            }
        }
    }
    if all_done {
        RunStatus::Completed
    } else {
        RunStatus::AwaitingNodes
    }
}

/// Reject a definition whose `depends_on` edges contain a cycle (would hang forever).
pub fn validate_acyclic(def: &WorkflowDef) -> Result<(), String> {
    // DFS with a recursion stack; colors: 0=unvisited,1=on-stack,2=done.
    let mut color: std::collections::HashMap<&str, u8> = std::collections::HashMap::new();
    fn visit<'a>(
        node: &'a str,
        def: &'a WorkflowDef,
        color: &mut std::collections::HashMap<&'a str, u8>,
    ) -> Result<(), String> {
        match color.get(node) {
            Some(2) => return Ok(()),
            Some(1) => return Err(format!("cycle through node {node}")),
            _ => {}
        }
        color.insert(node, 1);
        if let Some(n) = def.nodes.get(node) {
            for dep in &n.depends_on {
                if !def.nodes.contains_key(dep) {
                    return Err(format!("node {node} depends on unknown node {dep}"));
                }
                visit(dep, def, color)?;
            }
        }
        color.insert(node, 2);
        Ok(())
    }
    for node in def.nodes.keys() {
        visit(node, def, &mut color)?;
    }
    Ok(())
}

/// The output node plus the transitive closure of its `depends_on` (node_ids).
pub fn required_set(def: &WorkflowDef) -> BTreeSet<String> {
    let mut req = BTreeSet::new();
    let mut stack: Vec<String> = Vec::new();
    let output = def
        .output
        .from
        .strip_prefix("node:")
        .unwrap_or(&def.output.from)
        .to_string();
    stack.push(output);
    let mut seen: HashSet<String> = HashSet::new();
    while let Some(n) = stack.pop() {
        if !seen.insert(n.clone()) {
            continue;
        }
        req.insert(n.clone());
        if let Some(node) = def.nodes.get(&n) {
            for dep in &node.depends_on {
                stack.push(dep.clone());
            }
        }
    }
    req
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    // -----------------------------------------------------------------------
    // Test helpers: the 3-node plan → read (fanout) → synthesize example
    // -----------------------------------------------------------------------

    fn def() -> WorkflowDef {
        use crate::types::{FanoutSpec, FunctionSpec, InputSpec, NodeDef, OutputRef, WorkflowDef};
        let mut nodes = BTreeMap::new();

        nodes.insert(
            "plan".to_string(),
            NodeDef {
                label: None,
                function: Some(FunctionSpec {
                    id: "plan-fn".to_string(),
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
                input: InputSpec {
                    from: "run_input".into(),
                    template: Some("List the docs to read for: {{topic}}".to_string()),
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
                function: Some(FunctionSpec {
                    id: "read-fn".to_string(),
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
                input: InputSpec {
                    from: "fanout_item".into(),
                    template: Some("Read and summarize: {{item}}".to_string()),
                    value: None,
                },
                depends_on: vec!["plan".to_string()],
                fanout: Some(FanoutSpec {
                    over: "node:plan.result.docs".to_string(),
                    mode: None,
                    batch_size: None,
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
                function: Some(FunctionSpec {
                    id: "synthesize-fn".to_string(),
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
                input: InputSpec {
                    from: "node:read".into(),
                    template: Some("Synthesize from: {{results}}".to_string()),
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

    fn record() -> WorkflowRunRecord {
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
            input_ref: "run_test".to_string(),
            vars_ref: Some("run_test".to_string()),
            state_keys_map: BTreeMap::new(),
            stream_ids: Vec::new(),
            queue_receipts: Vec::new(),
            nodes: BTreeMap::new(),
            fanout_src: BTreeMap::new(),
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

    fn done_checkpoint() -> NodeCheckpoint {
        NodeCheckpoint {
            state: NodeState::Done,
            session_id: None,
            turn_id: None,
            result_ref: Some("node-result".to_string()),
            result_error: None,
            child_run_id: None,
            pending_at: None,
            pending_timeout_ms: None,
            retries: 0,
            completed_at: None,
            worker_name: None,
        }
    }

    // -----------------------------------------------------------------------
    // Tests from the brief
    // -----------------------------------------------------------------------

    #[test]
    fn frontier_starts_with_root_node() {
        assert_eq!(ready_frontier(&def(), &record()), vec!["plan".to_string()]);
    }

    #[test]
    fn frontier_treats_preinitialized_pending_root_as_unstarted() {
        let (d, mut r) = (def(), record());
        r.nodes.insert("plan".into(), pending_checkpoint());
        assert_eq!(ready_frontier(&d, &r), vec!["plan".to_string()]);
    }

    #[test]
    fn initializes_reduce_from_done_source_and_preserves_checkpoint_on_retry() {
        let mut d = def();
        d.nodes.get_mut("synthesize").unwrap().reduce = Some(ReduceSpec {
            over: "node:plan.result.docs".to_string(),
            mode: ReduceMode::Sequential,
            initial: serde_json::json!({ "sum": 0 }),
            item_return_type: None,
            accumulator_return_type: None,
            body: vec!["reduce-body".to_string()],
        });

        let mut r = record();
        r.nodes.insert("plan".into(), done_checkpoint());
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), serde_json::json!({ "docs": [1, 2, 3] }));

        assert_eq!(
            initialize_ready_reductions(&d, &mut r, &results),
            vec!["synthesize"]
        );
        let checkpoint = r.reduce_checkpoints.get("synthesize").unwrap();
        assert_eq!(checkpoint.next_index, 0);
        assert_eq!(checkpoint.total_items, 3);
        assert_eq!(checkpoint.accumulator, serde_json::json!({ "sum": 0 }));
        assert_eq!(checkpoint.state, ReduceState::Pending);

        assert!(initialize_ready_reductions(&d, &mut r, &results).is_empty());
        assert_eq!(r.reduce_checkpoints.len(), 1);
    }

    #[test]
    fn ready_frontier_excludes_reduce_body_nodes() {
        let mut d = def();
        d.nodes.insert(
            "reduce-body".to_string(),
            NodeDef {
                label: None,
                function: Some(FunctionSpec {
                    id: "add-item".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                }),
                agent: None,
                agent_options: None,
                child_workflow: None,
                reduce: None,
                reduce_body: Some(ReduceBodySpec {
                    reduce: "synthesize".to_string(),
                }),
                if_spec: None,
                if_branch: None,
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

        assert!(!ready_frontier(&d, &record()).contains(&"reduce-body".to_string()));
    }

    #[test]
    fn reduce_body_waits_for_matching_fanout_item() {
        let mut d = def();
        d.nodes.get_mut("synthesize").unwrap().reduce_body = Some(ReduceBodySpec {
            reduce: "reduce".to_string(),
        });
        d.nodes.get_mut("synthesize").unwrap().depends_on = vec!["read".to_string()];

        let mut r = record();
        r.fanout_src.insert("read".to_string(), 1);
        r.nodes.insert("read#0".to_string(), done_checkpoint());
        r.nodes
            .insert("synthesize#0".to_string(), pending_checkpoint());
        r.reduce_checkpoints.insert(
            "reduce".to_string(),
            ReduceCheckpoint {
                next_index: 0,
                total_items: 1,
                accumulator: json!([]),
                state: ReduceState::Running,
                active_body_uids: vec!["synthesize#0".to_string()],
                error: None,
            },
        );

        assert!(ready_frontier(&d, &r).contains(&"synthesize#0".to_string()));
    }

    #[test]
    fn reduce_body_waits_when_fanout_item_has_no_result_reference() {
        let mut d = def();
        d.nodes.get_mut("synthesize").unwrap().reduce_body = Some(ReduceBodySpec {
            reduce: "reduce".to_string(),
        });
        d.nodes.get_mut("synthesize").unwrap().depends_on = vec!["read".to_string()];

        let mut r = record();
        r.fanout_src.insert("read".to_string(), 1);
        r.nodes.insert(
            "read#0".to_string(),
            NodeCheckpoint {
                result_ref: None,
                ..done_checkpoint()
            },
        );
        r.nodes
            .insert("synthesize#0".to_string(), pending_checkpoint());
        r.reduce_checkpoints.insert(
            "reduce".to_string(),
            ReduceCheckpoint {
                next_index: 0,
                total_items: 1,
                accumulator: json!([]),
                state: ReduceState::Running,
                active_body_uids: vec!["synthesize#0".to_string()],
                error: None,
            },
        );

        assert!(!ready_frontier(&d, &r).contains(&"synthesize#0".to_string()));
    }

    #[test]
    fn materializes_only_the_active_reduce_iteration() {
        let mut d = def();
        d.nodes.get_mut("synthesize").unwrap().reduce = Some(ReduceSpec {
            over: "node:plan.result.docs".to_string(),
            mode: ReduceMode::Sequential,
            initial: json!(0),
            item_return_type: None,
            accumulator_return_type: None,
            body: vec!["reduce-body".to_string()],
        });
        d.nodes.insert(
            "reduce-body".to_string(),
            NodeDef {
                label: None,
                function: Some(FunctionSpec {
                    id: "add-item".to_string(),
                    timeout_ms: None,
                    queue: None,
                    engine_retry: None,
                    runtime: None,
                }),
                agent: None,
                agent_options: None,
                child_workflow: None,
                reduce: None,
                reduce_body: Some(ReduceBodySpec {
                    reduce: "synthesize".to_string(),
                }),
                if_spec: None,
                if_branch: None,
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

        let mut r = record();
        r.nodes.insert("plan".to_string(), done_checkpoint());
        r.reduce_checkpoints.insert(
            "synthesize".to_string(),
            ReduceCheckpoint {
                next_index: 0,
                total_items: 2,
                accumulator: json!(0),
                state: ReduceState::Pending,
                active_body_uids: Vec::new(),
                error: None,
            },
        );

        assert_eq!(
            materialize_reduce_iterations(&d, &mut r),
            vec!["synthesize"]
        );
        assert_eq!(ready_frontier(&d, &r), vec!["reduce-body#0"]);
        assert!(r.nodes.contains_key("reduce-body#0"));
        assert!(!r.nodes.contains_key("reduce-body#1"));
    }

    #[test]
    fn advances_reduce_sequentially_and_preserves_failed_iteration_for_retry() {
        let mut checkpoint = ReduceCheckpoint {
            next_index: 0,
            total_items: 2,
            accumulator: json!(0),
            state: ReduceState::Running,
            active_body_uids: vec!["reduce-body#0".to_string()],
            error: None,
        };

        assert_eq!(
            advance_reduce_checkpoint(&mut checkpoint, &[json!(4)]),
            Some(json!(4))
        );
        assert_eq!(checkpoint.next_index, 1);
        assert_eq!(checkpoint.accumulator, json!(4));
        assert_eq!(checkpoint.state, ReduceState::Pending);
        assert!(checkpoint.active_body_uids.is_empty());

        checkpoint.active_body_uids = vec!["reduce-body#1".to_string()];
        checkpoint.state = ReduceState::Running;
        assert_eq!(
            advance_reduce_checkpoint(&mut checkpoint, &[Value::Null]),
            None
        );
        assert_eq!(checkpoint.next_index, 1);
        assert_eq!(checkpoint.accumulator, json!(4));
        assert_eq!(checkpoint.state, ReduceState::Running);
        assert_eq!(checkpoint.active_body_uids, vec!["reduce-body#1"]);

        assert_eq!(
            advance_reduce_checkpoint(&mut checkpoint, &[json!(9)]),
            Some(json!(9))
        );
        assert_eq!(checkpoint.next_index, 2);
        assert_eq!(checkpoint.accumulator, json!(9));
        assert_eq!(checkpoint.state, ReduceState::Done);
        assert!(checkpoint.active_body_uids.is_empty());
    }

    #[test]
    fn initializes_if_once_and_releases_only_the_selected_branch() {
        let mut d = def();
        d.nodes.insert(
            "if".to_string(),
            NodeDef {
                label: None,
                function: None,
                agent: None,
                agent_options: None,
                child_workflow: None,
                reduce: None,
                reduce_body: None,
                if_spec: Some(IfSpec {
                    source: json!("node:plan"),
                    path: vec!["enabled".to_string()],
                    predicate: None,
                }),
                if_branch: None,
                input: InputSpec {
                    from: "run_input".into(),
                    template: None,
                    value: None,
                },
                depends_on: vec!["plan".to_string()],
                fanout: None,
                result: None,
                input_policy: None,
            },
        );
        for (branch_id, path) in [("then", IfBranchPath::Then), ("else", IfBranchPath::Else)] {
            let mut branch = def().nodes["synthesize"].clone();
            branch.depends_on = vec!["if".to_string()];
            branch.if_branch = Some(IfBranchSpec {
                if_node: "if".to_string(),
                path,
            });
            d.nodes.insert(branch_id.to_string(), branch);
        }
        let mut after = def().nodes["synthesize"].clone();
        after.depends_on = vec!["then".to_string(), "else".to_string()];
        d.nodes.insert("after".to_string(), after);

        let mut r = record();
        r.nodes.insert("plan".to_string(), done_checkpoint());
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"enabled": false}));

        assert_eq!(
            initialize_ready_ifs(&d, &mut r, &results, &Value::Null),
            vec!["if"]
        );
        assert_eq!(r.if_checkpoints["if"].selected, Some(IfBranchPath::Else));
        assert_eq!(r.nodes["then"].state, NodeState::Cancelled);
        assert_eq!(ready_frontier(&d, &r), vec!["else"]);
        assert!(initialize_ready_ifs(&d, &mut r, &results, &Value::Null).is_empty());

        r.nodes.insert("else".to_string(), done_checkpoint());
        assert!(deps_done(&d, &r, "after"));
        assert_eq!(ready_frontier(&d, &r), vec!["after"]);

        let mut no_else = d.clone();
        no_else.nodes.remove("else");
        no_else
            .nodes
            .get_mut("after")
            .expect("join node exists")
            .depends_on = vec!["then".to_string()];
        let mut skipped = record();
        skipped.nodes.insert("plan".to_string(), done_checkpoint());
        assert_eq!(
            initialize_ready_ifs(&no_else, &mut skipped, &results, &Value::Null),
            vec!["if"]
        );
        assert_eq!(skipped.nodes["then"].state, NodeState::Cancelled);
        assert!(deps_done(&no_else, &skipped, "after"));
        assert_eq!(ready_frontier(&no_else, &skipped), vec!["after"]);
    }

    #[test]
    fn initializes_if_from_equals_predicate() {
        let mut d = def();
        d.nodes.insert(
            "if".to_string(),
            NodeDef {
                label: None,
                function: None,
                agent: None,
                agent_options: None,
                child_workflow: None,
                reduce: None,
                reduce_body: None,
                if_spec: Some(IfSpec {
                    source: json!(true),
                    path: vec![],
                    predicate: Some(IfPredicate::Equals {
                        left: json!({"$ref": "node:plan", "$path": ["status"]}),
                        right: json!("ready"),
                    }),
                }),
                if_branch: None,
                input: InputSpec {
                    from: "run_input".into(),
                    template: None,
                    value: None,
                },
                depends_on: vec!["plan".to_string()],
                fanout: None,
                result: None,
                input_policy: None,
            },
        );

        let mut r = record();
        r.nodes.insert("plan".to_string(), done_checkpoint());
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"status": "ready"}));

        assert_eq!(
            initialize_ready_ifs(&d, &mut r, &results, &Value::Null),
            vec!["if"]
        );
        assert_eq!(r.if_checkpoints["if"].selected, Some(IfBranchPath::Then));
    }

    #[test]
    fn evaluates_numeric_and_logical_if_predicates() {
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"score": 8, "active": true}));
        let score = json!({"$ref": "node:plan", "$path": ["score"]});
        let active = json!({"$ref": "node:plan", "$path": ["active"]});

        let predicate = IfPredicate::And {
            args: vec![
                IfPredicate::Gte {
                    left: score,
                    right: json!(7),
                },
                IfPredicate::Not {
                    arg: Box::new(IfPredicate::Equals {
                        left: active,
                        right: json!(false),
                    }),
                },
            ],
        };

        assert!(if_predicate_matches(&predicate, &results, &Value::Null));
    }

    #[test]
    fn fanout_expands_from_frozen_source_in_numeric_order() {
        let (d, mut r) = (def(), record());
        r.nodes.insert("plan".into(), done_checkpoint());
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs":["a","b"]}));
        let expanded = expand_ready_fanouts(&d, &mut r, &results);
        assert_eq!(expanded, vec!["read".to_string()]);
        assert_eq!(r.fanout_src["read"], 2);
        assert_eq!(
            fanned_uids(&r, "read"),
            vec!["read#0".to_string(), "read#1".to_string()]
        );
    }

    #[test]
    fn barrier_node_not_ready_until_all_fanned_items_done() {
        let (d, mut r) = (def(), record());

        // Expand read fanout with 2 items.
        r.nodes.insert("plan".into(), done_checkpoint());
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs":["a","b"]}));
        expand_ready_fanouts(&d, &mut r, &results);

        // Mark read#0 Done but NOT read#1.
        r.nodes.insert("read#0".into(), done_checkpoint());
        // read#1 remains Pending (set by expand_ready_fanouts).

        // synthesize depends on "read"; barrier must not be satisfied yet.
        assert!(
            !deps_done(&d, &r, "synthesize"),
            "synthesize should not be ready yet"
        );
        let frontier = ready_frontier(&d, &r);
        assert!(
            !frontier.contains(&"synthesize".to_string()),
            "synthesize must not appear in frontier until all read#i are Done"
        );

        // Now mark read#1 Done too.
        r.nodes.insert("read#1".into(), done_checkpoint());
        assert!(
            deps_done(&d, &r, "synthesize"),
            "synthesize should now be ready"
        );
        let frontier2 = ready_frontier(&d, &r);
        assert!(
            frontier2.contains(&"synthesize".to_string()),
            "synthesize must appear in frontier once all read#i are Done"
        );
    }

    // -----------------------------------------------------------------------
    // Additional correctness tests
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_over_path_returns_array() {
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs":["x","y","z"]}));
        let arr = resolve_over_path("node:plan.result.docs", &results);
        assert_eq!(arr, Ok(vec![json!("x"), json!("y"), json!("z")]));
    }

    #[test]
    fn resolve_over_path_errs_for_non_array_naming_the_type() {
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs": "not-an-array"}));
        let err = resolve_over_path("node:plan.result.docs", &results).unwrap_err();
        assert!(
            err.contains("not an array"),
            "should name the shape problem: {err}"
        );
        assert!(err.contains("string"), "should name the actual type: {err}");
    }

    #[test]
    fn resolve_over_path_errs_for_missing_key_listing_present_keys() {
        let mut results = BTreeMap::new();
        results.insert(
            "draft".to_string(),
            json!({"blog_post": "...", "title": "t"}),
        );
        let err = resolve_over_path("node:draft.rewrite_priority", &results).unwrap_err();
        assert!(
            err.contains("rewrite_priority"),
            "names the missing segment: {err}"
        );
        assert!(err.contains("produced keys"), "lists what WAS there: {err}");
        assert!(err.contains("blog_post"), "shows the real keys: {err}");
        assert!(
            !err.contains("10000"),
            "must NOT misleadingly mention a size cap: {err}"
        );
    }

    #[test]
    fn resolve_over_path_errs_for_missing_node() {
        let results: BTreeMap<String, Value> = BTreeMap::new();
        let err = resolve_over_path("node:plan.result.docs", &results).unwrap_err();
        assert!(
            err.contains("no result in scope"),
            "should name the missing node: {err}"
        );
    }

    #[test]
    fn fanned_uids_empty_when_not_expanded() {
        let r = record();
        assert_eq!(fanned_uids(&r, "read"), Vec::<String>::new());
    }

    #[test]
    fn expand_ready_fanouts_idempotent() {
        let (d, mut r) = (def(), record());
        r.nodes.insert("plan".into(), done_checkpoint());
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs":["a","b","c"]}));

        let first = expand_ready_fanouts(&d, &mut r, &results);
        let second = expand_ready_fanouts(&d, &mut r, &results);

        assert_eq!(first, vec!["read".to_string()]);
        assert!(second.is_empty(), "second call must be a no-op");
        // Snapshot must still have 3 items.
        assert_eq!(r.fanout_src["read"], 3);
    }

    #[test]
    fn fanout_items_use_numeric_not_lexical_order() {
        let (d, mut r) = (def(), record());
        r.nodes.insert("plan".into(), done_checkpoint());
        // 11 items so that lexical order "read#10" < "read#2" would differ from numeric.
        let items: Vec<Value> = (0..11).map(|i| json!(i)).collect();
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs": items}));
        expand_ready_fanouts(&d, &mut r, &results);

        let uids = fanned_uids(&r, "read");
        assert_eq!(uids[0], "read#0");
        assert_eq!(uids[1], "read#1");
        assert_eq!(uids[9], "read#9");
        assert_eq!(uids[10], "read#10");
        // Numeric: read#10 must be last, not between read#1 and read#2.
        let pos2 = uids.iter().position(|u| u == "read#2").unwrap();
        let pos10 = uids.iter().position(|u| u == "read#10").unwrap();
        assert!(
            pos2 < pos10,
            "read#2 must come before read#10 in numeric order"
        );
    }

    #[test]
    fn fanned_uids_preserve_namespaced_node_ids() {
        let mut r = record();
        r.fanout_src
            .insert("playground::process-text".to_string(), 2);

        assert_eq!(
            fanned_uids(&r, "playground::process-text"),
            vec![
                "playground::process-text#0".to_string(),
                "playground::process-text#1".to_string(),
            ]
        );
    }

    #[test]
    fn frontier_does_not_include_fanout_node_id_before_expansion() {
        let (d, mut r) = (def(), record());
        // plan is done, but read has not been expanded yet.
        r.nodes.insert("plan".into(), done_checkpoint());
        let frontier = ready_frontier(&d, &r);
        // "read" itself must not appear; its items (read#0, read#1) also not yet.
        assert!(!frontier.contains(&"read".to_string()));
    }

    #[test]
    fn frontier_includes_pending_fanout_items_after_expansion() {
        let (d, mut r) = (def(), record());
        r.nodes.insert("plan".into(), done_checkpoint());
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs":["a","b"]}));
        expand_ready_fanouts(&d, &mut r, &results);

        let frontier = ready_frontier(&d, &r);
        assert!(frontier.contains(&"read#0".to_string()));
        assert!(frontier.contains(&"read#1".to_string()));
    }

    #[test]
    fn frontier_sequential_fanout_releases_one_item_at_a_time() {
        let (mut d, mut r) = (def(), record());
        if let Some(read) = d.nodes.get_mut("read") {
            if let Some(fanout) = read.fanout.as_mut() {
                fanout.mode = Some(FanoutMode::Sequential);
            }
        }

        r.nodes.insert("plan".into(), done_checkpoint());
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs":["a","b","c"]}));
        expand_ready_fanouts(&d, &mut r, &results);

        let frontier1 = ready_frontier(&d, &r);
        assert_eq!(frontier1, vec!["read#0".to_string()]);

        r.nodes.insert("read#0".into(), done_checkpoint());
        let frontier2 = ready_frontier(&d, &r);
        assert_eq!(frontier2, vec!["read#1".to_string()]);

        r.nodes.insert("read#1".into(), done_checkpoint());
        let frontier3 = ready_frontier(&d, &r);
        assert_eq!(frontier3, vec!["read#2".to_string()]);
    }

    #[test]
    fn frontier_batch_fanout_releases_window() {
        let (mut d, mut r) = (def(), record());
        if let Some(read) = d.nodes.get_mut("read") {
            if let Some(fanout) = read.fanout.as_mut() {
                fanout.mode = Some(FanoutMode::Batch);
                fanout.batch_size = Some(2);
            }
        }

        r.nodes.insert("plan".into(), done_checkpoint());
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs":["a","b","c","d"]}));
        expand_ready_fanouts(&d, &mut r, &results);

        let frontier1 = ready_frontier(&d, &r);
        assert_eq!(frontier1, vec!["read#0".to_string(), "read#1".to_string()]);

        r.nodes.insert("read#0".into(), done_checkpoint());
        let frontier2 = ready_frontier(&d, &r);
        assert_eq!(frontier2, vec!["read#1".to_string(), "read#2".to_string()]);

        r.nodes.insert("read#1".into(), done_checkpoint());
        let frontier3 = ready_frontier(&d, &r);
        assert_eq!(frontier3, vec!["read#2".to_string(), "read#3".to_string()]);
    }

    // -----------------------------------------------------------------------
    // Task 4 tests
    // -----------------------------------------------------------------------

    fn failed_checkpoint() -> NodeCheckpoint {
        NodeCheckpoint {
            state: NodeState::Failed,
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
        }
    }

    fn running_checkpoint() -> NodeCheckpoint {
        NodeCheckpoint {
            state: NodeState::Running,
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
        }
    }

    #[test]
    fn fan_in_gathers_results_in_numeric_order_not_lexical() {
        let (d, mut r) = (def(), record());

        // Expand read fanout with 11 items so lexical order (read#10 < read#2) would differ.
        r.nodes.insert("plan".into(), done_checkpoint());
        let items: Vec<Value> = (0..11).map(|i| json!(i)).collect();
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs": items}));
        expand_ready_fanouts(&d, &mut r, &results);

        // Mark all read#i Done and put their results in the map.
        for i in 0..11u32 {
            let uid = node_uid("read", Some(i));
            r.nodes.insert(uid.clone(), done_checkpoint());
            results.insert(uid, json!({"summary": i}));
        }

        // synthesize has input.from = "node:read" — gather_input should fan-in.
        let gathered = gather_input(&d, &r, &json!({"topic": "rust"}), "synthesize", &results);
        let arr = gathered.as_array().expect("expected a JSON array");
        assert_eq!(arr.len(), 11);
        // Element at index 2 must be the result of read#2.
        assert_eq!(arr[2], json!({"summary": 2}));
        // Element at index 10 must be the result of read#10 (not lexical last).
        assert_eq!(arr[10], json!({"summary": 10}));
        // Prove numeric vs lexical: index 2 comes before index 10 in the array.
        // (In lexical order "read#10" sorts before "read#2", so arr[2] would have been summary 10.)
        assert_ne!(
            arr[2],
            json!({"summary": 10}),
            "lexical order would have placed read#10 at position 2"
        );
    }

    #[test]
    fn many_input_gathers_each_dep_into_keyed_object() {
        use crate::types::{FunctionSpec, InputSpec, NodeDef, OutputRef};
        let function = |id: &str| FunctionSpec {
            id: id.to_string(),
            timeout_ms: None,
            queue: None,
            engine_retry: None,
            runtime: None,
        };
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "b".to_string(),
            NodeDef {
                label: None,
                function: Some(function("fn-b")),
                agent: None,
                agent_options: None,
                child_workflow: None,
                reduce: None,
                reduce_body: None,
                if_spec: None,
                if_branch: None,
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
            "c".to_string(),
            NodeDef {
                label: None,
                function: Some(function("fn-c")),
                agent: None,
                agent_options: None,
                child_workflow: None,
                reduce: None,
                reduce_body: None,
                if_spec: None,
                if_branch: None,
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
            "join".to_string(),
            NodeDef {
                label: None,
                function: Some(function("fn-join")),
                agent: None,
                agent_options: None,
                child_workflow: None,
                reduce: None,
                reduce_body: None,
                if_spec: None,
                if_branch: None,
                input: InputSpec {
                    from: InputFrom::Many(vec!["node:b".to_string(), "node:c".to_string()]),
                    template: None,
                    value: None,
                },
                depends_on: vec!["b".to_string(), "c".to_string()],
                fanout: None,
                result: None,
                input_policy: None,
            },
        );
        let d = WorkflowDef {
            version: 1,
            nodes,
            output: OutputRef {
                from: "node:join".into(),
            },
            default_functions: None,
            metadata: None,
        };
        let r = record();
        let mut results = BTreeMap::new();
        results.insert("b".to_string(), json!({"draft": "hello"}));
        results.insert("c".to_string(), json!({"review": "ok"}));

        // The join reads BOTH deps — each keyed by its node id (a single `from`
        // could only have delivered one of them).
        let gathered = gather_input(&d, &r, &json!({"topic": "rust"}), "join", &results);
        assert_eq!(
            gathered,
            json!({"b": {"draft": "hello"}, "c": {"review": "ok"}})
        );
    }

    #[test]
    fn quiescence_completed_only_when_output_done_and_nothing_running() {
        let (d, mut r) = (def(), record());

        // Set up: plan Done, read fanout expanded and all Done, synthesize Running.
        r.nodes.insert("plan".into(), done_checkpoint());
        let items: Vec<Value> = (0..2).map(|i| json!(i)).collect();
        let mut results = BTreeMap::new();
        results.insert("plan".to_string(), json!({"docs": items}));
        expand_ready_fanouts(&d, &mut r, &results);
        r.nodes.insert("read#0".into(), done_checkpoint());
        r.nodes.insert("read#1".into(), done_checkpoint());

        // Output node (synthesize) is Running → must be AwaitingNodes.
        r.nodes.insert("synthesize".into(), running_checkpoint());
        assert_eq!(quiescence(&d, &r), RunStatus::AwaitingNodes);

        // Flip synthesize to Done → must be Completed.
        r.nodes.insert("synthesize".into(), done_checkpoint());
        assert_eq!(quiescence(&d, &r), RunStatus::Completed);
    }

    #[test]
    fn quiescence_cancelled_on_abort_and_failed_on_node_failure() {
        let (d, mut r) = (def(), record());

        // abort=true → Cancelled, regardless of node states.
        r.abort = true;
        assert_eq!(quiescence(&d, &r), RunStatus::Cancelled);

        // abort=false but a node has failed → Failed.
        r.abort = false;
        r.nodes.insert("plan".into(), failed_checkpoint());
        assert_eq!(quiescence(&d, &r), RunStatus::Failed);
    }

    #[test]
    fn validate_acyclic_accepts_a_diamond() {
        // a -> b, a -> c, b -> d, c -> d
        let d: WorkflowDef = serde_json::from_value(serde_json::json!({
            "version":1, "output":{"from":"node:d"}, "nodes":{
                            "a":{"function":{"id":"fn-a"},"input":{"from":"run_input","template":"t"}},
                            "b":{"depends_on":["a"],"function":{"id":"fn-b"},"input":{"from":"node:a","template":"t"}},
                            "c":{"depends_on":["a"],"function":{"id":"fn-c"},"input":{"from":"node:a","template":"t"}},
                            "d":{"depends_on":["b","c"],"function":{"id":"fn-d"},"input":{"from":"node:b","template":"t"}}
            }})).unwrap();
        assert!(validate_acyclic(&d).is_ok());
    }

    #[test]
    fn validate_acyclic_rejects_a_cycle() {
        // b -> c, c -> b
        let d: WorkflowDef = serde_json::from_value(serde_json::json!({
            "version":1, "output":{"from":"node:b"}, "nodes":{
                            "b":{"depends_on":["c"],"function":{"id":"fn-b"},"input":{"from":"node:c","template":"t"}},
                            "c":{"depends_on":["b"],"function":{"id":"fn-c"},"input":{"from":"node:b","template":"t"}}
            }})).unwrap();
        assert!(validate_acyclic(&d).is_err());
    }

    #[test]
    fn required_set_is_output_transitive_closure_only() {
        // a -> b -> d (required); a -> orphan (NOT required by output d)
        let d: WorkflowDef = serde_json::from_value(serde_json::json!({
            "version":1, "output":{"from":"node:d"}, "nodes":{
                            "a":{"function":{"id":"fn-a"},"input":{"from":"run_input","template":"t"}},
                            "b":{"depends_on":["a"],"function":{"id":"fn-b"},"input":{"from":"node:a","template":"t"}},
                            "d":{"depends_on":["b"],"function":{"id":"fn-d"},"input":{"from":"node:b","template":"t"}},
                            "orphan":{"depends_on":["a"],"function":{"id":"fn-orphan"},"input":{"from":"node:a","template":"t"}}
            }})).unwrap();
        let req = required_set(&d);
        assert!(req.contains("a") && req.contains("b") && req.contains("d"));
        assert!(!req.contains("orphan"));
    }

    // -----------------------------------------------------------------------
    // Empty-fanout vacuous-completion tests (TDD — written before the fix)
    // -----------------------------------------------------------------------

    /// Minimal 3-node def: a (normal) → b (fanout over node:a.result.items) → c (normal).
    /// Output: node:c.
    fn empty_fanout_def() -> WorkflowDef {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "output": {"from": "node:c"},
            "nodes": {
                "a": {
                    "function": {"id": "fn-a"},
                    "input": {"from": "run_input", "template": "t"},
                    "depends_on": []
                },
                "b": {
                    "function": {"id": "fn-b"},
                    "input": {"from": "fanout_item", "template": "t"},
                    "depends_on": ["a"],
                    "fanout": {"over": "node:a.result.items"}
                },
                "c": {
                    "function": {"id": "fn-c"},
                    "input": {"from": "node:b", "template": "t"},
                    "depends_on": ["b"]
                }
            }
        }))
        .unwrap()
    }

    #[test]
    fn deps_done_true_for_dependent_of_empty_fanout() {
        let d = empty_fanout_def();
        let mut r = record();
        // a is Done.
        r.nodes.insert("a".into(), done_checkpoint());
        // b was expanded to zero items — no b#i checkpoints inserted.
        r.fanout_src.insert("b".into(), 0);
        // c depends on b; b was expanded-empty → vacuously Done.
        assert!(
            deps_done(&d, &r, "c"),
            "deps_done must be true for c when b's fanout was expanded to empty"
        );
    }

    #[test]
    fn quiescence_completes_with_empty_required_fanout() {
        let d = empty_fanout_def();
        let mut r = record();
        r.nodes.insert("a".into(), done_checkpoint());
        r.fanout_src.insert("b".into(), 0);
        r.nodes.insert("c".into(), done_checkpoint());
        assert_eq!(
            quiescence(&d, &r),
            RunStatus::Completed,
            "quiescence must be Completed when b expanded to empty and c is Done"
        );
    }

    #[test]
    fn quiescence_awaits_unexpanded_fanout() {
        let d = empty_fanout_def();
        let mut r = record();
        r.nodes.insert("a".into(), done_checkpoint());
        // NO fanout_src entry for b — not yet expanded.
        assert_eq!(
            quiescence(&d, &r),
            RunStatus::AwaitingNodes,
            "quiescence must be AwaitingNodes when b has not been expanded yet"
        );
    }

    /// A required fanout whose source is Done but whose `over` doesn't resolve to
    /// an array must FAIL the run, not park it in AwaitingNodes forever.
    #[test]
    fn fanout_over_non_array_fails_run_instead_of_hanging() {
        let d = empty_fanout_def();
        let mut r = record();
        r.nodes.insert("a".into(), done_checkpoint());
        // a's result has `items` as a non-array → `over` can't resolve to an array.
        let mut results = BTreeMap::new();
        results.insert("a".to_string(), json!({"items": "not-an-array"}));

        let expanded = expand_ready_fanouts(&d, &mut r, &results);
        assert_eq!(
            expanded,
            vec!["b".to_string()],
            "b is marked failed-to-expand"
        );
        assert_eq!(
            r.nodes.get("b").map(|c| c.state),
            Some(NodeState::Failed),
            "a base-id Failed checkpoint marks the failed fanout"
        );
        assert_eq!(
            quiescence(&d, &r),
            RunStatus::Failed,
            "run must fail (not hang) when a required fanout cannot expand"
        );
    }

    // -----------------------------------------------------------------------
    // Task 2: transitive multi-sink quiescence helpers and tests
    // -----------------------------------------------------------------------

    /// Returns the Task-1 required_set def: a -> b -> d (output), a -> orphan (not required).
    fn def_with_orphan() -> WorkflowDef {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "output": {"from": "node:d"},
            "nodes": {
                "a": {
                    "function": {"id": "fn-a"},
                    "input": {"from": "run_input", "template": "t"}
                },
                "b": {
                    "depends_on": ["a"],
                    "function": {"id": "fn-b"},
                    "input": {"from": "node:a", "template": "t"}
                },
                "d": {
                    "depends_on": ["b"],
                    "function": {"id": "fn-d"},
                    "input": {"from": "node:b", "template": "t"}
                },
                "orphan": {
                    "depends_on": ["a"],
                    "function": {"id": "fn-orphan"},
                    "input": {"from": "node:a", "template": "t"}
                }
            }
        }))
        .unwrap()
    }

    #[test]
    fn quiescence_ignores_orphan_branch_failure() {
        // All declared steps participate in quiescence. If an orphan-like branch
        // fails, the whole run is Failed (it is not ignored anymore).
        let d = def_with_orphan();
        let mut r = record();
        for n in ["a", "b", "d"] {
            r.nodes.insert(n.into(), done_checkpoint());
        }
        r.nodes.insert("orphan".into(), failed_checkpoint());
        assert_eq!(quiescence(&d, &r), RunStatus::Failed);
    }

    #[test]
    fn quiescence_fails_on_required_branch_failure() {
        let d = def_with_orphan();
        let mut r = record();
        r.nodes.insert("a".into(), done_checkpoint());
        r.nodes.insert("b".into(), failed_checkpoint()); // b is required by output d
        assert_eq!(quiescence(&d, &r), RunStatus::Failed);
    }

    #[test]
    fn quiescence_awaits_while_a_required_node_runs() {
        let d = def_with_orphan();
        let mut r = record();
        r.nodes.insert("a".into(), done_checkpoint());
        r.nodes.insert("b".into(), running_checkpoint());
        assert_eq!(quiescence(&d, &r), RunStatus::AwaitingNodes);
    }
}
