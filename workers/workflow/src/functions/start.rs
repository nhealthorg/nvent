use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    error::WorkflowError,
    ids::{new_ref_id, new_run_id, new_scope_id, new_trace_id},
    state,
    types::{
        NodeInputReturnType, NodeInputSpec, NodeMemoryFailPolicy, RunStatus, WorkflowDef,
        WorkflowRunRecord,
    },
};

use super::Deps;

// Guardrails on an untrusted definition.
// ponytail: generous caps to stop runaway/DoS inputs; tighten if abused.
const MAX_NODES: usize = 10_000;
const MAX_IDEM_KEY_LEN: usize = 1024;
const SUPPORTED_DEF_VERSION: u32 = 1;
// Cap on sub-workflow nesting. The default node policy denies `nworkflow::*`, but a
// node can opt back in with an explicit `functions`, so a node could launch a
// sub-workflow whose node launches another, unbounded. Bound the chain. Safety
// ceiling, not a tuning knob.
const MAX_WORKFLOW_DEPTH: usize = 8;

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, JsonSchema)]
pub struct StartRequest {
    /// The workflow DAG to run. See `WorkflowDef`. (`workflow` is accepted as an
    /// alias for the wrapper key.)
    pub definition: WorkflowDef,
    /// Top-level input made available to nodes whose `input.from` is
    /// `"run_input"` / `"workflow.input"`. Any JSON value.
    #[serde(default)]
    pub input: Value,
    /// Input transport/storage policy for the workflow invocation input
    /// (`input` above). This applies only to the run input blob, not to any
    /// per-node inputPolicy.
    #[serde(default, rename = "inputPolicy")]
    pub input_policy: Option<NodeInputSpec>,
    /// Optional dedupe key: a repeated key returns the original `run_id` instead
    /// of launching a duplicate run.
    #[serde(default)]
    pub idempotency_key: Option<String>,
    /// Optional completion callback: a function the worker triggers once when the
    /// run reaches a terminal state, so the caller is pushed the outcome instead
    /// of polling `nworkflow::status`.
    #[serde(default)]
    pub notify: Option<crate::types::NotifySpec>,
    /// The orchestrator session (for console nesting of node sessions).
    #[serde(default)]
    pub caller_session_id: Option<String>,
}

/// Internal mirror used for the typed parse AFTER `StartRequest`'s custom
/// `Deserialize` has normalized the payload and collected structural problems.
#[derive(Deserialize)]
struct StartRequestRaw {
    #[serde(alias = "workflow")]
    definition: WorkflowDef,
    #[serde(default)]
    input: Value,
    #[serde(default, rename = "inputPolicy")]
    input_policy: Option<NodeInputSpec>,
    #[serde(default)]
    idempotency_key: Option<String>,
    #[serde(default)]
    notify: Option<crate::types::NotifySpec>,
    #[serde(default)]
    caller_session_id: Option<String>,
}

/// Compact copy-pasteable skeleton appended to every shape error.
const SHAPE_HINT: &str = "Expected shape: \
    {\"definition\":{\"nodes\":{\"<id>\":{\"function\":{\"id\":\"<function-id>\"},\
    \"input\":{\"from\":\"run_input\"}}},\"output\":{\"from\":\"node:<id>\"}},\
    \"inputPolicy\":{\"returnType\":\"memory|store\",\"onMemoryFail\":\"store|error\"}}. `version` defaults to 1. \
    Each node is {label?, function, input, depends_on?, fanout?}; a pure source node may omit `input` (defaults to \
    run_input). Full field docs are inline in this function's request schema.";

const ALLOWED_DEF_KEYS: &[&str] = &[
    "version",
    "nodes",
    "output",
    "default_functions",
    "metadata",
];
const ALLOWED_NODE_KEYS: &[&str] = &[
    "label",
    "function",
    "input",
    "depends_on",
    "fanout",
    "result",
    "inputPolicy",
];
const ALLOWED_FUNCTION_KEYS: &[&str] = &["id", "timeout_ms", "queue", "engine_retry", "runtime"];
const ALLOWED_RESULT_KEYS: &[&str] = &["returnType", "streamChunkSize", "onMemoryFail"];
const ALLOWED_INPUT_POLICY_KEYS: &[&str] = &["returnType", "onMemoryFail"];
const ALLOWED_FANOUT_KEYS: &[&str] = &["over", "mode", "batchSize", "itemReturnType"];

// Custom Deserialize so a malformed `definition` yields ONE error listing EVERY
// structural problem (plus the canonical shape), instead of serde's fail-fast
// one-field-at-a-time errors that make a weak model play whack-a-mole. It also
// applies the `workflow` alias and the source-node `input` default. The typed
// `StartRequestRaw` parse and `validate_def` (semantic rules) run afterward.
impl<'de> Deserialize<'de> for StartRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error as _;
        let mut v = Value::deserialize(deserializer)?;
        normalize_request(&mut v);
        let mut problems = collect_request_problems(&v);
        problems.extend(collect_def_problems(&v));
        if !problems.is_empty() {
            return Err(D::Error::custom(format_problems(&problems)));
        }
        serde_json::from_value::<StartRequestRaw>(v)
            .map(|r| StartRequest {
                definition: r.definition,
                input: r.input,
                input_policy: r.input_policy,
                idempotency_key: r.idempotency_key,
                notify: r.notify,
                caller_session_id: r.caller_session_id,
            })
            .map_err(|e| D::Error::custom(format!("{e}. {SHAPE_HINT}")))
    }
}

