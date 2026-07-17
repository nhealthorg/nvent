use std::collections::BTreeMap;

use iii_sdk::protocol::TriggerRequest;
use iii_sdk::IIIClient;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{from_value, json, Value};

use crate::{
    error::WorkflowError,
    ids::{def_key, node_result_key},
    types::{NodeState, WorkflowDef, WorkflowRunRecord},
};

// ---------------------------------------------------------------------------
// Scope constants
// ---------------------------------------------------------------------------

pub const SCOPE_RUN: &str = "workflow_run";
pub const SCOPE_DEF: &str = "workflow_def";
pub const SCOPE_RESULT: &str = "workflow_node_result";
pub const SCOPE_INDEX: &str = "workflow_session_index";
pub const SCOPE_RUN_LOG: &str = "workflow_run_log";
pub const SCOPE_RUN_TRACE: &str = "workflow_run_trace";
pub const SCOPE_RUN_STATE: &str = "workflow_run_state";
pub const SCOPE_IDEM: &str = "workflow_idem";
pub const STREAM_NAME_WORKFLOW: &str = "workflow";
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct WorkflowRunLogRecord {
    pub id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    pub level: String,
    pub message: String,
    pub ts_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct WorkflowRunTraceRecord {
    pub id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    pub event_name: String,
    pub ts_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attributes: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
}

// RPC timeout for state::* dispatch. Process-global so it can be wired from
// WorkerConfig.dispatch_timeout_ms without threading a param through every state
// call. ponytail: set at boot + on config change; relaxed ordering is fine for a
// tuning knob; per-call threading if a run ever needs its own timeout.
static DISPATCH_TIMEOUT_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(30_000);

/// Wire the state-layer RPC dispatch timeout from config (boot + hot-reload).
pub fn set_dispatch_timeout_ms(ms: u64) {
    DISPATCH_TIMEOUT_MS.store(ms, std::sync::atomic::Ordering::Relaxed);
}

fn dispatch_timeout_ms() -> u64 {
    DISPATCH_TIMEOUT_MS.load(std::sync::atomic::Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// Private primitive helpers
// ---------------------------------------------------------------------------

async fn state_get(iii: &IIIClient, scope: &str, key: &str) -> Result<Value, WorkflowError> {
    iii.trigger(TriggerRequest {
        function_id: "state::get".into(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: Some(dispatch_timeout_ms()),
    })
    .await
    .map_err(|e| WorkflowError::State(format!("state::get {scope}/{key}: {e}")))
}

async fn state_set(
    iii: &IIIClient,
    scope: &str,
    key: &str,
    value: Value,
) -> Result<(), WorkflowError> {
    iii.trigger(TriggerRequest {
        function_id: "state::set".into(),
        payload: json!({ "scope": scope, "key": key, "value": value }),
        action: None,
        timeout_ms: Some(dispatch_timeout_ms()),
    })
    .await
    .map(|_| ())
    .map_err(|e| WorkflowError::State(format!("state::set {scope}/{key}: {e}")))
}

async fn state_delete(iii: &IIIClient, scope: &str, key: &str) -> Result<(), WorkflowError> {
    iii.trigger(TriggerRequest {
        function_id: "state::delete".into(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: Some(dispatch_timeout_ms()),
    })
    .await
    .map(|_| ())
    .map_err(|e| WorkflowError::State(format!("state::delete {scope}/{key}: {e}")))
}

async fn state_list(iii: &IIIClient, scope: &str) -> Result<Value, WorkflowError> {
    iii.trigger(TriggerRequest {
        function_id: "state::list".into(),
        payload: json!({ "scope": scope }),
        action: None,
        timeout_ms: Some(dispatch_timeout_ms()),
    })
    .await
    .map_err(|e| WorkflowError::State(format!("state::list {scope}: {e}")))
}

async fn stream_list(iii: &IIIClient, stream_name: &str, group_id: &str) -> Result<Value, WorkflowError> {
    iii.trigger(TriggerRequest {
        function_id: "stream::list".into(),
        payload: json!({ "stream_name": stream_name, "group_id": group_id }),
        action: None,
        timeout_ms: Some(dispatch_timeout_ms()),
    })
    .await
    .map_err(|e| WorkflowError::State(format!("stream::list {stream_name}/{group_id}: {e}")))
}

async fn stream_delete(iii: &IIIClient, stream_name: &str, group_id: &str, item_id: &str) -> Result<(), WorkflowError> {
    iii.trigger(TriggerRequest {
        function_id: "stream::delete".into(),
        payload: json!({ "stream_name": stream_name, "group_id": group_id, "item_id": item_id }),
        action: None,
        timeout_ms: Some(dispatch_timeout_ms()),
    })
    .await
    .map(|_| ())
    .map_err(|e| WorkflowError::State(format!("stream::delete {stream_name}/{group_id}/{item_id}: {e}")))
}

fn parse_stream_items(v: &Value) -> Vec<Value> {
    parse_state_list_values(v)
}

async fn delete_run_scoped_entries(iii: &IIIClient, scope: &str, run_id: &str) -> Result<(), WorkflowError> {
    let v = state_list(iii, scope).await?;
    let prefix = format!("{run_id}/");

    for item in parse_state_list_values(&v) {
        let key = item
            .get("key")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let value_run_id = item
            .get("value")
            .and_then(|x| x.get("run_id"))
            .and_then(|x| x.as_str())
            .unwrap_or("");

        if key.starts_with(&prefix) || value_run_id == run_id {
            state_delete(iii, scope, key).await?;
        }
    }

    Ok(())
}

async fn delete_run_stream_entries(iii: &IIIClient, stream_name: &str, group_id: &str, run_id: &str) -> Result<(), WorkflowError> {
    let v = stream_list(iii, stream_name, group_id).await?;
    let prefix = format!("{run_id}/");

    for item in parse_stream_items(&v) {
        let item_id = item
            .get("id")
            .and_then(|x| x.as_str())
            .or_else(|| item.get("item_id").and_then(|x| x.as_str()))
            .unwrap_or("");
        let item_run_id = item
            .get("run_id")
            .and_then(|x| x.as_str())
            .unwrap_or("");

        if item_id.starts_with(&prefix) || item_run_id == run_id {
            if !item_id.is_empty() {
                stream_delete(iii, stream_name, group_id, item_id).await?;
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Parse helpers (pure — unit-testable)
// ---------------------------------------------------------------------------

/// Tolerates three shapes returned by the state engine:
/// 1. Bare array: `[...]`
/// 2. Object with `values` or `items` key: `{"values":[...]}` / `{"items":[...]}`
/// 3. Key→value map: `{"r_1": {...}, "r_2": {...}}`
pub fn parse_record_list(v: &Value) -> Vec<WorkflowRunRecord> {
    let items = parse_state_list_values(v);

    items
        .into_iter()
        .filter_map(|item| from_value::<WorkflowRunRecord>(item).ok())
        .collect()
}

pub fn parse_state_list_values(v: &Value) -> Vec<Value> {
    if let Some(arr) = v.as_array() {
        return arr.clone();
    }

    if let Some(obj) = v.as_object() {
        if let Some(arr) = obj.get("values").and_then(|x| x.as_array()) {
            return arr.clone();
        }
        if let Some(arr) = obj.get("items").and_then(|x| x.as_array()) {
            return arr.clone();
        }
        return obj.values().cloned().collect();
    }

    Vec::new()
}

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

pub async fn get_run(
    iii: &IIIClient,
    run_id: &str,
) -> Result<Option<WorkflowRunRecord>, WorkflowError> {
    let v = state_get(iii, SCOPE_RUN, run_id).await?;
    if v.is_null() {
        Ok(None)
    } else {
        Ok(Some(from_value(v)?))
    }
}

/// Persist a run record.
///
/// **Single-writer-per-run is the correctness contract.** Callers MUST hold
/// the per-run `WorkflowLocks` guard before calling this function.  The lock
/// serializes every read-modify-write path (tick, reconcile, sweep, stop) for
/// a given `run_id` within one process so writes never clobber each other.
///
/// NOTE: `state::set` is an unconditional overwrite — iii-state (sdk 0.19.2)
/// exposes no compare-and-set.  A multi-process deployment therefore requires
/// run-level sharding (route all `workflow::tick` events for a `run_id` to one
/// owning instance) rather than record-level CAS.  See README §Scaling for the
/// supported multi-instance topology.
pub async fn put_run(iii: &IIIClient, record: &WorkflowRunRecord) -> Result<(), WorkflowError> {
    let v = serde_json::to_value(record)?;
    state_set(iii, SCOPE_RUN, &record.run_id, v).await
}

pub async fn list_runs(iii: &IIIClient) -> Result<Vec<WorkflowRunRecord>, WorkflowError> {
    let v = state_list(iii, SCOPE_RUN).await?;
    Ok(parse_record_list(&v))
}

/// Delete a terminal run's persisted state: its node-result blobs and per-node
/// session reverse-index entries, then its definition, then the run record itself.
/// Used by the sweep to GC runs past the retention window so `list_runs` doesn't
/// deserialize unbounded history every cycle.
///
/// Every child delete is propagated (`?`). The run record is the retry anchor — it
/// still lists the result/def keys and each node's session id — so it is deleted
/// LAST and only once all child deletes have succeeded. A transient failure leaves
/// the record in place for the next sweep to retry, instead of orphaning the
/// result/def/index rows forever. (`state::delete` is idempotent on a missing key,
/// so a retry that re-deletes an already-removed child is a harmless no-op.)
pub async fn delete_run(iii: &IIIClient, record: &WorkflowRunRecord) -> Result<(), WorkflowError> {
    for cp in record.nodes.values() {
        if let Some(key) = &cp.result_ref {
            state_delete(iii, SCOPE_RESULT, key).await?;
        }
        // Clear the session → run reverse index (used by workflow::wake) so a
        // long-lived worker doesn't accumulate orphaned index rows for every run
        // it GCs.
        if let Some(session_id) = &cp.session_id {
            state_delete(iii, SCOPE_INDEX, session_id).await?;
        }
    }
    delete_run_scoped_entries(iii, SCOPE_RUN_STATE, &record.run_id).await?;
    delete_run_stream_entries(
        iii,
        STREAM_NAME_WORKFLOW,
        record.stream_scope_id.as_deref().unwrap_or(&record.run_id),
        &record.run_id,
    )
    .await?;
    state_delete(iii, SCOPE_DEF, &def_key(&record.run_id)).await?;
    state_delete(iii, SCOPE_RUN_LOG, &record.run_id).await?;
    state_delete(iii, SCOPE_RUN_TRACE, &record.run_id).await?;
    state_delete(iii, SCOPE_RUN, &record.run_id).await
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

pub async fn put_def(
    iii: &IIIClient,
    run_id: &str,
    def: &WorkflowDef,
) -> Result<(), WorkflowError> {
    let key = def_key(run_id);
    let v = serde_json::to_value(def)?;
    state_set(iii, SCOPE_DEF, &key, v).await
}

pub async fn get_def(iii: &IIIClient, run_id: &str) -> Result<Option<WorkflowDef>, WorkflowError> {
    let key = def_key(run_id);
    let v = state_get(iii, SCOPE_DEF, &key).await?;
    if v.is_null() {
        Ok(None)
    } else {
        Ok(Some(from_value(v)?))
    }
}

// ---------------------------------------------------------------------------
// Node results
// ---------------------------------------------------------------------------

pub async fn put_node_result(
    iii: &IIIClient,
    run_id: &str,
    node_uid: &str,
    result: &Value,
) -> Result<(), WorkflowError> {
    let key = node_result_key(run_id, node_uid);
    state_set(iii, SCOPE_RESULT, &key, result.clone()).await
}

pub async fn get_node_result(
    iii: &IIIClient,
    run_id: &str,
    node_uid: &str,
) -> Result<Option<Value>, WorkflowError> {
    let key = node_result_key(run_id, node_uid);
    let v = state_get(iii, SCOPE_RESULT, &key).await?;
    if v.is_null() {
        Ok(None)
    } else {
        Ok(Some(v))
    }
}

pub async fn delete_node_result(
    iii: &IIIClient,
    run_id: &str,
    node_uid: &str,
) -> Result<(), WorkflowError> {
    let key = node_result_key(run_id, node_uid);
    state_delete(iii, SCOPE_RESULT, &key).await
}

/// For each `NodeState::Done` checkpoint that has a `result_ref`, fetch the
/// stored result and collect into a `node_uid → result` map.
pub async fn load_done_results(
    iii: &IIIClient,
    record: &mut WorkflowRunRecord,
) -> Result<BTreeMap<String, Value>, WorkflowError> {
    let mut out = BTreeMap::new();
    let mut corrupt: Vec<String> = Vec::new();
    for (node_uid, checkpoint) in &record.nodes {
        if checkpoint.state == NodeState::Done && checkpoint.result_ref.is_some() {
            match get_node_result(iii, &record.run_id, node_uid).await? {
                Some(result) => {
                    out.insert(node_uid.clone(), result);
                }
                None => corrupt.push(node_uid.clone()),
            }
        }
    }
    // A Done node always has its result persisted before it is marked Done
    // (reconcile). A missing one is state corruption. Do NOT hard-error: that
    // fails EVERY tick for this run forever — the run wedges in AwaitingNodes and
    // the sweep re-enqueues a dying tick each cycle. Instead mark the node Failed
    // so `quiescence` fails the run cleanly with a diagnosable message, rather
    // than feeding Null downstream (which would derail gather_input / fanout).
    for node_uid in corrupt {
        if let Some(cp) = record.nodes.get_mut(&node_uid) {
            cp.state = NodeState::Failed;
            cp.result_error = Some(
                "Done checkpoint has a result_ref but the stored result is missing \
                 (state corruption)"
                    .to_string(),
            );
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Session reverse index (session_id -> run_id)
// ---------------------------------------------------------------------------
//
// Written when a node is fired; read by `workflow::wake` to map a harness
// `turn-completed` event back to its owning run. Only `run_id` is stored —
// waking re-ticks the whole run, so the node_uid isn't needed.

pub async fn put_session_index(
    iii: &IIIClient,
    session_id: &str,
    run_id: &str,
) -> Result<(), WorkflowError> {
    state_set(iii, SCOPE_INDEX, session_id, json!(run_id)).await
}

pub async fn run_id_for_session(
    iii: &IIIClient,
    session_id: &str,
) -> Result<Option<String>, WorkflowError> {
    let v = state_get(iii, SCOPE_INDEX, session_id).await?;
    if v.is_null() {
        Ok(None)
    } else {
        let s = v
            .as_str()
            .ok_or_else(|| WorkflowError::State(format!("session index not a string: {v}")))?
            .to_string();
        Ok(Some(s))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkflowRunLogBucket {
    run_id: String,
    #[serde(default)]
    logs: Vec<WorkflowRunLogRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkflowRunTraceBucket {
    run_id: String,
    #[serde(default)]
    traces: Vec<WorkflowRunTraceRecord>,
}

async fn get_run_log_bucket(
    iii: &IIIClient,
    run_id: &str,
) -> Result<Option<WorkflowRunLogBucket>, WorkflowError> {
    let v = state_get(iii, SCOPE_RUN_LOG, run_id).await?;
    if v.is_null() {
        return Ok(None);
    }
    Ok(Some(from_value(v)?))
}

async fn get_run_trace_bucket(
    iii: &IIIClient,
    run_id: &str,
) -> Result<Option<WorkflowRunTraceBucket>, WorkflowError> {
    let v = state_get(iii, SCOPE_RUN_TRACE, run_id).await?;
    if v.is_null() {
        return Ok(None);
    }
    Ok(Some(from_value(v)?))
}

pub async fn put_run_log(
    iii: &IIIClient,
    entry: &WorkflowRunLogRecord,
) -> Result<(), WorkflowError> {
    let mut bucket = get_run_log_bucket(iii, &entry.run_id)
        .await?
        .unwrap_or_else(|| WorkflowRunLogBucket {
            run_id: entry.run_id.clone(),
            logs: Vec::new(),
        });

    if let Some(existing) = bucket.logs.iter_mut().find(|item| item.id == entry.id) {
        *existing = entry.clone();
    } else {
        bucket.logs.push(entry.clone());
    }

    state_set(iii, SCOPE_RUN_LOG, &entry.run_id, serde_json::to_value(bucket)?).await
}

pub async fn list_run_logs(
    iii: &IIIClient,
    run_id: &str,
) -> Result<Vec<WorkflowRunLogRecord>, WorkflowError> {
    if let Some(bucket) = get_run_log_bucket(iii, run_id).await? {
        return Ok(bucket.logs);
    }

    // Backward-compat: still read old per-entry rows during migration.
    let v = state_list(iii, SCOPE_RUN_LOG).await?;
    Ok(parse_state_list_values(&v)
        .into_iter()
        .filter_map(|item| from_value::<WorkflowRunLogRecord>(item).ok())
        .filter(|entry| entry.run_id == run_id)
        .collect())
}

pub async fn delete_run_log_key(
    iii: &IIIClient,
    run_id: &str,
    id: &str,
) -> Result<(), WorkflowError> {
    if let Some(mut bucket) = get_run_log_bucket(iii, run_id).await? {
        bucket.logs.retain(|item| item.id != id);
        return state_set(iii, SCOPE_RUN_LOG, run_id, serde_json::to_value(bucket)?).await;
    }

    // Backward-compat cleanup path for old per-entry rows.
    state_delete(iii, SCOPE_RUN_LOG, &format!("{run_id}/{id}")).await
}

pub async fn delete_run_logs(iii: &IIIClient, run_id: &str) -> Result<(), WorkflowError> {
    state_delete(iii, SCOPE_RUN_LOG, run_id).await
}

pub async fn prune_run_logs_before(
    iii: &IIIClient,
    run_id: &str,
    cutoff_unix_ms: i64,
) -> Result<u64, WorkflowError> {
    if let Some(mut bucket) = get_run_log_bucket(iii, run_id).await? {
        let before = bucket.logs.len();
        bucket.logs.retain(|item| item.ts_unix_ms >= cutoff_unix_ms);
        let removed = (before.saturating_sub(bucket.logs.len())) as u64;
        if removed > 0 {
            state_set(iii, SCOPE_RUN_LOG, run_id, serde_json::to_value(bucket)?).await?;
        }
        return Ok(removed);
    }

    // Backward-compat path for old per-entry rows.
    let mut removed = 0u64;
    for item in list_run_logs(iii, run_id).await? {
        if item.ts_unix_ms < cutoff_unix_ms {
            delete_run_log_key(iii, run_id, &item.id).await?;
            removed += 1;
        }
    }
    Ok(removed)
}

pub async fn put_run_trace(
    iii: &IIIClient,
    entry: &WorkflowRunTraceRecord,
) -> Result<(), WorkflowError> {
    let mut bucket = get_run_trace_bucket(iii, &entry.run_id)
        .await?
        .unwrap_or_else(|| WorkflowRunTraceBucket {
            run_id: entry.run_id.clone(),
            traces: Vec::new(),
        });

    if let Some(existing) = bucket.traces.iter_mut().find(|item| item.id == entry.id) {
        *existing = entry.clone();
    } else {
        bucket.traces.push(entry.clone());
    }

    state_set(iii, SCOPE_RUN_TRACE, &entry.run_id, serde_json::to_value(bucket)?).await
}

pub async fn list_run_traces(
    iii: &IIIClient,
    run_id: &str,
) -> Result<Vec<WorkflowRunTraceRecord>, WorkflowError> {
    if let Some(bucket) = get_run_trace_bucket(iii, run_id).await? {
        return Ok(bucket.traces);
    }

    // Backward-compat: still read old per-entry rows during migration.
    let v = state_list(iii, SCOPE_RUN_TRACE).await?;
    Ok(parse_state_list_values(&v)
        .into_iter()
        .filter_map(|item| from_value::<WorkflowRunTraceRecord>(item).ok())
        .filter(|entry| entry.run_id == run_id)
        .collect())
}

pub async fn delete_run_trace_key(
    iii: &IIIClient,
    run_id: &str,
    id: &str,
) -> Result<(), WorkflowError> {
    if let Some(mut bucket) = get_run_trace_bucket(iii, run_id).await? {
        bucket.traces.retain(|item| item.id != id);
        return state_set(iii, SCOPE_RUN_TRACE, run_id, serde_json::to_value(bucket)?).await;
    }

    // Backward-compat cleanup path for old per-entry rows.
    state_delete(iii, SCOPE_RUN_TRACE, &format!("{run_id}/{id}")).await
}

pub async fn delete_run_traces(iii: &IIIClient, run_id: &str) -> Result<(), WorkflowError> {
    state_delete(iii, SCOPE_RUN_TRACE, run_id).await
}

pub async fn prune_run_traces_before(
    iii: &IIIClient,
    run_id: &str,
    cutoff_unix_ms: i64,
) -> Result<u64, WorkflowError> {
    if let Some(mut bucket) = get_run_trace_bucket(iii, run_id).await? {
        let before = bucket.traces.len();
        bucket.traces.retain(|item| item.ts_unix_ms >= cutoff_unix_ms);
        let removed = (before.saturating_sub(bucket.traces.len())) as u64;
        if removed > 0 {
            state_set(iii, SCOPE_RUN_TRACE, run_id, serde_json::to_value(bucket)?).await?;
        }
        return Ok(removed);
    }

    // Backward-compat path for old per-entry rows.
    let mut removed = 0u64;
    for item in list_run_traces(iii, run_id).await? {
        if item.ts_unix_ms < cutoff_unix_ms {
            delete_run_trace_key(iii, run_id, &item.id).await?;
            removed += 1;
        }
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

pub async fn get_idem(iii: &IIIClient, key: &str) -> Result<Option<String>, WorkflowError> {
    let v = state_get(iii, SCOPE_IDEM, key).await?;
    if v.is_null() {
        Ok(None)
    } else {
        let s = v
            .as_str()
            .ok_or_else(|| WorkflowError::State(format!("idem value not a string: {v}")))?
            .to_string();
        Ok(Some(s))
    }
}

pub async fn put_idem(iii: &IIIClient, key: &str, run_id: &str) -> Result<(), WorkflowError> {
    state_set(iii, SCOPE_IDEM, key, json!(run_id)).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal_record_json() -> Value {
        json!({
            "run_id": "r_1",
            "step": 0,
            "status": "running",
            "def_ref": "r_1",
            "input": {},
            "created_at": 1,
            "updated_at": 1
        })
    }

    #[test]
    fn scopes_are_flat_strings() {
        assert_eq!(SCOPE_RUN, "workflow_run");
        assert_eq!(SCOPE_RESULT, "workflow_node_result");
        assert_eq!(SCOPE_INDEX, "workflow_session_index");
        assert_eq!(SCOPE_RUN_LOG, "workflow_run_log");
        assert_eq!(SCOPE_RUN_TRACE, "workflow_run_trace");
        // Verify they are never "workflow_run/<id>" style — no slashes
        assert!(!SCOPE_RUN.contains('/'));
        assert!(!SCOPE_DEF.contains('/'));
        assert!(!SCOPE_RESULT.contains('/'));
        assert!(!SCOPE_INDEX.contains('/'));
        assert!(!SCOPE_RUN_LOG.contains('/'));
        assert!(!SCOPE_RUN_TRACE.contains('/'));
        assert!(!SCOPE_IDEM.contains('/'));
    }

    #[test]
    fn parse_record_list_tolerates_array_object_and_map() {
        let rec = minimal_record_json();

        // Shape 1: bare array
        let v1 = json!([rec.clone()]);
        let list1 = parse_record_list(&v1);
        assert_eq!(list1.len(), 1, "bare array should yield 1 record");
        assert_eq!(list1[0].run_id, "r_1");

        // Shape 2: object with "values" key
        let v2 = json!({ "values": [rec.clone()] });
        let list2 = parse_record_list(&v2);
        assert_eq!(list2.len(), 1, "{{values:[...]}} should yield 1 record");
        assert_eq!(list2[0].run_id, "r_1");

        // Shape 2b: object with "items" key
        let v2b = json!({ "items": [rec.clone()] });
        let list2b = parse_record_list(&v2b);
        assert_eq!(list2b.len(), 1, "{{items:[...]}} should yield 1 record");
        assert_eq!(list2b[0].run_id, "r_1");

        // Shape 3: key→value map
        let v3 = json!({ "r_1": rec.clone() });
        let list3 = parse_record_list(&v3);
        assert_eq!(list3.len(), 1, "key→value map should yield 1 record");
        assert_eq!(list3[0].run_id, "r_1");
    }

}
