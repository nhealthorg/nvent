use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::config::WorkerConfig;
use crate::error::WorkflowError;
use crate::state::{WorkflowRunLogRecord, WorkflowRunTraceRecord};
use crate::types::{
    AgentTaskRecord, QueueReceiptRecord, RunStatus, WorkflowDef, WorkflowRunRecord,
};

pub mod file;
pub mod redis;

/// Backend type for workflow-internal persistence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InternalStateBackend {
    Redis,
    File,
}

pub fn backend_from_config(cfg: &WorkerConfig) -> Result<InternalStateBackend, WorkflowError> {
    match cfg
        .internal_state_backend
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "redis" => Ok(InternalStateBackend::Redis),
        "file" => Ok(InternalStateBackend::File),
        other => Err(WorkflowError::State(format!(
            "unknown internal_state_backend '{other}', expected 'redis' or 'file'"
        ))),
    }
}

pub fn build_store(
    cfg: &WorkerConfig,
) -> Result<Arc<dyn WorkflowInternalStateStore>, WorkflowError> {
    match backend_from_config(cfg)? {
        InternalStateBackend::Redis => {
            Ok(Arc::new(redis::RedisWorkflowInternalStateStore::new(cfg)))
        }
        InternalStateBackend::File => Ok(Arc::new(file::FileWorkflowInternalStateStore::new(cfg))),
    }
}

#[derive(Debug, Clone, Default)]
pub struct ListRunsFilter {
    pub status: Option<RunStatus>,
    pub workflow: Option<String>,
}

pub fn run_matches_workflow_filter(run: &WorkflowRunRecord, lowercase_filter: &str) -> bool {
    run.def_ref.to_lowercase().contains(lowercase_filter)
        || run.run_id.to_lowercase().contains(lowercase_filter)
        || run
            .workflow_name
            .as_ref()
            .map(|name| name.to_lowercase().contains(lowercase_filter))
            .unwrap_or(false)
}

/// Contract for workflow-internal persistence.
///
/// Important:
/// - This store is for orchestrator-internal data only.
/// - User workflow state (workflow_run_state / ctx.workflow.state.*) remains on iii-state.
#[async_trait]
pub trait WorkflowInternalStateStore: Send + Sync {
    // ---------------------------------------------------------------------
    // Runs / defs / results
    // ---------------------------------------------------------------------

    async fn get_run(&self, run_id: &str) -> Result<Option<WorkflowRunRecord>, WorkflowError>;

    /// Compare-and-set write for run records.
    ///
    /// - `expected_version = Some(v)`: write must succeed only if current version equals `v`.
    /// - `expected_version = None`: reserved for controlled bootstrap/internal paths.
    async fn put_run(
        &self,
        record: &WorkflowRunRecord,
        expected_version: Option<u64>,
    ) -> Result<(), WorkflowError>;

