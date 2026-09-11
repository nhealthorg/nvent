use std::collections::BTreeSet;

use async_trait::async_trait;
use redis::AsyncCommands;
use serde_json::Value;

use crate::config::WorkerConfig;
use crate::error::WorkflowError;
use crate::ids::now_ms;
use crate::internal_state::file::FileWorkflowInternalStateStore;
use crate::internal_state::{
    run_matches_workflow_filter, ListRunsFilter, WorkflowInternalStateStore,
};
use crate::state::{WorkflowRunLogRecord, WorkflowRunTraceRecord};
use crate::types::{
    AgentTaskRecord, QueueReceiptRecord, RunStatus, WorkflowDef, WorkflowRunRecord,
};

pub struct RedisWorkflowInternalStateStore {
    client: Option<redis::Client>,
    idempotency_ttl_ms: u64,
    redis_global_log_trace_index: bool,
    fallback: FileWorkflowInternalStateStore,
}

impl RedisWorkflowInternalStateStore {
    pub fn new(cfg: &WorkerConfig) -> Self {
        let client = match cfg.internal_state_redis_url.as_deref() {
            Some(url) => match redis::Client::open(url) {
                Ok(client) => {
                    tracing::info!("internal_state_backend=redis initialized with redis_url");
                    Some(client)
                }
                Err(err) => {
                    tracing::warn!(
                        "internal_state_backend=redis could not parse internal_state_redis_url ({}); using file fallback",
                        err
                    );
                    None
                }
            },
            None => {
                tracing::warn!(
                    "internal_state_backend=redis configured without internal_state_redis_url; using file fallback"
                );
                None
            }
        };

        Self {
            client,
            idempotency_ttl_ms: cfg.idempotency_ttl_ms,
            redis_global_log_trace_index: cfg.redis_global_log_trace_index,
            fallback: FileWorkflowInternalStateStore::new(cfg),
        }
    }

    fn has_redis(&self) -> bool {
        self.client.is_some()
    }

    async fn conn(&self) -> Result<redis::aio::MultiplexedConnection, WorkflowError> {
        let Some(client) = &self.client else {
            return Err(WorkflowError::State(
                "redis backend requested but redis client is not configured".to_string(),
            ));
        };

        client
            .get_multiplexed_async_connection()
            .await
            .map_err(|err| WorkflowError::State(format!("redis connection failed: {err}")))
    }

