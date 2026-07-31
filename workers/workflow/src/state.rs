use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use iii_sdk::protocol::TriggerRequest;
use iii_sdk::IIIClient;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{from_value, json, Value};

use crate::{
    error::WorkflowError,
    ids,
    internal_state::{ListRunsFilter, WorkflowInternalStateStore},
    types::{
        NodeState, QueueReceiptRecord, RunStatus, WorkflowDef, WorkflowRunRecord,
        WorkflowVarRecord,
    },
};

static INTERNAL_STATE_STORE: OnceLock<Arc<dyn WorkflowInternalStateStore>> = OnceLock::new();

pub fn set_internal_state_store(store: Arc<dyn WorkflowInternalStateStore>) {
    if INTERNAL_STATE_STORE.set(store).is_err() {
        tracing::warn!("internal state store already initialized; keeping first instance");
    }
}

fn internal_state_store() -> Option<&'static Arc<dyn WorkflowInternalStateStore>> {
    INTERNAL_STATE_STORE.get()
}

fn require_internal_state_store(
) -> Result<&'static Arc<dyn WorkflowInternalStateStore>, WorkflowError> {
    internal_state_store().ok_or_else(|| {
        WorkflowError::State(
            "internal workflow state store is not initialized; call state::set_internal_state_store at boot"
                .to_string(),
        )
    })
}

// ---------------------------------------------------------------------------
// Scope constants
// ---------------------------------------------------------------------------

pub const SCOPE_RUN: &str = "workflow_run";
pub const SCOPE_RUN_STATE: &str = "workflow_run_state";
pub const STREAM_NAME_WORKFLOW: &str = "workflow";
pub const RUN_SCOPED_KEY_SEPARATOR: &str = "_";
pub const STATE_REGISTRY_KEY_PREFIX: &str = "k_";

pub fn run_scoped_key(run_id: &str, key: &str) -> String {
    format!("{run_id}{RUN_SCOPED_KEY_SEPARATOR}{key}")
}

pub fn run_scoped_prefix(run_id: &str) -> String {
    format!("{run_id}{RUN_SCOPED_KEY_SEPARATOR}")
}

pub fn encode_state_registry_key(key: &str) -> String {
    let mut encoded = String::with_capacity(key.len() * 2);
    for byte in key.as_bytes() {
        encoded.push(nibble_to_hex(byte >> 4));
        encoded.push(nibble_to_hex(byte & 0x0f));
    }
    encoded
}

pub fn decode_state_registry_key(encoded: &str) -> Option<String> {
    let encoded = encoded.strip_prefix(STATE_REGISTRY_KEY_PREFIX)?;
    if !encoded.len().is_multiple_of(2) {
        return None;
    }

    let mut bytes = Vec::with_capacity(encoded.len() / 2);
    let mut iter = encoded.as_bytes().iter().copied();
    while let Some(high) = iter.next() {
        let low = iter.next()?;
        let hi = hex_to_nibble(high)?;
        let lo = hex_to_nibble(low)?;
        bytes.push((hi << 4) | lo);
    }

    String::from_utf8(bytes).ok()
}

pub fn state_registry_encoded_key(key: &str) -> String {
    format!(
        "{}{}",
        STATE_REGISTRY_KEY_PREFIX,
        encode_state_registry_key(key)
    )
}

fn nibble_to_hex(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'a' + (n - 10)) as char,
        _ => '0',
    }
}

fn hex_to_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(10 + b - b'a'),
        b'A'..=b'F' => Some(10 + b - b'A'),
        _ => None,
    }
}
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