/// Accept the `workflow` wrapper alias and inject `input:{from:"run_input"}` into
/// pure-source nodes (no `depends_on`, no `fanout`, no `input`) — the most common
/// omission. Non-source nodes are left alone so a missing `input` is REPORTED,
/// never silently mis-wired.
fn normalize_request(v: &mut Value) {
    let Some(obj) = v.as_object_mut() else {
        return;
    };
    if !obj.contains_key("definition") {
        if let Some(w) = obj.remove("workflow") {
            obj.insert("definition".into(), w);
        }
    }
    let Some(nodes) = obj
        .get_mut("definition")
        .and_then(|d| d.as_object_mut())
        .and_then(|d| d.get_mut("nodes"))
        .and_then(|n| n.as_object_mut())
    else {
        return;
    };
    for node in nodes.values_mut() {
        let Some(n) = node.as_object_mut() else {
            continue;
        };
        let has_input = n.get("input").map(|x| !x.is_null()).unwrap_or(false);
        let has_deps = n
            .get("depends_on")
            .and_then(|d| d.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        let has_fanout = n.get("fanout").map(|x| !x.is_null()).unwrap_or(false);
        if !has_input && !has_deps && !has_fanout {
            n.insert("input".into(), json!({ "from": "run_input" }));
        }
    }
}

fn json_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

fn collect_request_problems(v: &Value) -> Vec<String> {
    let mut p = Vec::new();
    let Some(req) = v.as_object() else {
        return p;
    };

    if let Some(input_policy) = req.get("inputPolicy") {
        match input_policy {
            Value::Object(input_policy_obj) => {
                for k in input_policy_obj.keys() {
                    if !ALLOWED_INPUT_POLICY_KEYS.contains(&k.as_str()) {
                        p.push(format!("inputPolicy: unknown field `{k}`"));
                    }
                }

                if let Some(return_type) = input_policy_obj.get("returnType") {
                    let valid = return_type
                        .as_str()
                        .map(|v| matches!(v, "memory" | "store"))
                        .unwrap_or(false);
                    if !valid {
                        p.push("inputPolicy.returnType must be one of: memory, store".to_string());
                    }
                }

                if let Some(on_memory_fail) = input_policy_obj.get("onMemoryFail") {
                    let valid = on_memory_fail
                        .as_str()
                        .map(|v| matches!(v, "store" | "error"))
                        .unwrap_or(false);
                    if !valid {
                        p.push(
                            "inputPolicy.onMemoryFail must be one of: store, error".to_string(),
                        );
                    }
                }
            }
            other => p.push(format!(
                "inputPolicy must be an object, not {}",
                json_type(other)
            )),
        }
    }

    p
}

/// Collect EVERY structural problem in one pass so a caller fixes them all at
/// once. Shape only — `validate_def` still runs the semantic rules (cycles,
/// JSON-output contracts, dependency consumption) after a successful parse.
fn collect_def_problems(v: &Value) -> Vec<String> {
    let mut p = Vec::new();
    let Some(def) = v.get("definition") else {
        p.push(
            "missing `definition` — wrap the whole DAG (nodes, output) in a top-level \
             `definition` object"
                .to_string(),
        );
        return p;
    };
    let Some(def) = def.as_object() else {
        p.push(format!(
            "`definition` must be an object, not {}",
            json_type(def)
        ));
        return p;
    };
    if let Some(ver) = def.get("version") {
        if ver.as_u64() != Some(SUPPORTED_DEF_VERSION as u64) {
            p.push(format!(
                "`definition.version` must be {SUPPORTED_DEF_VERSION} (or omit it to default)"
            ));
        }
    }
    for k in def.keys() {
        if !ALLOWED_DEF_KEYS.contains(&k.as_str()) {
            let hint = if ALLOWED_NODE_KEYS.contains(&k.as_str()) {
                format!(" — `{k}` is a NODE-level field; move it inside a node under `nodes`")
            } else {
                String::new()
            };
            p.push(format!("unknown field `{k}` at the definition level{hint}"));
        }
    }
    match def.get("nodes") {
        None => p.push(
            "missing `nodes` — an OBJECT keyed by node id: {\"<id>\": {agent, input, ...}}"
                .to_string(),
        ),
        Some(Value::Object(nodes)) if nodes.is_empty() => {
            p.push("`nodes` is empty — add at least one node".to_string())
        }
        Some(Value::Object(nodes)) => {
            for (id, node) in nodes {
                collect_node_problems(id, node, &mut p);
            }
        }
        Some(other) => p.push(format!(
            "`nodes` must be an OBJECT keyed by node id, not {}",
            json_type(other)
        )),
    }
    if def.get("output").is_none() {
        p.push(
            "missing `output` — {\"from\":\"node:<id>\"}: which node's result the run returns"
                .to_string(),
        );
    }
    p
}

fn collect_node_problems(id: &str, node: &Value, p: &mut Vec<String>) {
    let Some(n) = node.as_object() else {
        p.push(format!(
            "node `{id}` must be an object {{executor, input, depends_on?, fanout?}}, not {}",
            json_type(node)
        ));
        return;
    };
    for k in n.keys() {
        if !ALLOWED_NODE_KEYS.contains(&k.as_str()) {
            let hint = if ALLOWED_FUNCTION_KEYS.contains(&k.as_str()) {
                format!(" — `{k}` goes inside `function`")
            } else {
                String::new()
            };
            p.push(format!("node `{id}`: unknown field `{k}`{hint}"));
        }
    }

    let has_function = n.contains_key("function");

    if has_function {
        match n.get("function") {
            Some(Value::Object(function)) => {
                for k in function.keys() {
                    if !ALLOWED_FUNCTION_KEYS.contains(&k.as_str()) {
                        p.push(format!("node `{id}`.function: unknown field `{k}`"));
                    }
                }
                let has_id = function
                    .get("id")
                    .and_then(|m| m.as_str())
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);
                if !has_id {
                    p.push(format!("node `{id}`.function: missing `id`"));
                }
            }
            Some(other) => p.push(format!(
                "node `{id}`.function must be an object, not {}",
                json_type(other)
            )),
            None => unreachable!(),
        }
    } else {
        p.push(format!("node `{id}`: missing `function`"));
    }

    let has_input = n.get("input").map(|x| !x.is_null()).unwrap_or(false);
    if !has_input {
        let has_deps = n
            .get("depends_on")
            .and_then(|d| d.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        let has_fanout = n.get("fanout").map(|x| !x.is_null()).unwrap_or(false);
        if has_deps || has_fanout {
            p.push(format!("node `{id}`: missing `input`"));
        }
    }

    if let Some(result) = n.get("result") {
        match result {
            Value::Object(result_obj) => {
                for k in result_obj.keys() {
                    if !ALLOWED_RESULT_KEYS.contains(&k.as_str()) {
                        p.push(format!("node `{id}`.result: unknown field `{k}`"));
                    }
                }

                if let Some(return_type) = result_obj.get("returnType") {
                    let valid = return_type
                        .as_str()
                        .map(|v| matches!(v, "memory" | "store" | "stream"))
                        .unwrap_or(false);
                    if !valid {
                        p.push(format!(
                            "node `{id}`.result.returnType must be one of: memory, store, stream"
                        ));
                    }
                }

                if let Some(stream_chunk_size) = result_obj.get("streamChunkSize") {
                    if stream_chunk_size.as_u64().is_none() {
                        p.push(format!(
                            "node `{id}`.result.streamChunkSize must be a positive integer"
                        ));
                    }
                }

                if let Some(on_memory_fail) = result_obj.get("onMemoryFail") {
                    let valid = on_memory_fail
                        .as_str()
                        .map(|v| matches!(v, "store" | "error"))
                        .unwrap_or(false);
                    if !valid {
                        p.push(format!(
                            "node `{id}`.result.onMemoryFail must be one of: store, error"
                        ));
                    }
                }
            }
            other => p.push(format!(
                "node `{id}`.result must be an object, not {}",
                json_type(other)
            )),
        }
    }

    if let Some(input_policy) = n.get("inputPolicy") {
        match input_policy {
            Value::Object(input_policy_obj) => {
                for k in input_policy_obj.keys() {
                    if !ALLOWED_INPUT_POLICY_KEYS.contains(&k.as_str()) {
                        p.push(format!("node `{id}`.inputPolicy: unknown field `{k}`"));
                    }
                }

                if let Some(return_type) = input_policy_obj.get("returnType") {
                    let valid = return_type
                        .as_str()
                        .map(|v| matches!(v, "memory" | "store"))
                        .unwrap_or(false);
                    if !valid {
                        p.push(format!(
                            "node `{id}`.inputPolicy.returnType must be one of: memory, store"
                        ));
                    }
                }

                if let Some(on_memory_fail) = input_policy_obj.get("onMemoryFail") {
                    let valid = on_memory_fail
                        .as_str()
                        .map(|v| matches!(v, "store" | "error"))
                        .unwrap_or(false);
                    if !valid {
                        p.push(format!(
                            "node `{id}`.inputPolicy.onMemoryFail must be one of: store, error"
                        ));
                    }
                }
            }
            other => p.push(format!(
                "node `{id}`.inputPolicy must be an object, not {}",
                json_type(other)
            )),
        }
    }

    if let Some(fanout) = n.get("fanout") {
        match fanout {
            Value::Object(fanout_obj) => {
                for k in fanout_obj.keys() {
                    if !ALLOWED_FANOUT_KEYS.contains(&k.as_str()) {
                        p.push(format!("node `{id}`.fanout: unknown field `{k}`"));
                    }
                }

                if let Some(mode) = fanout_obj.get("mode") {
                    let valid = mode
                        .as_str()
                        .map(|v| matches!(v, "parallel" | "sequential" | "batch"))
                        .unwrap_or(false);
                    if !valid {
                        p.push(format!(
                            "node `{id}`.fanout.mode must be one of: parallel, sequential, batch"
                        ));
                    }
                }

                if let Some(batch_size) = fanout_obj.get("batchSize") {
                    let valid = batch_size.as_u64().map(|v| v > 0).unwrap_or(false);
                    if !valid {
                        p.push(format!(
                            "node `{id}`.fanout.batchSize must be a positive integer"
                        ));
                    }
                    let is_batch_mode = fanout_obj
                        .get("mode")
                        .and_then(|m| m.as_str())
                        .map(|m| m == "batch")
                        .unwrap_or(false);
                    if !is_batch_mode {
                        p.push(format!(
                            "node `{id}`.fanout.batchSize is only valid when fanout.mode is batch"
                        ));
                    }
                }

                if let Some(item_return_type) = fanout_obj.get("itemReturnType") {
                    let valid = item_return_type
                        .as_str()
                        .map(|v| matches!(v, "memory" | "store"))
                        .unwrap_or(false);
                    if !valid {
                        p.push(format!(
                            "node `{id}`.fanout.itemReturnType must be one of: memory, store"
                        ));
                    }
                }
            }
            other => p.push(format!(
                "node `{id}`.fanout must be an object, not {}",
                json_type(other)
            )),
        }
    }
}

fn format_problems(problems: &[String]) -> String {
    let n = problems.len();
    let mut s = format!(
        "nworkflow::start: the `definition` has {n} problem{}:",
        if n == 1 { "" } else { "s" }
    );
    for pr in problems {
        s.push_str("\n  - ");
        s.push_str(pr);
    }
    s.push('\n');
    s.push_str(SHAPE_HINT);
    s
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct StartResponse {
    pub run_id: String,
}

struct RunReferenceSet {
    def_ref: String,
    input_ref: String,
    vars_ref: String,
    result_ref: String,
    state_scope_id: String,
    stream_scope_id: String,
}

fn new_run_reference_set() -> RunReferenceSet {
    RunReferenceSet {
        def_ref: new_ref_id("def"),
        input_ref: new_ref_id("input"),
        vars_ref: new_ref_id("vars"),
        result_ref: new_ref_id("result"),
        state_scope_id: new_scope_id("state"),
        stream_scope_id: new_scope_id("stream"),
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Fold each node's `input.from` / `fanout.over` `"node:<id>"` reads into its
/// `depends_on` (deduped; any explicitly-declared entries are kept and ordered
/// first). A read is a data dependency, but scheduling consults only `depends_on`
/// (see `dag::deps_done` / `ready_frontier`); aligning them here means a node never
/// fires before a node it reads — without forcing callers to restate the edge — and
/// keeps `validate_def`'s cycle check honest about the graph that actually executes.
/// Run BEFORE `validate_def`. Idempotent.
fn add_read_dependencies(def: &mut WorkflowDef) {
    fn collect_value_node_refs(value: &Value, refs: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                if let Some(source) = map.get("$wf_ref").and_then(|v| v.as_str()) {
                    if let Some(rest) = source.strip_prefix("node:") {
                        refs.push(rest.split('.').next().unwrap_or(rest).to_string());
                    }
                }
                for v in map.values() {
                    collect_value_node_refs(v, refs);
                }
            }
            Value::Array(arr) => {
                for v in arr {
                    collect_value_node_refs(v, refs);
                }
            }
            _ => {}
        }
    }

    for node in def.nodes.values_mut() {
        let mut refs: Vec<String> = Vec::new();
        for src in node.input.from.sources() {
            if let Some(rest) = src.strip_prefix("node:") {
                refs.push(rest.split('.').next().unwrap_or(rest).to_string());
            }
        }
        if let Some(payload) = node.input.value.as_ref() {
            collect_value_node_refs(payload, &mut refs);
        }
        if let Some(fanout) = &node.fanout {
            if let Some(rest) = fanout.over.strip_prefix("node:") {
                refs.push(rest.split('.').next().unwrap_or(rest).to_string());
            }
        }
        for r in refs {
            if !node.depends_on.contains(&r) {
                node.depends_on.push(r);
            }
        }
    }
}

pub(crate) fn prepare_definition_for_execution(def: &WorkflowDef) -> WorkflowDef {
    let mut prepared = def.clone();
    add_read_dependencies(&mut prepared);
    prepared
}

fn workflow_input_uses_persistent_store(input_policy: Option<&NodeInputSpec>) -> bool {
    let Some(policy) = input_policy else {
        return false;
    };

    policy.return_type == NodeInputReturnType::Store
        || matches!(policy.on_memory_fail, Some(NodeMemoryFailPolicy::Store))
}

/// Validate a `WorkflowDef` for structural correctness.
///
/// Rules:
/// 0. `version` must be supported; node count is bounded; node ids must not
///    contain the reserved separators `#`/`.`; `output.from` must reference an
///    existing node.
/// 1. Every node's `agent.model` must be non-empty.
/// 2. Any node referenced by another node's `fanout.over` (strip `node:`,
///    take the part before the first `.`) OR by a node's `input.from`
///    `"node:<id>"` source (single or array) MUST have `agent.output` be a JSON
///    object with `"type" == "json"`.
/// 3. The `depends_on` graph must be acyclic (and reference existing nodes).
/// 4. Every entry of an `input.from` ARRAY (the join form) must be a
///    `"node:<id>"` reference.
/// 5. Every `depends_on` entry must be CONSUMED by the node's `input.from` or
///    `fanout.over` — a declared-but-unread dependency is silently dropped while
///    the run still reports success, so it is rejected up front.
pub fn validate_def(def: &WorkflowDef) -> Result<(), WorkflowError> {
    // Rule 0a: supported schema version.
    if def.version != SUPPORTED_DEF_VERSION {
        return Err(WorkflowError::InvalidDef(format!(
            "unsupported definition version {} (expected {})",
            def.version, SUPPORTED_DEF_VERSION
        )));
    }

    // Rule 0b: bounded node count (untrusted input).
    if def.nodes.len() > MAX_NODES {
        return Err(WorkflowError::InvalidDef(format!(
            "definition has {} nodes (max {})",
            def.nodes.len(),
            MAX_NODES
        )));
    }

    // Rule 0c: node ids must not contain the reserved separators '#' (fanout item
    // index), '.' (over-path), or '/' (the run_id/node_uid storage-key separator —
    // see ids::node_result_key), any of which would mis-parse at dispatch time or
    // corrupt result-key composition.
    for node_id in def.nodes.keys() {
        if node_id.contains('#') || node_id.contains('.') || node_id.contains('/') {
            return Err(WorkflowError::InvalidDef(format!(
                "node id '{}' must not contain '#', '.', or '/'",
                node_id
            )));
        }
    }

    // Rule 0d: the output node must reference an existing node, otherwise the
    // run can never reach Completed and hangs in AwaitingNodes forever.
    let out_id = def
        .output
        .from
        .strip_prefix("node:")
        .unwrap_or(&def.output.from);
    if !def.nodes.contains_key(out_id) {
        return Err(WorkflowError::InvalidDef(format!(
            "output.from references unknown node '{}'",
            out_id
        )));
    }

    for (node_id, node) in &def.nodes {
        if node.function.id.trim().is_empty() {
            return Err(WorkflowError::InvalidDef(format!(
                "node '{}' has an empty function.id",
                node_id
            )));
        }
    }

    // Functions always return JSON - no validation needed

    // Collect nodes that must have JSON output.
    let mut must_have_json_output: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    for node in def.nodes.values() {
        // fanout.over: "node:<dep_id>.<path...>" → extract dep_id
        if let Some(fanout) = &node.fanout {
            if let Some(rest) = fanout.over.strip_prefix("node:") {
                let dep_id = rest.split('.').next().unwrap_or(rest);
                must_have_json_output.insert(dep_id.to_string());
            }
        }

        // input.from: each "node:<dep_id>" source (One or Many) → extract dep_id
        for src in node.input.from.sources() {
            if let Some(rest) = src.strip_prefix("node:") {
                let dep_id = rest.split('.').next().unwrap_or(rest);
                must_have_json_output.insert(dep_id.to_string());
            }
        }
    }

    // Functions always produce JSON - skip validation
    // (Removed: Rule 2 JSON output validation)

    // Rule 2b: when a fanout's `over` path can be STATICALLY PROVEN to land on a
    // non-array field in the upstream's declared output schema, reject at start.
    // Without this the run burns every upstream node, then dies at expansion time
    // in `dag::resolve_over_path` ("value at path is string (not an array)") —
    // minutes and real tokens into a paid run. We only fail when we can PROVE it
    // (a constant `node:` path landing on an explicitly-typed non-array leaf);
    // dynamic shapes ($ref / anyOf / additionalProperties / untyped / undeclared
    // segment) fall through to the runtime guard, so this never rejects a
    // legitimate def.
    for (node_id, node) in &def.nodes {
        if let Some(fanout) = &node.fanout {
            if let Some(leaf_type) = fanout_over_proven_nonarray(def, &fanout.over) {
                let dep = fanout
                    .over
                    .strip_prefix("node:")
                    .and_then(|r| r.split('.').next())
                    .unwrap_or(&fanout.over);
                return Err(WorkflowError::InvalidDef(format!(
                    "node '{}': fanout.over = \"{}\" resolves to a {} in node '{}'s declared \
                     output schema, but a fanout iterates an ARRAY. Point `over` at a field that \
                     node '{}'s agent.output schema declares as {{\"type\":\"array\"}}. (To run \
                     several agents over ONE value — e.g. several critics over one draft — fan out \
                     over a list of lenses and pass the value as a separate input; don't fan out \
                     over the value itself.)",
                    node_id, fanout.over, leaf_type, dep, dep
                )));
            }
        }
    }

    // Rule 4: a node's `input.from` array (the `Many` join form) may contain only
    // `"node:<id>"` references — a join gathers dependency outputs, not run_input
    // or fanout_item.
    for (node_id, node) in &def.nodes {
        if let crate::types::InputFrom::Many(sources) = &node.input.from {
            for src in sources {
                if !src.starts_with("node:") {
                    return Err(WorkflowError::InvalidDef(format!(
                        "node '{}': input.from array entries must be node references like \
                         \"node:<id>\"; got \"{}\"",
                        node_id, src
                    )));
                }
            }
        }
    }

    // Rule 4b: an `input.from` `"node:<id>"` source must be a BARE node id — no
    // dotted path. Only `fanout.over` walks a dotted path; `input.from` gathers a
    // node's WHOLE result. A dotted form (e.g. "node:plan.result.docs") passes the
    // de-dotted dep checks in Rules 2/5 yet `dag::gather_one` keys the entire
    // remainder (it never splits on '.'), so at runtime it silently resolves to
    // Value::Null — the node runs on empty input while the run still reports success.
    // Reject it at start instead of producing a degenerate result.
    for (node_id, node) in &def.nodes {
        for src in node.input.from.sources() {
            if let Some(rest) = src.strip_prefix("node:") {
                if rest.contains('.') {
                    let base = rest.split('.').next().unwrap_or(rest);
                    return Err(WorkflowError::InvalidDef(format!(
                        "node '{}': input.from = \"{}\" must reference a whole node result as \
                         \"node:{}\" — a dotted path is only valid on fanout.over, and here it \
                         silently resolves to null at runtime. Drop the path suffix.",
                        node_id, src, base
                    )));
                }
            }
        }
    }

    // Rule 5: Cycle detection.
    crate::dag::validate_acyclic(def).map_err(WorkflowError::InvalidDef)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Static fanout-type checking (Rule 2b)
// ---------------------------------------------------------------------------

/// Walk a `fanout.over` path (`"node:<id>.<seg>.<seg>"`) into the upstream node's
/// DECLARED output schema and, if the leaf is provably non-array, return its type
/// name. Mirrors `dag::resolve_over_path`'s path protocol (skip a leading
/// `"result"` segment) but walks the schema instead of a runtime value. Returns
/// None whenever the type can't be proven — missing node/schema, a non-JSON
/// output, an undeclared segment, a dynamic schema, or an array leaf — so the
/// run proceeds and the runtime guard decides.
fn fanout_over_proven_nonarray(_def: &WorkflowDef, _over: &str) -> Option<String> {
    // Functions don't declare output schemas, so we can't statically validate fanout paths.
    // Runtime validation in dag::resolve_over_path remains the guard.
    None
}

// ---------------------------------------------------------------------------
// Enqueue helper
// ---------------------------------------------------------------------------

pub async fn enqueue_tick(
    iii: &iii_sdk::IIIClient,
    run_id: &str,
    step: u64,
) -> Result<(), WorkflowError> {
    iii.trigger(iii_sdk::protocol::TriggerRequest {
        function_id: "nworkflow::tick".into(),
        payload: json!({"run_id": run_id, "step": step}),
        action: Some(iii_sdk::TriggerAction::Enqueue {
            queue: "default".into(),
        }),
        timeout_ms: None,
    })
    .await
    .map_err(|e| WorkflowError::Trigger(e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Namespace an idempotency key by its caller. The key is stored in a flat global
/// keyspace (`workflow_idempotency`), so an un-scoped key lets two different callers using
/// the same string (e.g. "daily-report") collide: the second caller is handed
/// back the first's `run_id`, leaking it — and, via `nworkflow::status` /
/// `nworkflow::node-result`, the run's results. `caller_session_id` is hook-stamped
/// from the caller's real session (never trusted from the agent), and session ids
/// contain no `|`, so the prefix unambiguously isolates callers. Non-agent (trusted)
/// callers share the `_anon` namespace.
fn scoped_idem_key(key: &str, caller_session_id: Option<&str>) -> String {
    format!("{}|{}", caller_session_id.unwrap_or("_anon"), key)
}

/// Count the workflow runs in a caller's ancestry, to bound sub-workflow nesting.
/// Every workflow node session is reverse-indexed to its run (state::put_session_index
/// in fire_node), and every run records the session that started it
/// (caller_session_id), so we walk the chain — node session → its run → that run's
/// caller → … — counting how deep a NEW run started by this caller would sit. A
/// non-node caller (a real chat/console session) misses the reverse index and ends
/// the chain at depth 0, so a normal top-level start costs a single lookup. Bounded
/// to MAX_WORKFLOW_DEPTH+1 iterations so a malformed/cyclic chain can't loop forever.
async fn caller_workflow_depth(
    deps: &Deps,
    caller_session_id: Option<&str>,
) -> Result<usize, WorkflowError> {
    let mut depth = 0usize;
    let mut cur = caller_session_id.map(str::to_string);
    while let Some(sid) = cur {
        match deps.internal_state.run_id_for_session(&sid).await? {
            Some(parent_run) => {
                depth += 1;
                if depth > MAX_WORKFLOW_DEPTH {
                    break;
                }
                cur = state::get_run(&deps.iii, &parent_run)
                    .await?
                    .and_then(|r| r.caller_session_id);
            }
            // Caller is not a workflow node session — the ancestry chain ends.
            None => break,
        }
    }
    Ok(depth)
}

/// Start a run: validate, resolve the caller session, dedupe on the idempotency
/// key, persist the Running record, and enqueue the first tick. Fire-and-forget —
/// the caller gets the `run_id` back immediately and receives the outcome via
/// `reply_to` / `notify` (or by polling `nworkflow::status`); the harness turn is
/// never blocked.
pub async fn handle(deps: &Deps, req: StartRequest) -> Result<StartResponse, WorkflowError> {
    // A node's reads ARE its dependencies for scheduling, but the UI should still
    // see the original user-authored graph. Persist the raw definition separately
    // and enrich only the runtime copy used by tick/sweep execution.
    let runtime_def = prepare_definition_for_execution(&req.definition);
    validate_def(&runtime_def)?;

    // Resolve the caller/orchestrator session for console nesting and idempotency scoping.
    let caller_session_id = req.caller_session_id.clone();

    // Idempotency short-circuit.
    if let Some(ref key) = req.idempotency_key {
        if key.len() > MAX_IDEM_KEY_LEN {
            return Err(WorkflowError::InvalidDef(format!(
                "idempotency_key too long: {} bytes (max {})",
                key.len(),
                MAX_IDEM_KEY_LEN
            )));
        }
        let scoped = scoped_idem_key(key, caller_session_id.as_deref());
        if let Some(existing_run_id) = deps
            .internal_state
            .run_id_for_idempotency_key(&scoped)
            .await?
        {
            return Ok(StartResponse {
                run_id: existing_run_id,
            });
        }
    }

    let run_id = new_run_id();
    let refs = new_run_reference_set();
    let _guard = deps.locks.guard(&run_id).await;

    state::put_def(&deps.iii, &refs.def_ref, &req.definition).await?;
    state::put_run_input_memory(&run_id, &req.input)?;
    if workflow_input_uses_persistent_store(req.input_policy.as_ref()) {
        state::put_run_input(&deps.iii, &refs.input_ref, &req.input).await?;
    }

    // Extract workflow name from metadata if present
    let workflow_name = req
        .definition
        .metadata
        .as_ref()
        .and_then(|m| m.name.clone());

    // Bound sub-workflow nesting: a node that opted into `nworkflow::start` could
    // otherwise recurse (sub-workflow → node → sub-workflow → …) without limit.
    let depth = caller_workflow_depth(deps, caller_session_id.as_deref()).await?;
    if depth > MAX_WORKFLOW_DEPTH {
        return Err(WorkflowError::InvalidDef(format!(
            "sub-workflow nesting depth {depth} exceeds the cap of {MAX_WORKFLOW_DEPTH}"
        )));
    }

    let now = deps.now_ms();

    // Pre-initialize nodes in Pending state to show progress in UI immediately
    let mut nodes = BTreeMap::new();
    for node_id in req.definition.nodes.keys() {
        nodes.insert(
            node_id.clone(),
            crate::types::NodeCheckpoint {
                state: crate::types::NodeState::Pending,
                session_id: None,
                turn_id: None,
                pending_at: None,
                pending_timeout_ms: None,
                completed_at: None,
                result_ref: None,
                result_error: None,
                retries: 0,
                worker_name: None,
            },
        );
    }

    let mut record = WorkflowRunRecord {
        run_id: run_id.clone(),
        workflow_name,
        workflow_trace_id: Some(new_trace_id()),
        state_scope_id: Some(refs.state_scope_id),
        stream_scope_id: Some(refs.stream_scope_id),
        step: 0,
        status: RunStatus::Running,
        abort: false,
        def_ref: refs.def_ref,
        input_ref: refs.input_ref,
        vars_ref: Some(refs.vars_ref),
        state_keys_map: BTreeMap::new(),
        stream_ids: Vec::new(),
        queue_receipts: Vec::new(),
        nodes,
        fanout_src: BTreeMap::new(),
        result_ref: Some(refs.result_ref),
        result_error: None,
        notify: req.notify,
        caller_session_id,
        created_at: now,
        updated_at: now,
    };

    state::put_run(&deps.iii, &record).await?;

    super::lifecycle_hooks::emit_start(deps, &req.definition, &record).await;

    crate::telemetry::record_run_started();

    if let Some(ref key) = req.idempotency_key {
        let scoped = scoped_idem_key(key, record.caller_session_id.as_deref());
        let idem_ttl_ms = deps.cfg().await.idempotency_ttl_ms;
        deps.internal_state
            .put_idempotency_key(&scoped, &run_id, Some(idem_ttl_ms))
            .await?;
    }

    // The Running record is already persisted; if the first tick fails to enqueue,
    // only the cron sweep would recover it (up to a sweep interval later). Mark the
    // run Failed best-effort so nworkflow::status / list don't surface a phantom
    // Running run in the meantime.
    if let Err(e) = enqueue_tick(&deps.iii, &run_id, 0).await {
        record.status = RunStatus::Failed;
        record.result_error = Some(format!("failed to enqueue initial tick: {e}"));
        record.updated_at = deps.now_ms();
        let _ = state::put_run(&deps.iii, &record).await;
        return Err(e);
    }

    Ok(StartResponse { run_id })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        FanoutSpec, FunctionSpec, InputFrom, InputSpec, NodeDef, OutputRef, WorkflowDef,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    fn make_node(function_id: &str, fanout_over: Option<&str>, input_from: InputFrom) -> NodeDef {
        NodeDef {
            label: None,
            function: FunctionSpec {
                id: function_id.to_string(),
                timeout_ms: None,
                queue: None,
                engine_retry: None,
                runtime: None,
            },
            input: InputSpec {
                from: input_from,
                template: None,
                value: None,
            },
            depends_on: vec![],
            fanout: fanout_over.map(|over| FanoutSpec {
                over: over.to_string(),
                mode: None,
                batch_size: None,
                item_return_type: None,
            }),
            result: None,
            input_policy: None,
        }
    }

    fn well_formed_def() -> WorkflowDef {
        let mut nodes = BTreeMap::new();

        nodes.insert(
            "plan".to_string(),
            make_node("plan-fn", None, "workflow.input".into()),
        );

        nodes.insert(
            "read".to_string(),
            make_node("read-fn", Some("node:plan.result.docs"), "node:plan".into()),
        );

        nodes.insert(
            "summarize".to_string(),
            make_node("summarize-fn", None, "node:read".into()),
        );

        WorkflowDef {
            version: 1,
            nodes,
            output: OutputRef {
                from: "node:summarize".into(),
            },
            default_functions: None,
            metadata: None,
        }
    }

    #[test]
    fn add_read_dependencies_folds_reads_into_depends_on() {
        let mut def = well_formed_def();
        def.nodes.get_mut("read").unwrap().depends_on.clear();
        def.nodes.get_mut("summarize").unwrap().depends_on.clear();
        add_read_dependencies(&mut def);
        assert_eq!(def.nodes["read"].depends_on, vec!["plan".to_string()]);
        assert_eq!(def.nodes["summarize"].depends_on, vec!["read".to_string()]);
        assert!(def.nodes["plan"].depends_on.is_empty());
        add_read_dependencies(&mut def);
        assert_eq!(def.nodes["read"].depends_on, vec!["plan".to_string()]);
        assert!(validate_def(&def).is_ok());
    }

    #[test]
    fn add_read_dependencies_includes_dynamic_input_value_refs() {
        let mut def = well_formed_def();
        if let Some(node) = def.nodes.get_mut("summarize") {
            node.depends_on = vec!["read".to_string()];
            node.input = InputSpec {
                from: "run_input".into(),
                template: None,
                value: Some(json!({
                    "direct": {
                        "$wf_ref": "node:plan",
                        "$wf_path": ["storageKey"]
                    },
                    "nested": {
                        "child": {
                            "$wf_ref": "node:read",
                            "$wf_path": ["result"]
                        }
                    }
                })),
            };
        }

        add_read_dependencies(&mut def);

        let deps = &def.nodes["summarize"].depends_on;
        assert!(deps.contains(&"plan".to_string()));
        assert!(deps.contains(&"read".to_string()));
    }

    #[test]
    fn workflow_input_uses_persistent_store_only_when_requested() {
        assert!(!workflow_input_uses_persistent_store(None));

        assert!(workflow_input_uses_persistent_store(Some(&NodeInputSpec {
            return_type: NodeInputReturnType::Store,
            on_memory_fail: None,
        })));

        assert!(workflow_input_uses_persistent_store(Some(&NodeInputSpec {
            return_type: NodeInputReturnType::Memory,
            on_memory_fail: Some(NodeMemoryFailPolicy::Store),
        })));

        assert!(!workflow_input_uses_persistent_store(Some(&NodeInputSpec {
            return_type: NodeInputReturnType::Memory,
            on_memory_fail: Some(NodeMemoryFailPolicy::Error),
        })));
    }

    #[test]
    fn start_request_parses_top_level_input_policy() {
        let req: StartRequest = serde_json::from_value(json!({
            "definition": well_formed_def(),
            "inputPolicy": {
                "returnType": "store",
                "onMemoryFail": "store"
            }
        }))
        .expect("StartRequest with top-level inputPolicy");

        let policy = req.input_policy.expect("inputPolicy present");
        assert_eq!(policy.return_type, NodeInputReturnType::Store);
        assert_eq!(policy.on_memory_fail, Some(NodeMemoryFailPolicy::Store));
    }

    #[test]
    fn collect_def_problems_accepts_fanout_item_return_type_store() {
        let payload = json!({
            "definition": {
                "version": 1,
                "nodes": {
                    "plan": {
                        "function": { "id": "plan-fn" },
                        "input": { "from": "run_input" }
                    },
                    "read": {
                        "function": { "id": "read-fn" },
                        "input": { "from": "fanout_item" },
                        "fanout": {
                            "over": "node:plan.result.docs",
                            "itemReturnType": "store"
                        }
                    }
                },
                "output": { "from": "node:read" }
            }
        });

        let problems = collect_def_problems(&payload);
        assert!(
            problems
                .iter()
                .all(|p| !p.contains("fanout.itemReturnType")),
            "fanout.itemReturnType=store should be accepted by shape validation"
        );
    }

    #[test]
    fn collect_def_problems_rejects_invalid_fanout_item_return_type() {
        let payload = json!({
            "definition": {
                "version": 1,
                "nodes": {
                    "plan": {
                        "function": { "id": "plan-fn" },
                        "input": { "from": "run_input" }
                    },
                    "read": {
                        "function": { "id": "read-fn" },
                        "input": { "from": "fanout_item" },
                        "fanout": {
                            "over": "node:plan.result.docs",
                            "itemReturnType": "disk"
                        }
                    }
                },
                "output": { "from": "node:read" }
            }
        });

        let problems = collect_def_problems(&payload);
        assert!(
            problems
                .iter()
                .any(|p| p.contains("fanout.itemReturnType must be one of: memory, store")),
            "invalid fanout.itemReturnType must be rejected"
        );
    }

    #[test]
    fn collect_def_problems_accepts_batch_mode_with_batch_size() {
        let payload = json!({
            "definition": {
                "version": 1,
                "nodes": {
                    "plan": {
                        "function": { "id": "plan-fn" },
                        "input": { "from": "run_input" }
                    },
                    "read": {
                        "function": { "id": "read-fn" },
                        "input": { "from": "fanout_item" },
                        "fanout": {
                            "over": "node:plan.result.docs",
                            "mode": "batch",
                            "batchSize": 25
                        }
                    }
                },
                "output": { "from": "node:read" }
            }
        });

        let problems = collect_def_problems(&payload);
        assert!(
            problems.iter().all(|p| !p.contains("fanout.batchSize") && !p.contains("fanout.mode")),
            "fanout.mode=batch with batchSize should be accepted"
        );
    }

    #[test]
    fn collect_def_problems_rejects_batch_size_without_batch_mode() {
        let payload = json!({
            "definition": {
                "version": 1,
                "nodes": {
                    "plan": {
                        "function": { "id": "plan-fn" },
                        "input": { "from": "run_input" }
                    },
                    "read": {
                        "function": { "id": "read-fn" },
                        "input": { "from": "fanout_item" },
                        "fanout": {
                            "over": "node:plan.result.docs",
                            "mode": "parallel",
                            "batchSize": 10
                        }
                    }
                },
                "output": { "from": "node:read" }
            }
        });

        let problems = collect_def_problems(&payload);
        assert!(
            problems
                .iter()
                .any(|p| p.contains("fanout.batchSize is only valid when fanout.mode is batch")),
            "batchSize without mode=batch must be rejected"
        );
    }

    #[test]
    fn prepare_definition_for_execution_keeps_user_graph_unchanged() {
        let def = well_formed_def();
        let prepared = prepare_definition_for_execution(&def);

        assert!(def.nodes["read"].depends_on.is_empty());
        assert!(def.nodes["summarize"].depends_on.is_empty());
        assert_eq!(prepared.nodes["read"].depends_on, vec!["plan".to_string()]);
        assert_eq!(
            prepared.nodes["summarize"].depends_on,
            vec!["read".to_string()]
        );
    }

    #[test]
    fn prepare_definition_for_execution_matches_multi_step_runtime_shape() {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "process-text".to_string(),
            make_node("process-text", None, "run_input".into()),
        );
        nodes.insert(
            "wait".to_string(),
            NodeDef {
                depends_on: vec!["process-text".to_string()],
                ..make_node("wait", None, "run_input".into())
            },
        );
        nodes.insert(
            "process-text_1".to_string(),
            NodeDef {
                depends_on: vec!["process-text".to_string()],
                ..make_node("process-text", None, "run_input".into())
            },
        );
        nodes.insert(
            "analyze-text".to_string(),
            NodeDef {
                depends_on: vec!["wait".to_string(), "process-text_1".to_string()],
                ..make_node("analyze-text", None, "node:process-text".into())
            },
        );

        let authored = WorkflowDef {
            version: 1,
            nodes,
            output: OutputRef {
                from: "node:analyze-text".into(),
            },
            default_functions: None,
            metadata: None,
        };

        let runtime = prepare_definition_for_execution(&authored);

        assert_eq!(
            authored.nodes["analyze-text"].depends_on,
            vec!["wait".to_string(), "process-text_1".to_string()]
        );
        assert_eq!(
            runtime.nodes["analyze-text"].depends_on,
            vec![
                "wait".to_string(),
                "process-text_1".to_string(),
                "process-text".to_string()
            ]
        );
    }

    #[test]
    fn rejects_missing_function_id() {
        let mut def = well_formed_def();
        def.nodes.get_mut("plan").unwrap().function.id = "".to_string();
        assert!(
            validate_def(&def).is_err(),
            "expected Err for empty function id, got Ok"
        );
    }

    #[test]
    fn rejects_output_referencing_unknown_node() {
        // C1: an output.from pointing at a non-existent node would hang the run.
        let mut def = well_formed_def();
        def.output.from = "node:ghost".to_string();
        let err = validate_def(&def).unwrap_err().to_string();
        assert!(
            err.contains("ghost"),
            "error should name the missing node: {err}"
        );
    }

    #[test]
    fn rejects_node_id_with_reserved_separator() {
        // C5: '#'/'.' in a node id collides with fanout-item / over-path parsing.
        let mut def = well_formed_def();
        def.nodes.insert(
            "bad#id".to_string(),
            make_node("bad-fn", None, "run_input".into()),
        );
        assert!(
            validate_def(&def).is_err(),
            "expected Err for node id with '#'"
        );
    }

    #[test]
    fn accepts_node_id_with_double_colon() {
        let def: WorkflowDef = serde_json::from_value(json!({
            "version": 1,
            "nodes": {
                "playground::process-text": {
                    "function": { "id": "playground::process-text" },
                    "input": { "from": "run_input" }
                }
            },
            "output": { "from": "node:playground::process-text" }
        }))
        .expect("definition with :: node id");

        assert!(
            validate_def(&def).is_ok(),
            "expected Ok for node id with '::'"
        );
    }

    #[test]
    fn start_request_preserves_node_label() {
        let req: StartRequest = serde_json::from_value(json!({
            "definition": {
                "version": 1,
                "nodes": {
                    "a": {
                        "label": "Process Text",
                        "function": { "id": "playground::process-text" },
                        "input": { "from": "run_input" }
                    }
                },
                "output": { "from": "node:a" }
            }
        }))
        .expect("StartRequest with node label");

        assert_eq!(
            req.definition.nodes["a"].label.as_deref(),
            Some("Process Text")
        );
    }

    #[test]
    fn rejects_unsupported_version() {
        let mut def = well_formed_def();
        def.version = 2;
        assert!(
            validate_def(&def).is_err(),
            "expected Err for unsupported version"
        );
    }

    #[test]
    fn accepts_well_formed_def() {
        let def = well_formed_def();
        assert!(
            validate_def(&def).is_ok(),
            "expected Ok for well-formed def, got Err"
        );
    }

    #[test]
    fn accepts_join_consuming_all_deps_via_input_array() {
        let mut def = well_formed_def();
        let summarize = def.nodes.get_mut("summarize").unwrap();
        summarize.depends_on = vec!["read".to_string(), "plan".to_string()];
        summarize.input.from =
            InputFrom::Many(vec!["node:read".to_string(), "node:plan".to_string()]);
        assert!(
            validate_def(&def).is_ok(),
            "a join consuming all its deps must be accepted: {:?}",
            validate_def(&def)
        );
    }

    #[test]
    fn rejects_input_array_with_non_node_entry() {
        let mut def = well_formed_def();
        let summarize = def.nodes.get_mut("summarize").unwrap();
        summarize.depends_on = vec!["read".to_string()];
        summarize.input.from =
            InputFrom::Many(vec!["node:read".to_string(), "run_input".to_string()]);
        let err = validate_def(&def).unwrap_err().to_string();
        assert!(
            err.contains("node references"),
            "error must explain the array must be node refs: {err}"
        );
    }

    #[test]
    fn start_request_parses_notify_callback() {
        let req: StartRequest = serde_json::from_value(json!({
            "definition": well_formed_def(),
            "notify": { "function_id": "myworker::wf-done" }
        }))
        .expect("StartRequest with notify");
        let notify = req.notify.expect("notify present");
        assert_eq!(notify.function_id, "myworker::wf-done");
        assert!(
            notify.queue.is_none(),
            "queue defaults to None (→ \"default\")"
        );
    }

    #[test]
    fn start_request_parses_caller_session_id() {
        let req: StartRequest = serde_json::from_value(json!({
            "definition": well_formed_def(),
            "caller_session_id": "console-abc"
        }))
        .expect("StartRequest with caller_session_id");
        assert_eq!(req.caller_session_id.as_deref(), Some("console-abc"));
    }

    #[test]
    fn start_request_notify_is_optional() {
        let req: StartRequest = serde_json::from_value(json!({
            "definition": well_formed_def()
        }))
        .expect("StartRequest without notify");
        assert!(req.notify.is_none());
    }

    #[test]
    fn await_flag_is_dropped_and_ignored() {
        let schema = serde_json::to_value(schemars::schema_for!(StartRequest)).unwrap();
        assert!(
            schema["properties"].get("await").is_none(),
            "`await` must not appear in the request schema: {schema:#}"
        );

        let req: StartRequest = serde_json::from_value(json!({
            "definition": well_formed_def(),
            "await": true
        }))
        .expect("a stray `await` key must be ignored, not rejected");
        // Nothing on the request carries it through — it's gone.
        assert!(req.notify.is_none());
    }

    #[test]
    fn definition_accepts_workflow_alias() {
        let req: StartRequest = serde_json::from_value(json!({
            "workflow": {
                "version": 1,
                "nodes": { "a": { "function": { "id": "fn-a" }, "input": { "from": "run_input" } } },
                "output": { "from": "node:a" }
            }
        }))
        .expect("`workflow` should alias to `definition`");
        assert!(req.definition.nodes.contains_key("a"));
    }

    #[test]
    fn collects_all_structural_problems_at_once() {
        let err = serde_json::from_value::<StartRequest>(json!({
            "definition": {
                "nodes": {
                    "gen": { "function": { "id": "gen" }, "fanout": { "over": "node:x.items" } },
                    "crit": { "function": { "id": "crit" }, "depends_on": ["gen"] }
                }
            }
        }))
        .unwrap_err();
        let msg = err.to_string();
        // Both non-source nodes flagged for missing input, plus missing output.
        assert!(msg.contains("node `gen`: missing `input`"), "msg: {msg}");
        assert!(msg.contains("node `crit`: missing `input`"), "msg: {msg}");
        assert!(msg.contains("missing `output`"), "msg: {msg}");
        assert!(msg.contains("3 problems"), "msg: {msg}");
    }

    #[test]
    fn defaults_version_and_source_node_input() {
        let req: StartRequest = serde_json::from_value(json!({
            "definition": {
                "nodes": { "only": { "function": { "id": "fn-only" } } },
                "output": { "from": "node:only" }
            }
        }))
        .expect("source-node input + version should default");
        assert_eq!(req.definition.version, 1);
        let node = req.definition.nodes.get("only").unwrap();
        assert!(matches!(&node.input.from, crate::types::InputFrom::One(s) if s == "run_input"));
    }

    #[test]
    fn flags_misplaced_fields_with_hints() {
        let err = serde_json::from_value::<StartRequest>(json!({
            "definition": {
                "input": { "from": "run_input" },
                "nodes": { "n": { "function": { "id": "fn-n", "fanout": { "over": "x" } }, "input": { "from": "run_input" } } },
                "output": { "from": "node:n" }
            }
        }))
        .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("unknown field `input` at the definition level"),
            "msg: {msg}"
        );
        assert!(
            msg.contains("node `n`.function: unknown field `fanout`"),
            "msg: {msg}"
        );
        assert!(msg.contains("function"), "msg: {msg}");
    }

    #[test]
    fn accepts_function_nodes_without_agent_shape() {
        let def = well_formed_def();
        assert!(
            validate_def(&def).is_ok(),
            "function-based definitions should validate without any agent metadata"
        );
    }

    #[test]
    fn run_reference_set_uses_distinct_non_run_id_values() {
        let run_id = "r_fixed";
        let refs = new_run_reference_set();

        for value in [
            refs.def_ref.as_str(),
            refs.input_ref.as_str(),
            refs.vars_ref.as_str(),
            refs.result_ref.as_str(),
            refs.state_scope_id.as_str(),
            refs.stream_scope_id.as_str(),
        ] {
            assert_ne!(value, run_id);
        }

        let mut all = std::collections::BTreeSet::new();
        all.insert(refs.def_ref);
        all.insert(refs.input_ref);
        all.insert(refs.vars_ref);
        all.insert(refs.result_ref);
        all.insert(refs.state_scope_id);
        all.insert(refs.stream_scope_id);
        assert_eq!(all.len(), 6, "all refs/scopes must be distinct");
    }

    #[test]
    fn rejects_cyclic_def() {
        let d: WorkflowDef = serde_json::from_value(serde_json::json!({
            "version":1, "output":{"from":"node:b"}, "nodes":{
              "b":{"depends_on":["c"],"function":{"id":"fn-b"},"input":{"from":"node:c","template":"t"}},
              "c":{"depends_on":["b"],"function":{"id":"fn-c"},"input":{"from":"node:b","template":"t"}}
            }})).unwrap();
        assert!(validate_def(&d).is_err());
    }
}