    fn runs_index_key(&self) -> &'static str {
        "nvent:wf:runs"
    }

    fn runs_status_index_key(&self, status: RunStatus) -> &'static str {
        match status {
            RunStatus::Running => "nvent:wf:runs:status:running",
            RunStatus::AwaitingNodes => "nvent:wf:runs:status:awaiting_nodes",
            RunStatus::Completed => "nvent:wf:runs:status:completed",
            RunStatus::Failed => "nvent:wf:runs:status:failed",
            RunStatus::Cancelled => "nvent:wf:runs:status:cancelled",
        }
    }

    fn runs_workflow_trigram_index_key(&self, trigram: &str) -> String {
        format!("nvent:wf:runs:workflow:tri:{}", sanitize_segment(trigram))
    }

    fn run_key(&self, run_id: &str) -> String {
        format!("nvent:wf:run:{}", sanitize_segment(run_id))
    }

    fn run_ver_key(&self, run_id: &str) -> String {
        format!("nvent:wf:run-ver:{}", sanitize_segment(run_id))
    }

    fn def_key(&self, run_id: &str) -> String {
        format!("nvent:wf:def:{}", sanitize_segment(run_id))
    }

    fn input_key(&self, run_id: &str) -> String {
        format!("nvent:wf:input:{}", sanitize_segment(run_id))
    }

    fn fanout_key(&self, run_id: &str, node_id: &str) -> String {
        format!(
            "nvent:wf:fanout:{}:{}",
            sanitize_segment(run_id),
            sanitize_segment(node_id)
        )
    }

    fn run_vars_key(&self, run_id: &str) -> String {
        format!("nvent:wf:vars:{}", sanitize_segment(run_id))
    }

    fn run_result_key(&self, run_id: &str) -> String {
        format!("nvent:wf:run-result:{}", sanitize_segment(run_id))
    }

    fn result_key(&self, run_id: &str, node_uid: &str) -> String {
        format!(
            "nvent:wf:result:{}:{}",
            sanitize_segment(run_id),
            sanitize_segment(node_uid)
        )
    }

    fn agent_task_key(&self, task_id: &str) -> String {
        format!("nvent:wf:agent_task:{task_id}")
    }

    fn agent_session_key(&self, session_id: &str) -> String {
        format!("nvent:wf:agent_session:{session_id}")
    }

    fn run_agent_tasks_key(&self, run_id: &str) -> String {
        format!("nvent:wf:run:{run_id}:agent_tasks")
    }

    fn run_log_key(&self, run_id: &str) -> String {
        format!("nvent:wf:run-log:{}", sanitize_segment(run_id))
    }

    fn run_trace_key(&self, run_id: &str) -> String {
        format!("nvent:wf:run-trace:{}", sanitize_segment(run_id))
    }

    fn run_log_global_index_key(&self) -> &'static str {
        "nvent:wf:run-log-index"
    }

    fn run_trace_global_index_key(&self) -> &'static str {
        "nvent:wf:run-trace-index"
    }

    fn session_key(&self, session_id: &str) -> String {
        format!("nvent:wf:session:{}", sanitize_segment(session_id))
    }

    fn idempotency_key(&self, key: &str) -> String {
        format!("nvent:wf:idem:{}", sanitize_segment(key))
    }

    fn workflow_search_blob(&self, record: &WorkflowRunRecord) -> String {
        let mut parts = Vec::with_capacity(3);
        parts.push(record.def_ref.to_lowercase());
        parts.push(record.run_id.to_lowercase());
        if let Some(name) = &record.workflow_name {
            parts.push(name.to_lowercase());
        }
        parts.join("\n")
    }

    fn workflow_trigrams(&self, lowercase: &str) -> Vec<String> {
        let chars: Vec<char> = lowercase.chars().collect();
        if chars.len() < 3 {
            return Vec::new();
        }

        let mut unique = BTreeSet::new();
        for window in chars.windows(3) {
            let mut trigram = String::new();
            trigram.push(window[0]);
            trigram.push(window[1]);
            trigram.push(window[2]);
            unique.insert(trigram);
        }
        unique.into_iter().collect()
    }

    fn workflow_trigram_index_keys_for_run(&self, record: &WorkflowRunRecord) -> Vec<String> {
        let blob = self.workflow_search_blob(record);
        self.workflow_trigrams(&blob)
            .into_iter()
            .map(|tri| self.runs_workflow_trigram_index_key(&tri))
            .collect()
    }

    async fn load_runs_by_ids(
        &self,
        conn: &mut redis::aio::MultiplexedConnection,
        run_ids: &[String],
    ) -> Result<Vec<WorkflowRunRecord>, WorkflowError> {
        let mut out = Vec::with_capacity(run_ids.len());
        for run_id in run_ids {
            let raw: Option<String> = conn.get(self.run_key(run_id)).await.map_err(|err| {
                WorkflowError::State(format!("redis get run failed for {run_id}: {err}"))
            })?;

            if let Some(raw) = raw {
                out.push(
                    serde_json::from_str::<WorkflowRunRecord>(&raw)
                        .map_err(WorkflowError::Serde)?,
                );
            }
        }
        Ok(out)
    }

    async fn get_run_version(
        &self,
        conn: &mut redis::aio::MultiplexedConnection,
        run_id: &str,
    ) -> Result<Option<u64>, WorkflowError> {
        conn.get(self.run_ver_key(run_id)).await.map_err(|err| {
            WorkflowError::State(format!("redis get run version failed for {run_id}: {err}"))
        })
    }

    async fn put_run_non_cas(
        &self,
        conn: &mut redis::aio::MultiplexedConnection,
        record: &WorkflowRunRecord,
    ) -> Result<(), WorkflowError> {
        let current_version = self
            .get_run_version(conn, &record.run_id)
            .await?
            .unwrap_or(0);
        let next_version = current_version.saturating_add(1);
        let payload = serde_json::to_string(record).map_err(WorkflowError::Serde)?;
        let run_key = self.run_key(&record.run_id);
        let run_ver_key = self.run_ver_key(&record.run_id);
        let workflow_index_keys = self.workflow_trigram_index_keys_for_run(record);

        let mut pipe = redis::pipe();
        pipe.atomic()
            .cmd("SET")
            .arg(&run_key)
            .arg(payload)
            .ignore()
            .cmd("SET")
            .arg(&run_ver_key)
            .arg(next_version)
            .ignore()
            .cmd("SADD")
            .arg(self.runs_index_key())
            .arg(&record.run_id)
            .ignore()
            .cmd("SREM")
            .arg(self.runs_status_index_key(RunStatus::Running))
            .arg(&record.run_id)
            .ignore()
            .cmd("SREM")
            .arg(self.runs_status_index_key(RunStatus::AwaitingNodes))
            .arg(&record.run_id)
            .ignore()
            .cmd("SREM")
            .arg(self.runs_status_index_key(RunStatus::Completed))
            .arg(&record.run_id)
            .ignore()
            .cmd("SREM")
            .arg(self.runs_status_index_key(RunStatus::Failed))
            .arg(&record.run_id)
            .ignore()
            .cmd("SREM")
            .arg(self.runs_status_index_key(RunStatus::Cancelled))
            .arg(&record.run_id)
            .ignore()
            .cmd("SADD")
            .arg(self.runs_status_index_key(record.status))
            .arg(&record.run_id)
            .ignore();

        for key in workflow_index_keys {
            pipe.cmd("SADD").arg(key).arg(&record.run_id).ignore();
        }

        let _: () = pipe.query_async(conn).await.map_err(|err| {
            WorkflowError::State(format!("redis put run failed for {}: {err}", record.run_id))
        })?;

        Ok(())
    }

    async fn put_run_cas(
        &self,
        conn: &mut redis::aio::MultiplexedConnection,
        record: &WorkflowRunRecord,
        expected_version: u64,
    ) -> Result<(), WorkflowError> {
        let run_key = self.run_key(&record.run_id);
        let run_ver_key = self.run_ver_key(&record.run_id);
        let payload = serde_json::to_string(record).map_err(WorkflowError::Serde)?;
        let workflow_index_keys = self.workflow_trigram_index_keys_for_run(record);

        for _ in 0..16 {
            redis::cmd("WATCH")
                .arg(&run_ver_key)
                .query_async::<()>(conn)
                .await
                .map_err(|err| {
                    WorkflowError::State(format!("redis WATCH failed for {}: {err}", record.run_id))
                })?;

            let current_version: Option<u64> = conn.get(&run_ver_key).await.map_err(|err| {
                WorkflowError::State(format!(
                    "redis get version failed for {}: {err}",
                    record.run_id
                ))
            })?;

            let Some(current_version) = current_version else {
                redis::cmd("UNWATCH")
                    .query_async::<()>(conn)
                    .await
                    .map_err(|err| {
                        WorkflowError::State(format!(
                            "redis UNWATCH failed for {}: {err}",
                            record.run_id
                        ))
                    })?;

                return Err(WorkflowError::State(format!(
                    "put_run CAS conflict for {}: expected_version={} but run does not exist",
                    record.run_id, expected_version
                )));
            };

            if current_version != expected_version {
                redis::cmd("UNWATCH")
                    .query_async::<()>(conn)
                    .await
                    .map_err(|err| {
                        WorkflowError::State(format!(
                            "redis UNWATCH failed for {}: {err}",
                            record.run_id
                        ))
                    })?;

                return Err(WorkflowError::State(format!(
                    "put_run CAS conflict for {}: expected_version={}, actual_version={}",
                    record.run_id, expected_version, current_version
                )));
            }

            let next_version = current_version.saturating_add(1);
            let mut pipe = redis::pipe();
            pipe.atomic()
                .cmd("SET")
                .arg(&run_key)
                .arg(&payload)
                .ignore()
                .cmd("SET")
                .arg(&run_ver_key)
                .arg(next_version)
                .ignore()
                .cmd("SADD")
                .arg(self.runs_index_key())
                .arg(&record.run_id)
                .ignore()
                .cmd("SREM")
                .arg(self.runs_status_index_key(RunStatus::Running))
                .arg(&record.run_id)
                .ignore()
                .cmd("SREM")
                .arg(self.runs_status_index_key(RunStatus::AwaitingNodes))
                .arg(&record.run_id)
                .ignore()
                .cmd("SREM")
                .arg(self.runs_status_index_key(RunStatus::Completed))
                .arg(&record.run_id)
                .ignore()
                .cmd("SREM")
                .arg(self.runs_status_index_key(RunStatus::Failed))
                .arg(&record.run_id)
                .ignore()
                .cmd("SREM")
                .arg(self.runs_status_index_key(RunStatus::Cancelled))
                .arg(&record.run_id)
                .ignore()
                .cmd("SADD")
                .arg(self.runs_status_index_key(record.status))
                .arg(&record.run_id)
                .ignore();

            for key in &workflow_index_keys {
                pipe.cmd("SADD").arg(key).arg(&record.run_id).ignore();
            }

            let exec_result: Option<Vec<redis::Value>> =
                pipe.query_async(conn).await.map_err(|err| {
                    WorkflowError::State(format!(
                        "redis CAS put run failed for {}: {err}",
                        record.run_id
                    ))
                })?;

            if exec_result.is_some() {
                return Ok(());
            }
        }

        Err(WorkflowError::State(format!(
            "put_run CAS conflict for {}: too much concurrent contention",
            record.run_id
        )))
    }

    async fn list_json_records<T: serde::de::DeserializeOwned>(
        &self,
        conn: &mut redis::aio::MultiplexedConnection,
        key: &str,
        label: &str,
    ) -> Result<Vec<T>, WorkflowError> {
        let lines: Vec<String> = conn
            .lrange(key, 0, -1)
            .await
            .map_err(|err| WorkflowError::State(format!("redis list {label} failed: {err}")))?;

        let mut out = Vec::with_capacity(lines.len());
        for line in lines {
            out.push(serde_json::from_str::<T>(&line).map_err(WorkflowError::Serde)?);
        }
        Ok(out)
    }

    async fn list_json_records_latest_page<T: serde::de::DeserializeOwned>(
        &self,
        conn: &mut redis::aio::MultiplexedConnection,
        key: &str,
        label: &str,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<T>, bool), WorkflowError> {
        let total: i64 = conn
            .llen(key)
            .await
            .map_err(|err| WorkflowError::State(format!("redis llen {label} failed: {err}")))?;

        if total <= 0 {
            return Ok((Vec::new(), false));
        }

        let Some((start, end, has_more)) = latest_page_bounds(total, offset, limit) else {
            return Ok((Vec::new(), false));
        };

        let start_isize = isize::try_from(start).map_err(|_| {
            WorkflowError::State(format!(
                "redis paged list {label} start index out of range: {start}"
            ))
        })?;
        let end_isize = isize::try_from(end).map_err(|_| {
            WorkflowError::State(format!(
                "redis paged list {label} end index out of range: {end}"
            ))
        })?;

        let lines: Vec<String> = conn
            .lrange(key, start_isize, end_isize)
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis paged list {label} failed: {err}"))
            })?;

        let mut out = Vec::with_capacity(lines.len());
        for line in lines {
            out.push(serde_json::from_str::<T>(&line).map_err(WorkflowError::Serde)?);
        }
        out.reverse();
        Ok((out, has_more))
    }

    async fn overwrite_json_records<T: serde::Serialize>(
        &self,
        conn: &mut redis::aio::MultiplexedConnection,
        key: &str,
        records: &[T],
    ) -> Result<(), WorkflowError> {
        let mut pipe = redis::pipe();
        pipe.atomic().cmd("DEL").arg(key).ignore();
        for item in records {
            let payload = serde_json::to_string(item).map_err(WorkflowError::Serde)?;
            pipe.cmd("RPUSH").arg(key).arg(payload).ignore();
        }

        let _: () = pipe.query_async(conn).await.map_err(|err| {
            WorkflowError::State(format!("redis overwrite list failed for {key}: {err}"))
        })?;

        Ok(())
    }
}