    async fn list_runs(&self) -> Result<Vec<WorkflowRunRecord>, WorkflowError>;
    async fn list_runs_filtered(
        &self,
        filter: &ListRunsFilter,
    ) -> Result<Vec<WorkflowRunRecord>, WorkflowError> {
        let mut runs = self.list_runs().await?;
        if let Some(status) = filter.status {
            runs.retain(|r| r.status == status);
        }
        if let Some(workflow) = filter
            .workflow
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let lowercase_filter = workflow.to_lowercase();
            runs.retain(|r| run_matches_workflow_filter(r, &lowercase_filter));
        }
        Ok(runs)
    }
    async fn delete_run(&self, run_id: &str) -> Result<(), WorkflowError>;

    async fn get_def(&self, run_id: &str) -> Result<Option<WorkflowDef>, WorkflowError>;
    async fn put_def(&self, run_id: &str, def: &WorkflowDef) -> Result<(), WorkflowError>;
    async fn delete_def(&self, run_id: &str) -> Result<(), WorkflowError>;

    async fn get_run_input(&self, run_id: &str) -> Result<Option<Value>, WorkflowError>;
    async fn put_run_input(&self, run_id: &str, value: &Value) -> Result<(), WorkflowError>;
    async fn delete_run_input(&self, run_id: &str) -> Result<(), WorkflowError>;
    async fn get_fanout_items(
        &self,
        run_id: &str,
        node_id: &str,
    ) -> Result<Option<Vec<Value>>, WorkflowError>;
    async fn put_fanout_items(
        &self,
        run_id: &str,
        node_id: &str,
        items: &[Value],
    ) -> Result<(), WorkflowError>;
    async fn delete_fanout_items(&self, run_id: &str, node_id: &str) -> Result<(), WorkflowError>;

    async fn get_run_vars(&self, run_id: &str) -> Result<Option<Value>, WorkflowError>;
    async fn put_run_vars(&self, run_id: &str, value: &Value) -> Result<(), WorkflowError>;
    async fn delete_run_vars(&self, run_id: &str) -> Result<(), WorkflowError>;

    async fn get_run_result(&self, run_id: &str) -> Result<Option<Value>, WorkflowError>;
    async fn put_run_result(&self, run_id: &str, value: &Value) -> Result<(), WorkflowError>;
    async fn delete_run_result(&self, run_id: &str) -> Result<(), WorkflowError>;

    async fn get_node_result(
        &self,
        run_id: &str,
        node_uid: &str,
    ) -> Result<Option<Value>, WorkflowError>;
    async fn put_node_result(
        &self,
        run_id: &str,
        node_uid: &str,
        value: &Value,
    ) -> Result<(), WorkflowError>;
    async fn delete_node_result(&self, run_id: &str, node_uid: &str) -> Result<(), WorkflowError>;

    // ---------------------------------------------------------------------
    // Agent tasks
    // ---------------------------------------------------------------------

    async fn put_agent_task(&self, task: &AgentTaskRecord) -> Result<(), WorkflowError>;
    async fn get_agent_task(&self, task_id: &str)
        -> Result<Option<AgentTaskRecord>, WorkflowError>;
    async fn get_agent_task_by_session(
        &self,
        agent_session_id: &str,
    ) -> Result<Option<AgentTaskRecord>, WorkflowError>;
    async fn list_agent_tasks_for_run(
        &self,
        run_id: &str,
    ) -> Result<Vec<AgentTaskRecord>, WorkflowError>;
    async fn delete_agent_tasks_for_run(&self, run_id: &str) -> Result<(), WorkflowError>;

    // ---------------------------------------------------------------------
    // Logs / traces
    // ---------------------------------------------------------------------

    async fn put_run_log(
        &self,
        run_id: &str,
        entry: &WorkflowRunLogRecord,
    ) -> Result<(), WorkflowError>;
    async fn list_run_logs(&self, run_id: &str)
        -> Result<Vec<WorkflowRunLogRecord>, WorkflowError>;
    async fn list_run_logs_paged(
        &self,
        run_id: &str,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<WorkflowRunLogRecord>, bool), WorkflowError> {
        let mut rows = self.list_run_logs(run_id).await?;
        rows.sort_by(|a, b| b.ts_unix_ms.cmp(&a.ts_unix_ms));

        let start = offset as usize;
        let take = limit.max(1) as usize;
        let total = rows.len();
        let page = rows.into_iter().skip(start).take(take).collect::<Vec<_>>();
        let has_more = start + page.len() < total;
        Ok((page, has_more))
    }
    async fn delete_run_log_key(&self, run_id: &str, id: &str) -> Result<(), WorkflowError>;
    async fn prune_run_logs_before(
        &self,
        run_id: &str,
        cutoff_unix_ms: i64,
    ) -> Result<u64, WorkflowError>;

    async fn put_run_trace(
        &self,
        run_id: &str,
        entry: &WorkflowRunTraceRecord,
    ) -> Result<(), WorkflowError>;
    async fn list_run_traces(
        &self,
        run_id: &str,
    ) -> Result<Vec<WorkflowRunTraceRecord>, WorkflowError>;
    async fn list_run_traces_paged(
        &self,
        run_id: &str,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<WorkflowRunTraceRecord>, bool), WorkflowError> {
        let mut rows = self.list_run_traces(run_id).await?;
        rows.sort_by(|a, b| b.ts_unix_ms.cmp(&a.ts_unix_ms));

        let start = offset as usize;
        let take = limit.max(1) as usize;
        let total = rows.len();
        let page = rows.into_iter().skip(start).take(take).collect::<Vec<_>>();
        let has_more = start + page.len() < total;
        Ok((page, has_more))
    }
    async fn delete_run_trace_key(&self, run_id: &str, id: &str) -> Result<(), WorkflowError>;
    async fn prune_run_traces_before(
        &self,
        run_id: &str,
        cutoff_unix_ms: i64,
    ) -> Result<u64, WorkflowError>;

    // ---------------------------------------------------------------------
    // Integrated helper stores
    // ---------------------------------------------------------------------

    async fn put_session_index(&self, session_id: &str, run_id: &str) -> Result<(), WorkflowError>;
    async fn run_id_for_session(&self, session_id: &str) -> Result<Option<String>, WorkflowError>;
    async fn delete_session_index(&self, session_id: &str) -> Result<(), WorkflowError>;

    async fn put_idempotency_key(
        &self,
        key: &str,
        run_id: &str,
        ttl_ms: Option<u64>,
    ) -> Result<(), WorkflowError>;
    async fn run_id_for_idempotency_key(&self, key: &str) -> Result<Option<String>, WorkflowError>;

    async fn put_queue_receipt(&self, receipt: &QueueReceiptRecord) -> Result<(), WorkflowError>;
    async fn list_queue_receipts(
        &self,
        run_id: &str,
    ) -> Result<Vec<QueueReceiptRecord>, WorkflowError>;
    async fn delete_run_queue_receipts(&self, run_id: &str) -> Result<(), WorkflowError>;
}
