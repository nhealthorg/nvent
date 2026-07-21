use async_trait::async_trait;

use crate::{error::WorkflowError, state};
use iii_sdk::IIIClient;

#[derive(Debug, Clone, Default)]
pub struct LogReadFilter {
    pub node_uid: Option<String>,
    pub function_id: Option<String>,
    pub level: Option<String>,
    pub start_time_ms: Option<i64>,
    pub end_time_ms: Option<i64>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct TraceReadFilter {
    pub node_uid: Option<String>,
    pub function_id: Option<String>,
    pub event_name: Option<String>,
    pub start_time_ms: Option<i64>,
    pub end_time_ms: Option<i64>,
    pub limit: Option<u32>,
}

#[async_trait]
pub trait ObservabilityAdapter: Send + Sync {
    async fn write_log(
        &self,
        iii: &IIIClient,
        entry: &state::WorkflowRunLogRecord,
    ) -> Result<(), WorkflowError>;

    async fn read_logs(
        &self,
        iii: &IIIClient,
        run_id: &str,
        filter: &LogReadFilter,
    ) -> Result<Vec<state::WorkflowRunLogRecord>, WorkflowError>;

    async fn delete_log(
        &self,
        iii: &IIIClient,
        run_id: &str,
        id: Option<&str>,
    ) -> Result<(), WorkflowError>;

    async fn prune_logs_before(
        &self,
        iii: &IIIClient,
        run_id: &str,
        cutoff_unix_ms: i64,
    ) -> Result<u64, WorkflowError>;

    async fn write_trace(
        &self,
        iii: &IIIClient,
        entry: &state::WorkflowRunTraceRecord,
    ) -> Result<(), WorkflowError>;

    async fn read_traces(
        &self,
        iii: &IIIClient,
        run_id: &str,
        filter: &TraceReadFilter,
    ) -> Result<Vec<state::WorkflowRunTraceRecord>, WorkflowError>;

    async fn delete_trace(
        &self,
        iii: &IIIClient,
        run_id: &str,
        id: Option<&str>,
    ) -> Result<(), WorkflowError>;

    async fn prune_traces_before(
        &self,
        iii: &IIIClient,
        run_id: &str,
        cutoff_unix_ms: i64,
    ) -> Result<u64, WorkflowError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct StateObservabilityAdapter;

pub fn adapter() -> StateObservabilityAdapter {
    StateObservabilityAdapter
}

#[async_trait]
impl ObservabilityAdapter for StateObservabilityAdapter {
    async fn write_log(
        &self,
        iii: &IIIClient,
        entry: &state::WorkflowRunLogRecord,
    ) -> Result<(), WorkflowError> {
        state::put_run_log(iii, entry).await
    }

    async fn read_logs(
        &self,
        iii: &IIIClient,
        run_id: &str,
        filter: &LogReadFilter,
    ) -> Result<Vec<state::WorkflowRunLogRecord>, WorkflowError> {
        let mut items = state::list_run_logs(iii, run_id).await?;

        if let Some(node_uid) = filter.node_uid.as_deref() {
            items.retain(|item| item.node_uid.as_deref() == Some(node_uid));
        }
        if let Some(function_id) = filter.function_id.as_deref() {
            items.retain(|item| item.function_id.as_deref() == Some(function_id));
        }
        if let Some(level) = filter.level.as_deref() {
            items.retain(|item| item.level.eq_ignore_ascii_case(level));
        }
        if let Some(start) = filter.start_time_ms {
            items.retain(|item| item.ts_unix_ms >= start);
        }
        if let Some(end) = filter.end_time_ms {
            items.retain(|item| item.ts_unix_ms <= end);
        }

        items.sort_by(|a, b| b.ts_unix_ms.cmp(&a.ts_unix_ms));
        let limit = filter.limit.unwrap_or(200).max(1) as usize;
        items.truncate(limit);

        Ok(items)
    }

    async fn delete_log(
        &self,
        iii: &IIIClient,
        run_id: &str,
        id: Option<&str>,
    ) -> Result<(), WorkflowError> {
        if let Some(id) = id {
            return state::delete_run_log_key(iii, run_id, id).await;
        }

        state::delete_run_logs(iii, run_id).await?;

        // Backward-compat cleanup: remove old per-entry rows if they still exist.
        for item in state::list_run_logs(iii, run_id).await? {
            state::delete_run_log_key(iii, run_id, &item.id).await?;
        }
        Ok(())
    }

    async fn prune_logs_before(
        &self,
        iii: &IIIClient,
        run_id: &str,
        cutoff_unix_ms: i64,
    ) -> Result<u64, WorkflowError> {
        state::prune_run_logs_before(iii, run_id, cutoff_unix_ms).await
    }

    async fn write_trace(
        &self,
        iii: &IIIClient,
        entry: &state::WorkflowRunTraceRecord,
    ) -> Result<(), WorkflowError> {
        state::put_run_trace(iii, entry).await
    }

    async fn read_traces(
        &self,
        iii: &IIIClient,
        run_id: &str,
        filter: &TraceReadFilter,
    ) -> Result<Vec<state::WorkflowRunTraceRecord>, WorkflowError> {
        let mut items = state::list_run_traces(iii, run_id).await?;

        if let Some(node_uid) = filter.node_uid.as_deref() {
            items.retain(|item| item.node_uid.as_deref() == Some(node_uid));
        }
        if let Some(function_id) = filter.function_id.as_deref() {
            items.retain(|item| item.function_id.as_deref() == Some(function_id));
        }
        if let Some(event_name) = filter.event_name.as_deref() {
            items.retain(|item| item.event_name == event_name);
        }
        if let Some(start) = filter.start_time_ms {
            items.retain(|item| item.ts_unix_ms >= start);
        }
        if let Some(end) = filter.end_time_ms {
            items.retain(|item| item.ts_unix_ms <= end);
        }

        items.sort_by(|a, b| b.ts_unix_ms.cmp(&a.ts_unix_ms));
        let limit = filter.limit.unwrap_or(200).max(1) as usize;
        items.truncate(limit);

        Ok(items)
    }

    async fn delete_trace(
        &self,
        iii: &IIIClient,
        run_id: &str,
        id: Option<&str>,
    ) -> Result<(), WorkflowError> {
        if let Some(id) = id {
            return state::delete_run_trace_key(iii, run_id, id).await;
        }

        state::delete_run_traces(iii, run_id).await?;

        // Backward-compat cleanup: remove old per-entry rows if they still exist.
        for item in state::list_run_traces(iii, run_id).await? {
            state::delete_run_trace_key(iii, run_id, &item.id).await?;
        }
        Ok(())
    }

    async fn prune_traces_before(
        &self,
        iii: &IIIClient,
        run_id: &str,
        cutoff_unix_ms: i64,
    ) -> Result<u64, WorkflowError> {
        state::prune_run_traces_before(iii, run_id, cutoff_unix_ms).await
    }
}