fn latest_page_bounds(total: i64, offset: u32, limit: u32) -> Option<(i64, i64, bool)> {
    if total <= 0 {
        return None;
    }

    let offset_i = offset as i64;
    if offset_i >= total {
        return None;
    }

    let limit_i = limit.max(1) as i64;
    let end = total - offset_i - 1;
    let start = (end - limit_i + 1).max(0);
    let has_more = start > 0;
    Some((start, end, has_more))
}

#[cfg(test)]
mod tests {
    use super::latest_page_bounds;

    fn apply_latest_page(values: &[i32], offset: u32, limit: u32) -> Vec<i32> {
        let Some((start, end, _)) = latest_page_bounds(values.len() as i64, offset, limit) else {
            return Vec::new();
        };

        let mut page = values[start as usize..=end as usize].to_vec();
        page.reverse();
        page
    }

    #[test]
    fn latest_page_bounds_match_latest_first_paging() {
        let values = vec![1, 2, 3, 4, 5];

        assert_eq!(apply_latest_page(&values, 0, 2), vec![5, 4]);
        assert_eq!(apply_latest_page(&values, 1, 2), vec![4, 3]);
        assert_eq!(apply_latest_page(&values, 4, 2), vec![1]);
        assert!(apply_latest_page(&values, 5, 2).is_empty());
    }
}