pub async fn state_get(iii: &IIIClient, scope: &str, key: &str) -> Result<Value, WorkflowError> {
    iii.trigger(TriggerRequest {
        function_id: "state::get".into(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: Some(dispatch_timeout_ms()),
    })
    .await
    .map_err(|e| WorkflowError::State(format!("state::get {scope}/{key}: {e}")))
}

pub async fn state_set(
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

pub async fn state_delete(iii: &IIIClient, scope: &str, key: &str) -> Result<(), WorkflowError> {
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

pub async fn state_list(iii: &IIIClient, scope: &str) -> Result<Value, WorkflowError> {
    iii.trigger(TriggerRequest {
        function_id: "state::list".into(),
        payload: json!({ "scope": scope }),
        action: None,
        timeout_ms: Some(dispatch_timeout_ms()),
    })
    .await
    .map_err(|e| WorkflowError::State(format!("state::list {scope}: {e}")))
}

async fn stream_list(
    iii: &IIIClient,
    stream_name: &str,
    group_id: &str,
) -> Result<Value, WorkflowError> {
    iii.trigger(TriggerRequest {
        function_id: "stream::list".into(),
        payload: json!({ "stream_name": stream_name, "group_id": group_id }),
        action: None,
        timeout_ms: Some(dispatch_timeout_ms()),
    })
    .await
    .map_err(|e| WorkflowError::State(format!("stream::list {stream_name}/{group_id}: {e}")))
}

async fn stream_delete(
    iii: &IIIClient,
    stream_name: &str,
    group_id: &str,
    item_id: &str,
) -> Result<(), WorkflowError> {
    iii.trigger(TriggerRequest {
        function_id: "stream::delete".into(),
        payload: json!({ "stream_name": stream_name, "group_id": group_id, "item_id": item_id }),
        action: None,
        timeout_ms: Some(dispatch_timeout_ms()),
    })
    .await
    .map(|_| ())
    .map_err(|e| {
        WorkflowError::State(format!(
            "stream::delete {stream_name}/{group_id}/{item_id}: {e}"
        ))
    })
}

fn parse_stream_item_ids(v: &Value) -> Vec<String> {
    let mut ids = Vec::new();

    if let Some(arr) = v.as_array() {
        for item in arr {
            if let Some(id) = item
                .get("id")
                .and_then(|x| x.as_str())
                .or_else(|| item.get("item_id").and_then(|x| x.as_str()))
                .or_else(|| item.get("key").and_then(|x| x.as_str()))
            {
                if !id.is_empty() {
                    ids.push(id.to_string());
                }
            }
        }
        return ids;
    }

    if let Some(obj) = v.as_object() {
        if let Some(arr) = obj.get("values").and_then(|x| x.as_array()) {
            for item in arr {
                if let Some(id) = item
                    .get("id")
                    .and_then(|x| x.as_str())
                    .or_else(|| item.get("item_id").and_then(|x| x.as_str()))
                    .or_else(|| item.get("key").and_then(|x| x.as_str()))
                {
                    if !id.is_empty() {
                        ids.push(id.to_string());
                    }
                }
            }
            return ids;
        }

        if let Some(arr) = obj.get("items").and_then(|x| x.as_array()) {
            for item in arr {
                if let Some(id) = item
                    .get("id")
                    .and_then(|x| x.as_str())
                    .or_else(|| item.get("item_id").and_then(|x| x.as_str()))
                    .or_else(|| item.get("key").and_then(|x| x.as_str()))
                {
                    if !id.is_empty() {
                        ids.push(id.to_string());
                    }
                }
            }
            return ids;
        }

        // Key->value map shape: key IS the stream item_id.
        ids.extend(obj.keys().filter(|k| !k.is_empty()).cloned());
    }

    ids
}

async fn delete_run_state_entries_from_registry(
    iii: &IIIClient,
    record: &WorkflowRunRecord,
) -> Result<(), WorkflowError> {
    for (encoded_key, present) in &record.state_keys_map {
        if !*present {
            continue;
        }
        if let Some(key) = decode_state_registry_key(encoded_key) {
            let scoped_key = run_scoped_key(&record.run_id, &key);
            state_delete(iii, SCOPE_RUN_STATE, &scoped_key).await?;
        }
    }
    Ok(())
}

async fn delete_run_stream_entries(
    iii: &IIIClient,
    stream_name: &str,
    group_id: &str,
) -> Result<(), WorkflowError> {
    let v = stream_list(iii, stream_name, group_id).await?;

    for item_id in parse_stream_item_ids(&v) {
        stream_delete(iii, stream_name, group_id, &item_id).await?;
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
        .map(normalize_numeric_object_arrays)
        .filter_map(|item| from_value::<WorkflowRunRecord>(item).ok())
        .collect()
}

fn normalize_numeric_object_arrays(value: Value) -> Value {
    match value {
        Value::Array(arr) => Value::Array(
            arr.into_iter()
                .map(normalize_numeric_object_arrays)
                .collect(),
        ),
        Value::Object(obj) => {
            let normalized: BTreeMap<String, Value> = obj
                .into_iter()
                .map(|(k, v)| (k, normalize_numeric_object_arrays(v)))
                .collect();

            if normalized.is_empty() {
                return Value::Object(normalized.into_iter().collect());
            }

            let mut indexed: Vec<(usize, Value)> = Vec::with_capacity(normalized.len());
            for (k, v) in &normalized {
                let Ok(idx) = k.parse::<usize>() else {
                    return Value::Object(normalized.into_iter().collect());
                };
                indexed.push((idx, v.clone()));
            }

            indexed.sort_by_key(|(idx, _)| *idx);
            for (position, (idx, _)) in indexed.iter().enumerate() {
                if *idx != position {
                    return Value::Object(normalized.into_iter().collect());
                }
            }

            Value::Array(indexed.into_iter().map(|(_, v)| v).collect())
        }
        other => other,
    }
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
    _iii: &IIIClient,
    run_id: &str,
) -> Result<Option<WorkflowRunRecord>, WorkflowError> {
    require_internal_state_store()?.get_run(run_id).await
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
pub async fn put_run(_iii: &IIIClient, record: &WorkflowRunRecord) -> Result<(), WorkflowError> {
    require_internal_state_store()?.put_run(record, None).await
}

pub async fn list_runs(_iii: &IIIClient) -> Result<Vec<WorkflowRunRecord>, WorkflowError> {
    require_internal_state_store()?.list_runs().await
}

pub async fn list_runs_filtered(
    _iii: &IIIClient,
    status: Option<RunStatus>,
    workflow: Option<String>,
) -> Result<Vec<WorkflowRunRecord>, WorkflowError> {
    require_internal_state_store()?
        .list_runs_filtered(&ListRunsFilter { status, workflow })
        .await
}

pub async fn set_state_registry_key_presence(
    run_id: &str,
    key: &str,
    present: bool,
) -> Result<(), WorkflowError> {
    let store = require_internal_state_store()?;
    let Some(mut run) = store.get_run(run_id).await? else {
        return Ok(());
    };

    apply_state_registry_key_presence(&mut run, key, present, ids::now_ms());
    store.put_run(&run, None).await
}

fn apply_state_registry_key_presence(
    run: &mut WorkflowRunRecord,
    key: &str,
    present: bool,
    now_ms: i64,
) {
    run.state_keys_map
        .insert(state_registry_encoded_key(key), present);
    run.updated_at = now_ms;
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
    for (node_uid, cp) in &record.nodes {
        if cp.result_ref.is_some() {
            delete_node_result(iii, &record.run_id, node_uid).await?;
        }
        if let Some(session_id) = cp.session_id.as_deref() {
            delete_session_index(iii, session_id).await?;
        }
    }
    delete_run_state_entries_from_registry(iii, record).await?;

    let stream_group_id = record.stream_scope_id.as_deref().unwrap_or(&record.run_id);
    for stream_name in &record.stream_ids {
        delete_run_stream_entries(iii, stream_name, stream_group_id).await?;
    }

    // No backward-compat cleanup paths: this worker runs only the v1 data model.
    delete_run_input(iii, &record.run_id).await?;
    delete_run_vars(iii, &record.run_id).await?;
    delete_run_result(iii, &record.run_id).await?;
    delete_def(iii, &record.run_id).await?;
    delete_run_logs(iii, &record.run_id).await?;
    delete_run_traces(iii, &record.run_id).await?;
    delete_run_queue_receipts(iii, &record.run_id).await?;
    require_internal_state_store()?
        .delete_run(&record.run_id)
        .await
}

pub async fn put_queue_receipt(
    iii: &IIIClient,
    run_id: &str,
    node_uid: &str,
    function_id: &str,
    queue: &str,
    receipt_id: &str,
    attempt: u32,
    ts_unix_ms: i64,
) -> Result<(), WorkflowError> {
    let id = format!("{}:{}:{}", run_id, node_uid, receipt_id);
    let record = QueueReceiptRecord {
        id: id.clone(),
        run_id: run_id.to_string(),
        node_uid: node_uid.to_string(),
        function_id: function_id.to_string(),
        queue: queue.to_string(),
        receipt_id: receipt_id.to_string(),
        attempt,
        ts_unix_ms,
    };

    let mut run = get_run(iii, run_id).await?.ok_or_else(|| {
        WorkflowError::State(format!("put_queue_receipt: run not found: {run_id}"))
    })?;

    // Replace-by-id to keep updates idempotent for retried enqueue paths.
    if let Some(existing) = run.queue_receipts.iter_mut().find(|r| r.id == id) {
        *existing = record;
    } else {
        run.queue_receipts.push(record);
    }
    run.updated_at = ids::now_ms();
    put_run(iii, &run).await
}

pub async fn list_queue_receipts(
    iii: &IIIClient,
    run_id: &str,
) -> Result<Vec<QueueReceiptRecord>, WorkflowError> {
    let run = get_run(iii, run_id).await?;
    Ok(run.map(|r| r.queue_receipts).unwrap_or_default())
}

pub async fn delete_run_queue_receipts(iii: &IIIClient, run_id: &str) -> Result<(), WorkflowError> {
    if let Some(mut run) = get_run(iii, run_id).await? {
        if !run.queue_receipts.is_empty() {
            run.queue_receipts.clear();
            run.updated_at = ids::now_ms();
            put_run(iii, &run).await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

pub async fn put_def(
    _iii: &IIIClient,
    run_id: &str,
    def: &WorkflowDef,
) -> Result<(), WorkflowError> {
    require_internal_state_store()?.put_def(run_id, def).await
}

pub async fn get_def(_iii: &IIIClient, run_id: &str) -> Result<Option<WorkflowDef>, WorkflowError> {
    require_internal_state_store()?.get_def(run_id).await
}

pub async fn delete_def(_iii: &IIIClient, run_id: &str) -> Result<(), WorkflowError> {
    require_internal_state_store()?.delete_def(run_id).await
}

// ---------------------------------------------------------------------------
// Run input
// ---------------------------------------------------------------------------

pub async fn put_run_input(
    _iii: &IIIClient,
    run_id: &str,
    input: &Value,
) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .put_run_input(run_id, input)
        .await
}

pub async fn get_run_input(_iii: &IIIClient, run_id: &str) -> Result<Option<Value>, WorkflowError> {
    require_internal_state_store()?.get_run_input(run_id).await
}

pub async fn delete_run_input(_iii: &IIIClient, run_id: &str) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .delete_run_input(run_id)
        .await
}

pub async fn put_run_vars(
    _iii: &IIIClient,
    run_id: &str,
    vars: &BTreeMap<String, WorkflowVarRecord>,
) -> Result<(), WorkflowError> {
    let encoded = serde_json::to_value(vars).map_err(WorkflowError::Serde)?;
    require_internal_state_store()?.put_run_vars(run_id, &encoded).await
}

pub async fn get_run_vars(
    _iii: &IIIClient,
    run_id: &str,
) -> Result<BTreeMap<String, WorkflowVarRecord>, WorkflowError> {
    let Some(raw) = require_internal_state_store()?.get_run_vars(run_id).await? else {
        return Ok(BTreeMap::new());
    };

    serde_json::from_value::<BTreeMap<String, WorkflowVarRecord>>(raw).map_err(WorkflowError::Serde)
}

pub async fn delete_run_vars(_iii: &IIIClient, run_id: &str) -> Result<(), WorkflowError> {
    require_internal_state_store()?.delete_run_vars(run_id).await
}

pub async fn put_run_result(
    _iii: &IIIClient,
    run_id: &str,
    result: &Value,
) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .put_run_result(run_id, result)
        .await
}

pub async fn get_run_result(
    _iii: &IIIClient,
    run_id: &str,
) -> Result<Option<Value>, WorkflowError> {
    require_internal_state_store()?.get_run_result(run_id).await
}

pub async fn delete_run_result(_iii: &IIIClient, run_id: &str) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .delete_run_result(run_id)
        .await
}

// ---------------------------------------------------------------------------
// Node results
// ---------------------------------------------------------------------------

pub async fn put_node_result(
    _iii: &IIIClient,
    run_id: &str,
    node_uid: &str,
    result: &Value,
) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .put_node_result(run_id, node_uid, result)
        .await
}

pub async fn get_node_result(
    _iii: &IIIClient,
    run_id: &str,
    node_uid: &str,
) -> Result<Option<Value>, WorkflowError> {
    require_internal_state_store()?
        .get_node_result(run_id, node_uid)
        .await
}

pub async fn delete_node_result(
    _iii: &IIIClient,
    run_id: &str,
    node_uid: &str,
) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .delete_node_result(run_id, node_uid)
        .await
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
    _iii: &IIIClient,
    session_id: &str,
    run_id: &str,
) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .put_session_index(session_id, run_id)
        .await
}

pub async fn run_id_for_session(
    _iii: &IIIClient,
    session_id: &str,
) -> Result<Option<String>, WorkflowError> {
    require_internal_state_store()?
        .run_id_for_session(session_id)
        .await
}

pub async fn delete_session_index(_iii: &IIIClient, session_id: &str) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .delete_session_index(session_id)
        .await
}

