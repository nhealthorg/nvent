use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;
use tokio::io::AsyncWriteExt;

use crate::config::WorkerConfig;
use crate::error::WorkflowError;
use crate::ids::now_ms;
use crate::internal_state::WorkflowInternalStateStore;
use crate::state::{WorkflowRunLogRecord, WorkflowRunTraceRecord};
use crate::types::{QueueReceiptRecord, WorkflowDef, WorkflowRunRecord};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredRun {
    version: u64,
    record: WorkflowRunRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IdempotencyEntry {
    run_id: String,
    expires_at_ms: Option<i64>,
}

pub struct FileWorkflowInternalStateStore {
    base_dir: PathBuf,
    idempotency_ttl_ms: u64,
}

impl FileWorkflowInternalStateStore {
    pub fn new(cfg: &WorkerConfig) -> Self {
        Self {
            base_dir: PathBuf::from(cfg.internal_state_file_dir.clone()),
            idempotency_ttl_ms: cfg.idempotency_ttl_ms,
        }
    }

    fn runs_dir(&self) -> PathBuf {
        self.base_dir.join("runs")
    }

    fn defs_dir(&self) -> PathBuf {
        self.base_dir.join("defs")
    }

    fn inputs_dir(&self) -> PathBuf {
        self.base_dir.join("inputs")
    }

    fn run_results_dir(&self) -> PathBuf {
        self.base_dir.join("run-results")
    }

    fn results_dir(&self) -> PathBuf {
        self.base_dir.join("results")
    }

    fn logs_dir(&self) -> PathBuf {
        self.base_dir.join("logs")
    }

    fn traces_dir(&self) -> PathBuf {
        self.base_dir.join("traces")
    }

    fn session_index_dir(&self) -> PathBuf {
        self.base_dir.join("session-index")
    }

    fn idempotency_dir(&self) -> PathBuf {
        self.base_dir.join("idempotency")
    }

    fn run_path(&self, run_id: &str) -> PathBuf {
        self.runs_dir().join(format!("{}.json", sanitize_segment(run_id)))
    }

    fn def_path(&self, run_id: &str) -> PathBuf {
        self.defs_dir().join(format!("{}.json", sanitize_segment(run_id)))
    }

    fn input_path(&self, run_id: &str) -> PathBuf {
        self.inputs_dir().join(format!("{}.json", sanitize_segment(run_id)))
    }

    fn run_result_path(&self, run_id: &str) -> PathBuf {
        self.run_results_dir()
            .join(format!("{}.json", sanitize_segment(run_id)))
    }

    fn result_path(&self, run_id: &str, node_uid: &str) -> PathBuf {
        self.results_dir()
            .join(sanitize_segment(run_id))
            .join(format!("{}.json", sanitize_segment(node_uid)))
    }

    fn log_path(&self, run_id: &str) -> PathBuf {
        self.logs_dir().join(format!("{}.ndjson", sanitize_segment(run_id)))
    }

    fn trace_path(&self, run_id: &str) -> PathBuf {
        self.traces_dir().join(format!("{}.ndjson", sanitize_segment(run_id)))
    }

    fn session_path(&self, session_id: &str) -> PathBuf {
        self.session_index_dir()
            .join(format!("{}.json", sanitize_segment(session_id)))
    }

    fn idem_path(&self, key: &str) -> PathBuf {
        self.idempotency_dir()
            .join(format!("{}.json", sanitize_segment(key)))
    }
}

#[async_trait]
impl WorkflowInternalStateStore for FileWorkflowInternalStateStore {
    async fn get_run(&self, run_id: &str) -> Result<Option<WorkflowRunRecord>, WorkflowError> {
        let path = self.run_path(run_id);
        let stored = read_json_opt::<StoredRun>(&path).await?;
        Ok(stored.map(|s| s.record))
    }

    async fn put_run(
        &self,
        record: &WorkflowRunRecord,
        expected_version: Option<u64>,
    ) -> Result<(), WorkflowError> {
        let path = self.run_path(&record.run_id);
        let current = read_json_opt::<StoredRun>(&path).await?;

        if let Some(expected) = expected_version {
            match &current {
                Some(stored) if stored.version == expected => {}
                Some(stored) => {
                    return Err(WorkflowError::State(format!(
                        "put_run CAS conflict for {}: expected_version={}, actual_version={}",
                        record.run_id, expected, stored.version
                    )));
                }
                None => {
                    return Err(WorkflowError::State(format!(
                        "put_run CAS conflict for {}: expected_version={} but run does not exist",
                        record.run_id, expected
                    )));
                }
            }
        }

        let new_version = current.map(|s| s.version + 1).unwrap_or(1);
        let stored = StoredRun {
            version: new_version,
            record: record.clone(),
        };

        write_json_atomic(&path, &stored).await
    }

    async fn list_runs(&self) -> Result<Vec<WorkflowRunRecord>, WorkflowError> {
        let dir = self.runs_dir();
        let mut out = Vec::new();

        let mut entries = match fs::read_dir(&dir).await {
            Ok(v) => v,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(err) => {
                return Err(WorkflowError::State(format!(
                    "list_runs read_dir failed for {}: {}",
                    dir.display(),
                    err
                )));
            }
        };

        while let Some(entry) = entries.next_entry().await.map_err(|err| {
            WorkflowError::State(format!("list_runs read_dir entry failed: {err}"))
        })? {
            let path = entry.path();
            if !is_json_file(&path) {
                continue;
            }
            if let Some(stored) = read_json_opt::<StoredRun>(&path).await? {
                out.push(stored.record);
            }
        }

        Ok(out)
    }

    async fn delete_run(&self, run_id: &str) -> Result<(), WorkflowError> {
        remove_if_exists(&self.run_path(run_id)).await
    }

    async fn get_def(&self, run_id: &str) -> Result<Option<WorkflowDef>, WorkflowError> {
        read_json_opt::<WorkflowDef>(&self.def_path(run_id)).await
    }

    async fn put_def(&self, run_id: &str, def: &WorkflowDef) -> Result<(), WorkflowError> {
        write_json_atomic(&self.def_path(run_id), def).await
    }

    async fn delete_def(&self, run_id: &str) -> Result<(), WorkflowError> {
        remove_if_exists(&self.def_path(run_id)).await
    }

    async fn get_run_input(&self, run_id: &str) -> Result<Option<Value>, WorkflowError> {
        read_json_opt::<Value>(&self.input_path(run_id)).await
    }

    async fn put_run_input(&self, run_id: &str, value: &Value) -> Result<(), WorkflowError> {
        write_json_atomic(&self.input_path(run_id), value).await
    }

    async fn delete_run_input(&self, run_id: &str) -> Result<(), WorkflowError> {
        remove_if_exists(&self.input_path(run_id)).await
    }

    async fn get_run_result(&self, run_id: &str) -> Result<Option<Value>, WorkflowError> {
        read_json_opt::<Value>(&self.run_result_path(run_id)).await
    }

    async fn put_run_result(&self, run_id: &str, value: &Value) -> Result<(), WorkflowError> {
        write_json_atomic(&self.run_result_path(run_id), value).await
    }

    async fn delete_run_result(&self, run_id: &str) -> Result<(), WorkflowError> {
        remove_if_exists(&self.run_result_path(run_id)).await
    }

    async fn get_node_result(&self, run_id: &str, node_uid: &str) -> Result<Option<Value>, WorkflowError> {
        read_json_opt::<Value>(&self.result_path(run_id, node_uid)).await
    }

    async fn put_node_result(&self, run_id: &str, node_uid: &str, value: &Value) -> Result<(), WorkflowError> {
        write_json_atomic(&self.result_path(run_id, node_uid), value).await
    }

    async fn delete_node_result(&self, run_id: &str, node_uid: &str) -> Result<(), WorkflowError> {
        remove_if_exists(&self.result_path(run_id, node_uid)).await
    }

    async fn put_run_log(&self, run_id: &str, entry: &WorkflowRunLogRecord) -> Result<(), WorkflowError> {
        append_ndjson_line(&self.log_path(run_id), entry).await
    }

    async fn list_run_logs(&self, run_id: &str) -> Result<Vec<WorkflowRunLogRecord>, WorkflowError> {
        read_ndjson_lines(&self.log_path(run_id)).await
    }

    async fn delete_run_log_key(&self, run_id: &str, id: &str) -> Result<(), WorkflowError> {
        let mut rows = self.list_run_logs(run_id).await?;
        rows.retain(|r| r.id != id);
        write_ndjson_lines(&self.log_path(run_id), &rows).await
    }

    async fn prune_run_logs_before(&self, run_id: &str, cutoff_unix_ms: i64) -> Result<u64, WorkflowError> {
        let mut rows = self.list_run_logs(run_id).await?;
        let before = rows.len();
        rows.retain(|r| r.ts_unix_ms >= cutoff_unix_ms);
        let removed = (before.saturating_sub(rows.len())) as u64;
        write_ndjson_lines(&self.log_path(run_id), &rows).await?;
        Ok(removed)
    }

    async fn put_run_trace(&self, run_id: &str, entry: &WorkflowRunTraceRecord) -> Result<(), WorkflowError> {
        append_ndjson_line(&self.trace_path(run_id), entry).await
    }

    async fn list_run_traces(&self, run_id: &str) -> Result<Vec<WorkflowRunTraceRecord>, WorkflowError> {
        read_ndjson_lines(&self.trace_path(run_id)).await
    }

    async fn delete_run_trace_key(&self, run_id: &str, id: &str) -> Result<(), WorkflowError> {
        let mut rows = self.list_run_traces(run_id).await?;
        rows.retain(|r| r.id != id);
        write_ndjson_lines(&self.trace_path(run_id), &rows).await
    }

    async fn prune_run_traces_before(&self, run_id: &str, cutoff_unix_ms: i64) -> Result<u64, WorkflowError> {
        let mut rows = self.list_run_traces(run_id).await?;
        let before = rows.len();
        rows.retain(|r| r.ts_unix_ms >= cutoff_unix_ms);
        let removed = (before.saturating_sub(rows.len())) as u64;
        write_ndjson_lines(&self.trace_path(run_id), &rows).await?;
        Ok(removed)
    }

    async fn put_session_index(&self, session_id: &str, run_id: &str) -> Result<(), WorkflowError> {
        write_json_atomic(&self.session_path(session_id), &run_id).await
    }

    async fn run_id_for_session(&self, session_id: &str) -> Result<Option<String>, WorkflowError> {
        read_json_opt::<String>(&self.session_path(session_id)).await
    }

    async fn delete_session_index(&self, session_id: &str) -> Result<(), WorkflowError> {
        remove_if_exists(&self.session_path(session_id)).await
    }

    async fn put_idempotency_key(
        &self,
        key: &str,
        run_id: &str,
        ttl_ms: Option<u64>,
    ) -> Result<(), WorkflowError> {
        let effective_ttl = ttl_ms.unwrap_or(self.idempotency_ttl_ms);
        let expires_at_ms = if effective_ttl == 0 {
            None
        } else {
            Some(now_ms().saturating_add(effective_ttl as i64))
        };
        let entry = IdempotencyEntry {
            run_id: run_id.to_string(),
            expires_at_ms,
        };
        write_json_atomic(&self.idem_path(key), &entry).await
    }

    async fn run_id_for_idempotency_key(&self, key: &str) -> Result<Option<String>, WorkflowError> {
        let path = self.idem_path(key);
        let Some(entry) = read_json_opt::<IdempotencyEntry>(&path).await? else {
            return Ok(None);
        };

        if let Some(expires_at_ms) = entry.expires_at_ms {
            if now_ms() > expires_at_ms {
                remove_if_exists(&path).await?;
                return Ok(None);
            }
        }

        Ok(Some(entry.run_id))
    }

    async fn put_queue_receipt(&self, receipt: &QueueReceiptRecord) -> Result<(), WorkflowError> {
        let mut run = self
            .get_run(&receipt.run_id)
            .await?
            .ok_or_else(|| WorkflowError::State(format!("put_queue_receipt: run not found: {}", receipt.run_id)))?;

        if let Some(existing) = run.queue_receipts.iter_mut().find(|r| r.id == receipt.id) {
            *existing = receipt.clone();
        } else {
            run.queue_receipts.push(receipt.clone());
        }
        run.updated_at = now_ms();
        self.put_run(&run, None).await
    }

    async fn list_queue_receipts(&self, run_id: &str) -> Result<Vec<QueueReceiptRecord>, WorkflowError> {
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

fn is_json_file(path: &Path) -> bool {
    path.extension().and_then(|v| v.to_str()) == Some("json")
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

async fn ensure_parent_dir(path: &Path) -> Result<(), WorkflowError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).await.map_err(|err| {
        WorkflowError::State(format!("create_dir_all failed for {}: {}", parent.display(), err))
    })
}

async fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), WorkflowError> {
    ensure_parent_dir(path).await?;
    let tmp = path.with_extension("tmp");
    let bytes = serde_json::to_vec(value).map_err(WorkflowError::Serde)?;
    fs::write(&tmp, bytes).await.map_err(|err| {
        WorkflowError::State(format!("write failed for {}: {}", tmp.display(), err))
    })?;
    fs::rename(&tmp, path).await.map_err(|err| {
        WorkflowError::State(format!(
            "rename failed {} -> {}: {}",
            tmp.display(),
            path.display(),
            err
        ))
    })
}

async fn read_json_opt<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, WorkflowError> {
    let bytes = match fs::read(path).await {
        Ok(v) => v,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(WorkflowError::State(format!(
                "read failed for {}: {}",
                path.display(),
                err
            )));
        }
    };

    let parsed = serde_json::from_slice::<T>(&bytes).map_err(WorkflowError::Serde)?;
    Ok(Some(parsed))
}