fn sanitize_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() * 2);
    for b in raw.as_bytes() {
        out.push(hex((*b >> 4) & 0x0f));
        out.push(hex(*b & 0x0f));
    }
    out
}

fn hex(v: u8) -> char {
    match v {
        0..=9 => (b'0' + v) as char,
        _ => (b'a' + (v - 10)) as char,
    }
}

#[async_trait]
impl WorkflowInternalStateStore for RedisWorkflowInternalStateStore {
    async fn get_run(&self, run_id: &str) -> Result<Option<WorkflowRunRecord>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.get_run(run_id).await;
        }

        let mut conn = self.conn().await?;
        let raw: Option<String> = conn.get(self.run_key(run_id)).await.map_err(|err| {
            WorkflowError::State(format!("redis get run failed for {run_id}: {err}"))
        })?;

        match raw {
            Some(json) => Ok(Some(
                serde_json::from_str::<WorkflowRunRecord>(&json).map_err(WorkflowError::Serde)?,
            )),
            None => Ok(None),
        }
    }

    async fn put_run(
        &self,
        record: &WorkflowRunRecord,
        expected_version: Option<u64>,
    ) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_run(record, expected_version).await;
        }

        let mut conn = self.conn().await?;
        if let Some(expected_version) = expected_version {
            self.put_run_cas(&mut conn, record, expected_version).await
        } else {
            self.put_run_non_cas(&mut conn, record).await
        }
    }

    async fn list_runs(&self) -> Result<Vec<WorkflowRunRecord>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.list_runs().await;
        }

        let mut conn = self.conn().await?;
        let run_ids: Vec<String> = conn
            .smembers(self.runs_index_key())
            .await
            .map_err(|err| WorkflowError::State(format!("redis list runs index failed: {err}")))?;

        self.load_runs_by_ids(&mut conn, &run_ids).await
    }

    async fn list_runs_filtered(
        &self,
        filter: &ListRunsFilter,
    ) -> Result<Vec<WorkflowRunRecord>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.list_runs_filtered(filter).await;
        }

        let workflow_filter = filter
            .workflow
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);

        if filter.status.is_none() && workflow_filter.is_none() {
            return self.list_runs().await;
        }

        let mut conn = self.conn().await?;
        let run_ids: Vec<String> = match (&filter.status, &workflow_filter) {
            (Some(status), None) => conn
                .smembers(self.runs_status_index_key(*status))
                .await
                .map_err(|err| {
                    WorkflowError::State(format!("redis list runs status index failed: {err}"))
                })?,
            (None, Some(workflow)) if self.workflow_trigrams(workflow).is_empty() => {
                conn.smembers(self.runs_index_key()).await.map_err(|err| {
                    WorkflowError::State(format!("redis list runs index failed: {err}"))
                })?
            }
            (Some(status), Some(workflow)) if self.workflow_trigrams(workflow).is_empty() => conn
                .smembers(self.runs_status_index_key(*status))
                .await
                .map_err(|err| {
                    WorkflowError::State(format!("redis list runs status index failed: {err}"))
                })?,
            (status, Some(workflow)) => {
                let trigrams = self.workflow_trigrams(workflow);
                let mut cmd = redis::cmd("SINTER");
                if let Some(status) = status {
                    cmd.arg(self.runs_status_index_key(*status));
                }
                for trigram in trigrams {
                    cmd.arg(self.runs_workflow_trigram_index_key(&trigram));
                }
                cmd.query_async(&mut conn).await.map_err(|err| {
                    WorkflowError::State(format!("redis list runs workflow index failed: {err}"))
                })?
            }
            (None, None) => Vec::new(),
        };

        let mut out = self.load_runs_by_ids(&mut conn, &run_ids).await?;
        if let Some(workflow) = workflow_filter {
            out.retain(|r| run_matches_workflow_filter(r, &workflow));
        }

        if let Some(status) = filter.status {
            out.retain(|r| r.status == status);
        }

        Ok(out)
    }

    async fn delete_run(&self, run_id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_run(run_id).await;
        }

        let mut conn = self.conn().await?;
        let run_key = self.run_key(run_id);
        let raw_run: Option<String> = conn.get(&run_key).await.map_err(|err| {
            WorkflowError::State(format!("redis get run failed for {run_id}: {err}"))
        })?;

        let workflow_index_keys = raw_run
            .as_deref()
            .and_then(|json| serde_json::from_str::<WorkflowRunRecord>(json).ok())
            .map(|record| self.workflow_trigram_index_keys_for_run(&record))
            .unwrap_or_default();

        let mut pipe = redis::pipe();
        pipe.atomic();
        for key in workflow_index_keys {
            pipe.cmd("SREM").arg(key).arg(run_id).ignore();
        }

        let _: () = pipe
            .cmd("DEL")
            .arg(run_key)
            .ignore()
            .cmd("DEL")
            .arg(self.run_ver_key(run_id))
            .ignore()
            .cmd("SREM")
            .arg(self.runs_index_key())
            .arg(run_id)
            .ignore()
            .cmd("SREM")
            .arg(self.runs_status_index_key(RunStatus::Running))
            .arg(run_id)
            .ignore()
            .cmd("SREM")
            .arg(self.runs_status_index_key(RunStatus::AwaitingNodes))
            .arg(run_id)
            .ignore()
            .cmd("SREM")
            .arg(self.runs_status_index_key(RunStatus::Completed))
            .arg(run_id)
            .ignore()
            .cmd("SREM")
            .arg(self.runs_status_index_key(RunStatus::Failed))
            .arg(run_id)
            .ignore()
            .cmd("SREM")
            .arg(self.runs_status_index_key(RunStatus::Cancelled))
            .arg(run_id)
            .ignore()
            .query_async(&mut conn)
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis delete run failed for {run_id}: {err}"))
            })?;
        Ok(())
    }

    async fn get_def(&self, run_id: &str) -> Result<Option<WorkflowDef>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.get_def(run_id).await;
        }

        let mut conn = self.conn().await?;
        let raw: Option<String> = conn.get(self.def_key(run_id)).await.map_err(|err| {
            WorkflowError::State(format!("redis get def failed for {run_id}: {err}"))
        })?;

        match raw {
            Some(json) => Ok(Some(
                serde_json::from_str::<WorkflowDef>(&json).map_err(WorkflowError::Serde)?,
            )),
            None => Ok(None),
        }
    }

    async fn put_def(&self, run_id: &str, def: &WorkflowDef) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_def(run_id, def).await;
        }

        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(def).map_err(WorkflowError::Serde)?;
        conn.set(self.def_key(run_id), payload)
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis put def failed for {run_id}: {err}"))
            })
    }

    async fn delete_def(&self, run_id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_def(run_id).await;
        }

        let mut conn = self.conn().await?;
        conn.del::<_, ()>(self.def_key(run_id))
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis delete def failed for {run_id}: {err}"))
            })
    }

    async fn get_run_input(&self, run_id: &str) -> Result<Option<Value>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.get_run_input(run_id).await;
        }

        let mut conn = self.conn().await?;
        let raw: Option<String> = conn.get(self.input_key(run_id)).await.map_err(|err| {
            WorkflowError::State(format!("redis get input failed for {run_id}: {err}"))
        })?;

        match raw {
            Some(json) => Ok(Some(
                serde_json::from_str::<Value>(&json).map_err(WorkflowError::Serde)?,
            )),
            None => Ok(None),
        }
    }

    async fn put_run_input(&self, run_id: &str, value: &Value) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_run_input(run_id, value).await;
        }

        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(value).map_err(WorkflowError::Serde)?;
        conn.set(self.input_key(run_id), payload)
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis put input failed for {run_id}: {err}"))
            })
    }

    async fn delete_run_input(&self, run_id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_run_input(run_id).await;
        }

        let mut conn = self.conn().await?;
        conn.del::<_, ()>(self.input_key(run_id))
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis delete input failed for {run_id}: {err}"))
            })
    }

    async fn get_fanout_items(
        &self,
        run_id: &str,
        node_id: &str,
    ) -> Result<Option<Vec<Value>>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.get_fanout_items(run_id, node_id).await;
        }

        let mut conn = self.conn().await?;
        let raw: Option<String> =
            conn.get(self.fanout_key(run_id, node_id))
                .await
                .map_err(|err| {
                    WorkflowError::State(format!(
                        "redis get fanout items failed for {run_id}/{node_id}: {err}"
                    ))
                })?;

        match raw {
            Some(json) => Ok(Some(
                serde_json::from_str::<Vec<Value>>(&json).map_err(WorkflowError::Serde)?,
            )),
            None => Ok(None),
        }
    }

    async fn put_fanout_items(
        &self,
        run_id: &str,
        node_id: &str,
        items: &[Value],
    ) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_fanout_items(run_id, node_id, items).await;
        }

        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(items).map_err(WorkflowError::Serde)?;
        conn.set(self.fanout_key(run_id, node_id), payload)
            .await
            .map_err(|err| {
                WorkflowError::State(format!(
                    "redis put fanout items failed for {run_id}/{node_id}: {err}"
                ))
            })
    }

    async fn delete_fanout_items(&self, run_id: &str, node_id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_fanout_items(run_id, node_id).await;
        }

        let mut conn = self.conn().await?;
        conn.del::<_, ()>(self.fanout_key(run_id, node_id))
            .await
            .map_err(|err| {
                WorkflowError::State(format!(
                    "redis delete fanout items failed for {run_id}/{node_id}: {err}"
                ))
            })
    }

    async fn get_run_vars(&self, run_id: &str) -> Result<Option<Value>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.get_run_vars(run_id).await;
        }

        let mut conn = self.conn().await?;
        let raw: Option<String> = conn.get(self.run_vars_key(run_id)).await.map_err(|err| {
            WorkflowError::State(format!("redis get vars failed for {run_id}: {err}"))
        })?;

        match raw {
            Some(json) => Ok(Some(
                serde_json::from_str::<Value>(&json).map_err(WorkflowError::Serde)?,
            )),
            None => Ok(None),
        }
    }

    async fn put_run_vars(&self, run_id: &str, value: &Value) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_run_vars(run_id, value).await;
        }

        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(value).map_err(WorkflowError::Serde)?;
        conn.set(self.run_vars_key(run_id), payload)
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis put vars failed for {run_id}: {err}"))
            })
    }

    async fn delete_run_vars(&self, run_id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_run_vars(run_id).await;
        }

        let mut conn = self.conn().await?;
        conn.del::<_, ()>(self.run_vars_key(run_id))
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis delete vars failed for {run_id}: {err}"))
            })
    }

    async fn get_run_result(&self, run_id: &str) -> Result<Option<Value>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.get_run_result(run_id).await;
        }

        let mut conn = self.conn().await?;
        let raw: Option<String> = conn.get(self.run_result_key(run_id)).await.map_err(|err| {
            WorkflowError::State(format!("redis get run result failed for {run_id}: {err}"))
        })?;

        match raw {
            Some(json) => Ok(Some(
                serde_json::from_str::<Value>(&json).map_err(WorkflowError::Serde)?,
            )),
            None => Ok(None),
        }
    }

    async fn put_run_result(&self, run_id: &str, value: &Value) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_run_result(run_id, value).await;
        }

        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(value).map_err(WorkflowError::Serde)?;
        conn.set(self.run_result_key(run_id), payload)
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis put run result failed for {run_id}: {err}"))
            })
    }

    async fn delete_run_result(&self, run_id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_run_result(run_id).await;
        }

        let mut conn = self.conn().await?;
        conn.del::<_, ()>(self.run_result_key(run_id))
            .await
            .map_err(|err| {
                WorkflowError::State(format!(
                    "redis delete run result failed for {run_id}: {err}"
                ))
            })
    }

    async fn get_node_result(
        &self,
        run_id: &str,
        node_uid: &str,
    ) -> Result<Option<Value>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.get_node_result(run_id, node_uid).await;
        }

        let mut conn = self.conn().await?;
        let raw: Option<String> =
            conn.get(self.result_key(run_id, node_uid))
                .await
                .map_err(|err| {
                    WorkflowError::State(format!(
                        "redis get node result failed for {run_id}/{node_uid}: {err}"
                    ))
                })?;

        match raw {
            Some(json) => Ok(Some(
                serde_json::from_str::<Value>(&json).map_err(WorkflowError::Serde)?,
            )),
            None => Ok(None),
        }
    }

    async fn put_node_result(
        &self,
        run_id: &str,
        node_uid: &str,
        value: &Value,
    ) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_node_result(run_id, node_uid, value).await;
        }

        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(value).map_err(WorkflowError::Serde)?;
        conn.set(self.result_key(run_id, node_uid), payload)
            .await
            .map_err(|err| {
                WorkflowError::State(format!(
                    "redis put node result failed for {run_id}/{node_uid}: {err}"
                ))
            })
    }

    async fn delete_node_result(&self, run_id: &str, node_uid: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_node_result(run_id, node_uid).await;
        }

        let mut conn = self.conn().await?;
        conn.del::<_, ()>(self.result_key(run_id, node_uid))
            .await
            .map_err(|err| {
                WorkflowError::State(format!(
                    "redis delete node result failed for {run_id}/{node_uid}: {err}"
                ))
            })
    }

    async fn put_agent_task(&self, task: &AgentTaskRecord) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_agent_task(task).await;
        }

        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(task).map_err(WorkflowError::Serde)?;
        let mut pipe = redis::pipe();
        pipe.atomic()
            .cmd("SET")
            .arg(self.agent_task_key(&task.task_id))
            .arg(&payload)
            .ignore()
            .cmd("SET")
            .arg(self.agent_session_key(&task.agent_session_id))
            .arg(&task.task_id)
            .ignore()
            .cmd("SADD")
            .arg(self.run_agent_tasks_key(&task.run_id))
            .arg(&task.task_id)
            .ignore();

        let _: () = pipe.query_async(&mut conn).await.map_err(|err| {
            WorkflowError::State(format!(
                "redis put agent task failed for {}: {err}",
                task.task_id
            ))
        })?;

        Ok(())
    }

    async fn get_agent_task(
        &self,
        task_id: &str,
    ) -> Result<Option<AgentTaskRecord>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.get_agent_task(task_id).await;
        }

        let mut conn = self.conn().await?;
        let raw: Option<String> = conn
            .get(self.agent_task_key(task_id))
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis get agent task failed for {task_id}: {err}"))
            })?;

        match raw {
            Some(json_str) => {
                let task = serde_json::from_str(&json_str).map_err(WorkflowError::Serde)?;
                Ok(Some(task))
            }
            None => Ok(None),
        }
    }

    async fn get_agent_task_by_session(
        &self,
        agent_session_id: &str,
    ) -> Result<Option<AgentTaskRecord>, WorkflowError> {
        if !self.has_redis() {
            return self
                .fallback
                .get_agent_task_by_session(agent_session_id)
                .await;
        }

        let mut conn = self.conn().await?;
        let task_id: Option<String> = conn
            .get(self.agent_session_key(agent_session_id))
            .await
            .map_err(|err| {
                WorkflowError::State(format!(
                    "redis get agent session key failed for {agent_session_id}: {err}"
                ))
            })?;

        if let Some(task_id) = task_id {
            self.get_agent_task(&task_id).await
        } else {
            Ok(None)
        }
    }

    async fn list_agent_tasks_for_run(
        &self,
        run_id: &str,
    ) -> Result<Vec<AgentTaskRecord>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.list_agent_tasks_for_run(run_id).await;
        }

        let mut conn = self.conn().await?;
        let task_ids: Vec<String> = conn
            .smembers(self.run_agent_tasks_key(run_id))
            .await
            .map_err(|err| {
                WorkflowError::State(format!(
                    "redis smembers agent tasks failed for {run_id}: {err}"
                ))
            })?;

        let mut tasks = Vec::new();
        for task_id in task_ids {
            if let Some(task) = self.get_agent_task(&task_id).await? {
                tasks.push(task);
            }
        }

        Ok(tasks)
    }

    async fn delete_agent_tasks_for_run(&self, run_id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_agent_tasks_for_run(run_id).await;
        }

        let tasks = self.list_agent_tasks_for_run(run_id).await?;
        let mut conn = self.conn().await?;

        for task in &tasks {
            let _ = conn.del::<_, ()>(self.agent_task_key(&task.task_id)).await;
            let _ = conn
                .del::<_, ()>(self.agent_session_key(&task.agent_session_id))
                .await;
        }
        let _ = conn.del::<_, ()>(self.run_agent_tasks_key(run_id)).await;

        Ok(())
    }

    async fn put_run_log(
        &self,
        run_id: &str,
        entry: &WorkflowRunLogRecord,
    ) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_run_log(run_id, entry).await;
        }

        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(entry).map_err(WorkflowError::Serde)?;
        conn.rpush::<_, _, ()>(self.run_log_key(run_id), payload)
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis put run log failed for {run_id}: {err}"))
            })?;

        if self.redis_global_log_trace_index {
            let member = format!("{}:{}", run_id, entry.id);
            conn.zadd::<_, _, _, ()>(self.run_log_global_index_key(), member, entry.ts_unix_ms)
                .await
                .map_err(|err| {
                    WorkflowError::State(format!(
                        "redis zadd run log index failed for {run_id}: {err}"
                    ))
                })?;
        }

        Ok(())
    }

    async fn list_run_logs(
        &self,
        run_id: &str,
    ) -> Result<Vec<WorkflowRunLogRecord>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.list_run_logs(run_id).await;
        }

        let mut conn = self.conn().await?;
        self.list_json_records(&mut conn, &self.run_log_key(run_id), "run logs")
            .await
    }

    async fn list_run_logs_paged(
        &self,
        run_id: &str,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<WorkflowRunLogRecord>, bool), WorkflowError> {
        if !self.has_redis() {
            return self
                .fallback
                .list_run_logs_paged(run_id, offset, limit)
                .await;
        }

        let mut conn = self.conn().await?;
        self.list_json_records_latest_page(
            &mut conn,
            &self.run_log_key(run_id),
            "run logs",
            offset,
            limit,
        )
        .await
    }

    async fn delete_run_log_key(&self, run_id: &str, id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_run_log_key(run_id, id).await;
        }

        let mut rows = self.list_run_logs(run_id).await?;
        rows.retain(|row| row.id != id);

        let mut conn = self.conn().await?;
        self.overwrite_json_records(&mut conn, &self.run_log_key(run_id), &rows)
            .await?;

        if self.redis_global_log_trace_index {
            let member = format!("{}:{}", run_id, id);
            conn.zrem::<_, _, ()>(self.run_log_global_index_key(), member)
                .await
                .map_err(|err| {
                    WorkflowError::State(format!(
                        "redis zrem run log index failed for {run_id}: {err}"
                    ))
                })?;
        }

        Ok(())
    }

    async fn prune_run_logs_before(
        &self,
        run_id: &str,
        cutoff_unix_ms: i64,
    ) -> Result<u64, WorkflowError> {
        if !self.has_redis() {
            return self
                .fallback
                .prune_run_logs_before(run_id, cutoff_unix_ms)
                .await;
        }

        let rows = self.list_run_logs(run_id).await?;
        let mut kept = Vec::with_capacity(rows.len());
        let mut removed_ids = Vec::new();
        for row in rows {
            if row.ts_unix_ms < cutoff_unix_ms {
                removed_ids.push(row.id);
            } else {
                kept.push(row);
            }
        }
        let removed = removed_ids.len() as u64;

        let mut conn = self.conn().await?;
        self.overwrite_json_records(&mut conn, &self.run_log_key(run_id), &kept)
            .await?;

        if self.redis_global_log_trace_index && !removed_ids.is_empty() {
            let members: Vec<String> = removed_ids
                .iter()
                .map(|id| format!("{}:{}", run_id, id))
                .collect();
            conn.zrem::<_, _, ()>(self.run_log_global_index_key(), members)
                .await
                .map_err(|err| {
                    WorkflowError::State(format!("redis zrem run log index failed: {err}"))
                })?;
        }

        Ok(removed)
    }

    async fn put_run_trace(
        &self,
        run_id: &str,
        entry: &WorkflowRunTraceRecord,
    ) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_run_trace(run_id, entry).await;
        }

        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(entry).map_err(WorkflowError::Serde)?;
        conn.rpush::<_, _, ()>(self.run_trace_key(run_id), payload)
            .await
            .map_err(|err| {
                WorkflowError::State(format!("redis put run trace failed for {run_id}: {err}"))
            })?;

        if self.redis_global_log_trace_index {
            let member = format!("{}:{}", run_id, entry.id);
            conn.zadd::<_, _, _, ()>(self.run_trace_global_index_key(), member, entry.ts_unix_ms)
                .await
                .map_err(|err| {
                    WorkflowError::State(format!(
                        "redis zadd run trace index failed for {run_id}: {err}"
                    ))
                })?;
        }

        Ok(())
    }

    async fn list_run_traces(
        &self,
        run_id: &str,
    ) -> Result<Vec<WorkflowRunTraceRecord>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.list_run_traces(run_id).await;
        }

        let mut conn = self.conn().await?;
        self.list_json_records(&mut conn, &self.run_trace_key(run_id), "run traces")
            .await
    }

    async fn list_run_traces_paged(
        &self,
        run_id: &str,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<WorkflowRunTraceRecord>, bool), WorkflowError> {
        if !self.has_redis() {
            return self
                .fallback
                .list_run_traces_paged(run_id, offset, limit)
                .await;
        }

        let mut conn = self.conn().await?;
        self.list_json_records_latest_page(
            &mut conn,
            &self.run_trace_key(run_id),
            "run traces",
            offset,
            limit,
        )
        .await
    }

    async fn delete_run_trace_key(&self, run_id: &str, id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_run_trace_key(run_id, id).await;
        }

        let mut rows = self.list_run_traces(run_id).await?;
        rows.retain(|row| row.id != id);

        let mut conn = self.conn().await?;
        self.overwrite_json_records(&mut conn, &self.run_trace_key(run_id), &rows)
            .await?;

        if self.redis_global_log_trace_index {
            let member = format!("{}:{}", run_id, id);
            conn.zrem::<_, _, ()>(self.run_trace_global_index_key(), member)
                .await
                .map_err(|err| {
                    WorkflowError::State(format!(
                        "redis zrem run trace index failed for {run_id}: {err}"
                    ))
                })?;
        }

        Ok(())
    }

    async fn prune_run_traces_before(
        &self,
        run_id: &str,
        cutoff_unix_ms: i64,
    ) -> Result<u64, WorkflowError> {
        if !self.has_redis() {
            return self
                .fallback
                .prune_run_traces_before(run_id, cutoff_unix_ms)
                .await;
        }

        let rows = self.list_run_traces(run_id).await?;
        let mut kept = Vec::with_capacity(rows.len());
        let mut removed_ids = Vec::new();
        for row in rows {
            if row.ts_unix_ms < cutoff_unix_ms {
                removed_ids.push(row.id);
            } else {
                kept.push(row);
            }
        }
        let removed = removed_ids.len() as u64;

        let mut conn = self.conn().await?;
        self.overwrite_json_records(&mut conn, &self.run_trace_key(run_id), &kept)
            .await?;

        if self.redis_global_log_trace_index && !removed_ids.is_empty() {
            let members: Vec<String> = removed_ids
                .iter()
                .map(|id| format!("{}:{}", run_id, id))
                .collect();
            conn.zrem::<_, _, ()>(self.run_trace_global_index_key(), members)
                .await
                .map_err(|err| {
                    WorkflowError::State(format!("redis zrem run trace index failed: {err}"))
                })?;
        }

        Ok(removed)
    }

    async fn put_session_index(&self, session_id: &str, run_id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_session_index(session_id, run_id).await;
        }

        let mut conn = self.conn().await?;
        conn.set(self.session_key(session_id), run_id)
            .await
            .map_err(|err| {
                WorkflowError::State(format!(
                    "redis put session index failed for {session_id}: {err}"
                ))
            })
    }

    async fn run_id_for_session(&self, session_id: &str) -> Result<Option<String>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.run_id_for_session(session_id).await;
        }

        let mut conn = self.conn().await?;
        conn.get(self.session_key(session_id)).await.map_err(|err| {
            WorkflowError::State(format!(
                "redis get session index failed for {session_id}: {err}"
            ))
        })
    }

    async fn delete_session_index(&self, session_id: &str) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.delete_session_index(session_id).await;
        }

        let mut conn = self.conn().await?;
        conn.del::<_, ()>(self.session_key(session_id))
            .await
            .map_err(|err| {
                WorkflowError::State(format!(
                    "redis delete session index failed for {session_id}: {err}"
                ))
            })
    }

    async fn put_idempotency_key(
        &self,
        key: &str,
        run_id: &str,
        ttl_ms: Option<u64>,
    ) -> Result<(), WorkflowError> {
        if !self.has_redis() {
            return self.fallback.put_idempotency_key(key, run_id, ttl_ms).await;
        }

        let mut conn = self.conn().await?;
        let ttl = ttl_ms.unwrap_or(self.idempotency_ttl_ms);
        let key = self.idempotency_key(key);

        if ttl == 0 {
            conn.set::<_, _, ()>(&key, run_id).await.map_err(|err| {
                WorkflowError::State(format!("redis put idempotency failed for {key}: {err}"))
            })
        } else {
            redis::cmd("PSETEX")
                .arg(&key)
                .arg(ttl)
                .arg(run_id)
                .query_async::<()>(&mut conn)
                .await
                .map_err(|err| {
                    WorkflowError::State(format!(
                        "redis put idempotency with ttl failed for {key}: {err}"
                    ))
                })
        }
    }

    async fn run_id_for_idempotency_key(&self, key: &str) -> Result<Option<String>, WorkflowError> {
        if !self.has_redis() {
            return self.fallback.run_id_for_idempotency_key(key).await;
        }

        let mut conn = self.conn().await?;
        conn.get(self.idempotency_key(key)).await.map_err(|err| {
            WorkflowError::State(format!("redis get idempotency failed for {key}: {err}"))
        })
    }

    async fn put_queue_receipt(&self, receipt: &QueueReceiptRecord) -> Result<(), WorkflowError> {
        let mut run = self.get_run(&receipt.run_id).await?.ok_or_else(|| {
            WorkflowError::State(format!(
                "put_queue_receipt: run not found: {}",
                receipt.run_id
            ))
        })?;

        if let Some(existing) = run.queue_receipts.iter_mut().find(|r| r.id == receipt.id) {
            *existing = receipt.clone();
        } else {
            run.queue_receipts.push(receipt.clone());
        }
        run.updated_at = now_ms();
        self.put_run(&run, None).await
    }

    async fn list_queue_receipts(
        &self,
        run_id: &str,
    ) -> Result<Vec<QueueReceiptRecord>, WorkflowError> {
        Ok(self
            .get_run(run_id)
            .await?
            .map(|r| r.queue_receipts)
            .unwrap_or_default())
    }

    async fn delete_run_queue_receipts(&self, run_id: &str) -> Result<(), WorkflowError> {
        let Some(mut run) = self.get_run(run_id).await? else {
            return Ok(());
        };
        if run.queue_receipts.is_empty() {
            return Ok(());
        }
        run.queue_receipts.clear();
        run.updated_at = now_ms();
        self.put_run(&run, None).await
    }
}
