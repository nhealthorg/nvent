use async_trait::async_trait;

use crate::{error::WorkflowError, state};
use iii_sdk::IIIClient;

#[derive(Debug, Clone, Default)]
pub struct LogReadFilter {
    pub node_uids: Option<Vec<String>>,
    pub function_id: Option<String>,
    pub level: Option<String>,
    pub start_time_ms: Option<i64>,
    pub end_time_ms: Option<i64>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub loop_index: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct TraceReadFilter {
    pub node_uids: Option<Vec<String>>,
    pub function_id: Option<String>,
    pub event_name: Option<String>,
    pub event_name_prefix: Option<String>,
    pub start_time_ms: Option<i64>,
    pub end_time_ms: Option<i64>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub loop_index: Option<u32>,
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
    ) -> Result<(Vec<state::WorkflowRunLogRecord>, bool, u32), WorkflowError>;

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
    ) -> Result<(Vec<state::WorkflowRunTraceRecord>, bool, u32), WorkflowError>;

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
    ) -> Result<(Vec<state::WorkflowRunLogRecord>, bool, u32), WorkflowError> {
        let limit = filter.limit.unwrap_or(200).max(1);
        let offset = filter.offset.unwrap_or(0);

        let can_use_paged_store = filter.node_uids.is_none()
            && filter.function_id.is_none()
            && filter.level.is_none()
            && filter.start_time_ms.is_none()
            && filter.end_time_ms.is_none()
            && filter.loop_index.is_none();

        if can_use_paged_store {
            let (page, has_more) = state::list_run_logs_paged(iii, run_id, offset, limit).await?;
            let next_offset = offset.saturating_add(page.len() as u32);
            return Ok((page, has_more, next_offset));
        }

        let mut items = state::list_run_logs(iii, run_id).await?;

        items.retain(|item| {
            matches_node_uid_filter(item.node_uid.as_deref(), filter.node_uids.as_deref())
        });
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
        if let Some(loop_index) = filter.loop_index {
            let suffix = format!("#{loop_index}");
            items.retain(|item| {
                item.node_uid
                    .as_deref()
                    .map(|uid| uid.ends_with(&suffix))
                    .unwrap_or(false)
            });
        }

        items.sort_by(|a, b| b.ts_unix_ms.cmp(&a.ts_unix_ms));
        let limit = limit as usize;
        let offset = offset as usize;
        let total = items.len();
        let page = items
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        let next_offset = (offset + page.len()) as u32;
        let has_more = offset + page.len() < total;

        Ok((page, has_more, next_offset))
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
    ) -> Result<(Vec<state::WorkflowRunTraceRecord>, bool, u32), WorkflowError> {
        let limit = filter.limit.unwrap_or(200).max(1);
        let offset = filter.offset.unwrap_or(0);

        read_traces_filtered_paged(iii, run_id, filter, offset, limit).await
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

fn trace_matches_filter(item: &state::WorkflowRunTraceRecord, filter: &TraceReadFilter) -> bool {
    if !matches_node_uid_filter(item.node_uid.as_deref(), filter.node_uids.as_deref()) {
        return false;
    }

    if let Some(function_id) = filter.function_id.as_deref() {
        if item.function_id.as_deref() != Some(function_id) {
            return false;
        }
    }

    if let Some(event_name) = filter.event_name.as_deref() {
        if item.event_name != event_name {
            return false;
        }
    }

    if let Some(event_name_prefix) = filter.event_name_prefix.as_deref() {
        if !item.event_name.starts_with(event_name_prefix) {
            return false;
        }
    }

    if let Some(start) = filter.start_time_ms {
        if item.ts_unix_ms < start {
            return false;
        }
    }

    if let Some(end) = filter.end_time_ms {
        if item.ts_unix_ms > end {
            return false;
        }
    }

    if let Some(loop_index) = filter.loop_index {
        let suffix = format!("#{loop_index}");
        let matches = item
            .node_uid
            .as_deref()
            .map(|uid| uid.ends_with(&suffix))
            .unwrap_or(false);
        if !matches {
            return false;
        }
    }

    true
}

fn matches_node_uid_filter(item_node_uid: Option<&str>, node_uids: Option<&[String]>) -> bool {
    let Some(node_uids) = node_uids else {
        return true;
    };

    let Some(item_node_uid) = item_node_uid else {
        return false;
    };

    let item_base_uid = item_node_uid.split('#').next().unwrap_or(item_node_uid);
    node_uids
        .iter()
        .any(|candidate| candidate == item_node_uid || candidate == item_base_uid)
}

async fn read_traces_filtered_paged(
    iii: &IIIClient,
    run_id: &str,
    filter: &TraceReadFilter,
    offset: u32,
    limit: u32,
) -> Result<(Vec<state::WorkflowRunTraceRecord>, bool, u32), WorkflowError> {
    let mut raw_offset = 0u32;
    let raw_chunk_size = limit.max(200);
    let mut filtered_seen = 0u32;
    let mut page = Vec::new();

    loop {
        let (rows, has_more_raw) =
            state::list_run_traces_paged(iii, run_id, raw_offset, raw_chunk_size).await?;

        if rows.is_empty() {
            let next_offset = offset.saturating_add(page.len() as u32);
            return Ok((page, false, next_offset));
        }

        for item in rows {
            if !trace_matches_filter(&item, filter) {
                continue;
            }

            if filtered_seen < offset {
                filtered_seen = filtered_seen.saturating_add(1);
                continue;
            }

            if page.len() < limit as usize {
                page.push(item);
                filtered_seen = filtered_seen.saturating_add(1);
                continue;
            }

            // Found one more matching row beyond requested page.
            let next_offset = offset.saturating_add(limit.min(page.len() as u32));
            return Ok((page, true, next_offset));
        }

        if !has_more_raw {
            let next_offset = offset.saturating_add(page.len() as u32);
            return Ok((page, false, next_offset));
        }

        raw_offset = raw_offset.saturating_add(raw_chunk_size);
    }
}

#[cfg(test)]
mod tests {
    use super::{matches_node_uid_filter, trace_matches_filter, TraceReadFilter};
    use crate::state::WorkflowRunTraceRecord;

    #[test]
    fn multi_node_filter_matches_base_and_exact_uids() {
        assert!(matches_node_uid_filter(
            Some("fanout#2"),
            Some(&["fanout".to_string()]),
        ));
        assert!(matches_node_uid_filter(
            Some("fanout#2"),
            Some(&["fanout#2".to_string()]),
        ));
        assert!(!matches_node_uid_filter(
            Some("fanout#2"),
            Some(&["other".to_string()]),
        ));
    }

    #[test]
    fn empty_node_uid_filter_matches_all() {
        assert!(matches_node_uid_filter(Some("fanout#2"), None));
        assert!(matches_node_uid_filter(Some("fanout"), None));
    }

    #[test]
    fn trace_filter_applies_multi_node_and_prefix() {
        let item = WorkflowRunTraceRecord {
            id: "trace-1".to_string(),
            run_id: "run-1".to_string(),
            node_uid: Some("fanout#1".to_string()),
            function_id: None,
            runtime: None,
            event_name: "workflow.stream.publish".to_string(),
            ts_unix_ms: 42,
            attributes: None,
            trace_id: None,
            span_id: None,
        };

        let filter = TraceReadFilter {
            node_uids: Some(vec!["fanout".to_string()]),
            function_id: None,
            event_name: None,
            event_name_prefix: Some("workflow.stream.".to_string()),
            start_time_ms: None,
            end_time_ms: None,
            limit: None,
            offset: None,
            loop_index: Some(1),
        };

        assert!(trace_matches_filter(&item, &filter));
    }
}