async fn remove_if_exists(path: &Path) -> Result<(), WorkflowError> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(WorkflowError::State(format!(
            "remove_file failed for {}: {}",
            path.display(),
            err
        ))),
    }
}

async fn append_ndjson_line<T: Serialize>(path: &Path, value: &T) -> Result<(), WorkflowError> {
    ensure_parent_dir(path).await?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|err| WorkflowError::State(format!("open append failed for {}: {}", path.display(), err)))?;

    let mut bytes = serde_json::to_vec(value).map_err(WorkflowError::Serde)?;
    bytes.push(b'\n');
    file.write_all(&bytes).await.map_err(|err| {
        WorkflowError::State(format!("append write failed for {}: {}", path.display(), err))
    })
}

async fn read_ndjson_lines<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, WorkflowError> {
    let raw = match fs::read_to_string(path).await {
        Ok(v) => v,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(WorkflowError::State(format!(
                "read_to_string failed for {}: {}",
                path.display(),
                err
            )));
        }
    };

    let mut out = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        out.push(serde_json::from_str::<T>(line).map_err(WorkflowError::Serde)?);
    }
    Ok(out)
}

async fn write_ndjson_lines<T: Serialize>(path: &Path, items: &[T]) -> Result<(), WorkflowError> {
    ensure_parent_dir(path).await?;

    if items.is_empty() {
        return remove_if_exists(path).await;
    }

    let tmp = path.with_extension("tmp");
    let mut file = fs::File::create(&tmp)
        .await
        .map_err(|err| WorkflowError::State(format!("create failed for {}: {}", tmp.display(), err)))?;

    for item in items {
        let mut bytes = serde_json::to_vec(item).map_err(WorkflowError::Serde)?;
        bytes.push(b'\n');
        file.write_all(&bytes).await.map_err(|err| {
            WorkflowError::State(format!("write failed for {}: {}", tmp.display(), err))
        })?;
    }

    file.flush().await.map_err(|err| {
        WorkflowError::State(format!("flush failed for {}: {}", tmp.display(), err))
    })?;

    fs::rename(&tmp, path).await.map_err(|err| {
        WorkflowError::State(format!(
            "rename failed {} -> {}: {}",
            tmp.display(),
            path.display(),
            err
        ))
    })
}