pub async fn put_run_log(
    _iii: &IIIClient,
    entry: &WorkflowRunLogRecord,
) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .put_run_log(&entry.run_id, entry)
        .await
}

pub async fn list_run_logs(
    _iii: &IIIClient,
    run_id: &str,
) -> Result<Vec<WorkflowRunLogRecord>, WorkflowError> {
    require_internal_state_store()?.list_run_logs(run_id).await
}

pub async fn list_run_logs_paged(
    _iii: &IIIClient,
    run_id: &str,
    offset: u32,
    limit: u32,
) -> Result<(Vec<WorkflowRunLogRecord>, bool), WorkflowError> {
    require_internal_state_store()?
        .list_run_logs_paged(run_id, offset, limit)
        .await
}

pub async fn delete_run_log_key(
    _iii: &IIIClient,
    run_id: &str,
    id: &str,
) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .delete_run_log_key(run_id, id)
        .await
}

pub async fn delete_run_logs(_iii: &IIIClient, run_id: &str) -> Result<(), WorkflowError> {
    let store = require_internal_state_store()?;
    let logs = store.list_run_logs(run_id).await?;
    for entry in logs {
        store.delete_run_log_key(run_id, &entry.id).await?;
    }
    Ok(())
}

pub async fn prune_run_logs_before(
    _iii: &IIIClient,
    run_id: &str,
    cutoff_unix_ms: i64,
) -> Result<u64, WorkflowError> {
    require_internal_state_store()?
        .prune_run_logs_before(run_id, cutoff_unix_ms)
        .await
}

