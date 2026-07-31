use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkerConfig {
    /// Default wait guard for a parked pending call before the sweep resolves
    /// it with an error. Milliseconds.
    #[serde(default = "default_pending_timeout_ms")]
    pub default_pending_timeout_ms: u64,

    /// Cron expression (6-field) for the pending-call expiry sweep. The one
    /// structural field: a change re-binds the cron trigger live.
    #[serde(default = "default_sweep_expression")]
    pub sweep_expression: String,

    /// RPC timeout for `engine::*` and generic `iii.trigger` dispatch.
    /// Milliseconds.
    #[serde(default = "default_dispatch_timeout_ms")]
    pub dispatch_timeout_ms: u64,

    /// Maximum number of retry attempts per node before it is marked failed
    /// after a timeout or a reported function error. Hot-applies via
    /// config-cell swap (not structural).
    #[serde(default = "default_max_node_retries")]
    pub max_node_retries: u32,

    /// Retention window for terminal workflow run state (`workflow_run` plus
    /// referenced workflow internal definition/result records).
    /// Terminal runs older than this value are deleted by `workflow::sweep`.
    /// Milliseconds.
    #[serde(default = "default_run_retention_ms")]
    pub run_retention_ms: u64,

    /// Retention window for workflow-owned observability records
    /// (`workflow_run_log` and `workflow_run_trace`).
    /// Entries older than this value are pruned by `workflow::sweep`.
    /// Milliseconds.
    #[serde(default = "default_observability_retention_ms")]
    pub observability_retention_ms: u64,

    /// Backend used for workflow-internal persistence.
    ///
    /// - `redis`: production default (robust + scalable)
    /// - `file`: local/dev single-instance backend
    #[serde(default = "default_internal_state_backend")]
    pub internal_state_backend: String,

    /// Redis URL for internal workflow state when backend is `redis`.
    /// Example: redis://127.0.0.1:6379
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal_state_redis_url: Option<String>,

    /// File base directory for internal workflow state when backend is `file`.
    #[serde(default = "default_internal_state_file_dir")]
    pub internal_state_file_dir: String,

    /// Whether Redis should keep global time indexes for logs/traces in addition
    /// to per-run streams.
    #[serde(default = "default_redis_global_log_trace_index")]
    pub redis_global_log_trace_index: bool,

    /// Default TTL for idempotency records.
    /// Milliseconds. 30 days by default.
    #[serde(default = "default_idempotency_ttl_ms")]
    pub idempotency_ttl_ms: u64,

    /// Minimum variable version at which checkpoint snapshots may be stored.
    /// Versions below this threshold keep delta-only history.
    #[serde(default = "default_var_checkpoint_start_version")]
    pub var_checkpoint_start_version: u64,

    /// Store a full variable checkpoint every N versions once the start
    /// threshold is reached. Set to 0 to disable checkpoint snapshots.
    #[serde(default = "default_var_checkpoint_every_versions")]
    pub var_checkpoint_every_versions: u64,
}

fn default_pending_timeout_ms() -> u64 {
    300_000
}
fn default_sweep_expression() -> String {
    "0 * * * * *".to_string()
}
fn default_dispatch_timeout_ms() -> u64 {
    30_000
}
fn default_max_node_retries() -> u32 {
    3
}
fn default_run_retention_ms() -> u64 {
    30 * 24 * 60 * 60 * 1000
}
fn default_observability_retention_ms() -> u64 {
    30 * 24 * 60 * 60 * 1000
}
fn default_internal_state_backend() -> String {
    "redis".to_string()
}
fn default_internal_state_file_dir() -> String {
    ".data/workflow-store".to_string()
}
fn default_redis_global_log_trace_index() -> bool {
    true
}
fn default_idempotency_ttl_ms() -> u64 {
    30 * 24 * 60 * 60 * 1000
}
fn default_var_checkpoint_start_version() -> u64 {
    25
}
fn default_var_checkpoint_every_versions() -> u64 {
    25
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            default_pending_timeout_ms: default_pending_timeout_ms(),
            sweep_expression: default_sweep_expression(),
            dispatch_timeout_ms: default_dispatch_timeout_ms(),
            max_node_retries: default_max_node_retries(),
            run_retention_ms: default_run_retention_ms(),
            observability_retention_ms: default_observability_retention_ms(),
            internal_state_backend: default_internal_state_backend(),
            internal_state_redis_url: None,
            internal_state_file_dir: default_internal_state_file_dir(),
            redis_global_log_trace_index: default_redis_global_log_trace_index(),
            idempotency_ttl_ms: default_idempotency_ttl_ms(),
            var_checkpoint_start_version: default_var_checkpoint_start_version(),
            var_checkpoint_every_versions: default_var_checkpoint_every_versions(),
        }
    }
}

impl WorkerConfig {
    /// Parse a config from a JSON value already env-expanded by the
    /// configuration worker (does NOT re-expand) and tolerant of a zero-field
    /// object (serde defaults fill in).
    pub fn from_json(value: &Value) -> Result<Self, String> {
        serde_json::from_value(value.clone()).map_err(|e| format!("json parse: {e}"))
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).expect("WorkerConfig serializes")
    }

    /// The JSON Schema registered with the `configuration` worker. Field
    /// doc-comments become property descriptions; the shipped defaults are
    /// attached as a top-level `example`.
    pub fn json_schema() -> Value {
        let root = schemars::schema_for!(WorkerConfig);
        let mut schema =
            serde_json::to_value(&root.schema).expect("WorkerConfig JSON Schema serializes");
        if let Some(obj) = schema.as_object_mut() {
            obj.insert("example".into(), WorkerConfig::default().to_json());
        }
        schema
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_from_empty_object() {
        let cfg = WorkerConfig::from_json(&json!({})).expect("parse ok");
        assert_eq!(cfg, WorkerConfig::default());
        assert_eq!(cfg.default_pending_timeout_ms, 300_000);
        assert_eq!(cfg.sweep_expression, "0 * * * * *");
        assert_eq!(cfg.dispatch_timeout_ms, 30_000);
        assert_eq!(cfg.max_node_retries, 3);
        assert_eq!(cfg.run_retention_ms, 30 * 24 * 60 * 60 * 1000);
        assert_eq!(cfg.observability_retention_ms, 30 * 24 * 60 * 60 * 1000);
        assert_eq!(cfg.internal_state_backend, "redis");
        assert_eq!(cfg.internal_state_redis_url, None);
        assert_eq!(cfg.internal_state_file_dir, ".data/workflow-store");
        assert!(cfg.redis_global_log_trace_index);
        assert_eq!(cfg.idempotency_ttl_ms, 30 * 24 * 60 * 60 * 1000);
        assert_eq!(cfg.var_checkpoint_start_version, 25);
        assert_eq!(cfg.var_checkpoint_every_versions, 25);
    }
}