pub async fn put_run_trace(
    _iii: &IIIClient,
    entry: &WorkflowRunTraceRecord,
) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .put_run_trace(&entry.run_id, entry)
        .await
}

pub async fn list_run_traces(
    _iii: &IIIClient,
    run_id: &str,
) -> Result<Vec<WorkflowRunTraceRecord>, WorkflowError> {
    require_internal_state_store()?
        .list_run_traces(run_id)
        .await
}

pub async fn list_run_traces_paged(
    _iii: &IIIClient,
    run_id: &str,
    offset: u32,
    limit: u32,
) -> Result<(Vec<WorkflowRunTraceRecord>, bool), WorkflowError> {
    require_internal_state_store()?
        .list_run_traces_paged(run_id, offset, limit)
        .await
}

pub async fn delete_run_trace_key(
    _iii: &IIIClient,
    run_id: &str,
    id: &str,
) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .delete_run_trace_key(run_id, id)
        .await
}

pub async fn delete_run_traces(_iii: &IIIClient, run_id: &str) -> Result<(), WorkflowError> {
    let store = require_internal_state_store()?;
    let traces = store.list_run_traces(run_id).await?;
    for entry in traces {
        store.delete_run_trace_key(run_id, &entry.id).await?;
    }
    Ok(())
}

pub async fn prune_run_traces_before(
    _iii: &IIIClient,
    run_id: &str,
    cutoff_unix_ms: i64,
) -> Result<u64, WorkflowError> {
    require_internal_state_store()?
        .prune_run_traces_before(run_id, cutoff_unix_ms)
        .await
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

pub async fn get_idem(_iii: &IIIClient, key: &str) -> Result<Option<String>, WorkflowError> {
    require_internal_state_store()?
        .run_id_for_idempotency_key(key)
        .await
}

pub async fn put_idem(_iii: &IIIClient, key: &str, run_id: &str) -> Result<(), WorkflowError> {
    require_internal_state_store()?
        .put_idempotency_key(key, run_id, None)
        .await
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
            "input_ref": "r_1",
            "created_at": 1,
            "updated_at": 1
        })
    }

    #[test]
    fn active_iii_scopes_are_flat_strings() {
        assert_eq!(SCOPE_RUN, "workflow_run");
        // Verify they are never "workflow_run/<id>" style — no slashes
        assert!(!SCOPE_RUN.contains('/'));
        assert!(!SCOPE_RUN_STATE.contains('/'));
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

    #[test]
    fn parse_record_list_normalizes_numeric_keyed_sequence_objects() {
        let mut rec = minimal_record_json();
        rec["stream_ids"] = json!({
            "0": "workflow",
            "1": "timeline"
        });
        rec["fanout_src"] = json!({
            "classify": {
                "0": { "id": "a" },
                "1": { "id": "b" }
            }
        });

        let list = parse_record_list(&json!([rec]));
        assert_eq!(list.len(), 1, "numeric-keyed sequence object should parse");
        assert_eq!(list[0].stream_ids, vec!["workflow", "timeline"]);
        assert_eq!(
            list[0].fanout_src.get("classify").map(|items| items.len()),
            Some(2)
        );
    }

    #[test]
    fn registry_key_encoding_roundtrip_and_path() {
        let raw = "node.result/key.with:chars and spaces";
        let encoded = encode_state_registry_key(raw);
        let prefixed = format!("{STATE_REGISTRY_KEY_PREFIX}{encoded}");
        let decoded = decode_state_registry_key(&prefixed).expect("decode encoded key");

        assert_eq!(decoded, raw);
        assert_eq!(state_registry_encoded_key(raw), prefixed);
    }

    #[test]
    fn registry_key_decode_rejects_invalid_hex() {
        assert!(
            decode_state_registry_key("abc").is_none(),
            "missing prefix must fail"
        );
        assert!(
            decode_state_registry_key("k_abc").is_none(),
            "odd-length hex must fail"
        );
        assert!(
            decode_state_registry_key("k_zz").is_none(),
            "non-hex bytes must fail"
        );
    }

    #[test]
    fn apply_state_registry_key_presence_sets_encoded_key_and_timestamp() {
        let mut record: WorkflowRunRecord =
            serde_json::from_value(minimal_record_json()).expect("minimal record should decode");

        apply_state_registry_key_presence(&mut record, "result.value", true, 42);

        assert_eq!(record.updated_at, 42);
        let encoded_key = state_registry_encoded_key("result.value");
        assert_eq!(record.state_keys_map.get(&encoded_key), Some(&true));
    }

    #[test]
    fn apply_state_registry_key_presence_can_flip_presence_false() {
        let mut record: WorkflowRunRecord =
            serde_json::from_value(minimal_record_json()).expect("minimal record should decode");

        apply_state_registry_key_presence(&mut record, "counter", true, 10);
        apply_state_registry_key_presence(&mut record, "counter", false, 11);

        let encoded_key = state_registry_encoded_key("counter");
        assert_eq!(record.state_keys_map.get(&encoded_key), Some(&false));
        assert_eq!(record.updated_at, 11);
    }
}
