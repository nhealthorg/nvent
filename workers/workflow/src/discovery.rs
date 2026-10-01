use iii_sdk::{
    protocol::RegisterTriggerInput, protocol::TriggerRequest, IIIClient, RegisterFunction,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Notify, RwLock};

const REQUIRED_FUNCTIONS: &[&str] = &[
    "nworkflow::start",
    "nworkflow::tick",
    "nworkflow::node-completed",
    "nworkflow::sweep",
];

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct FunctionsAvailable {
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub functions: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct FunctionsListResponse {
    #[serde(default)]
    functions: Vec<Value>,
}

struct DiscoveryInner {
    functions: RwLock<HashSet<String>>,
    stale: AtomicBool,
    ready: AtomicBool,
    changed: Notify,
    refresh_lock: Mutex<()>,
}

#[derive(Clone)]
pub struct DiscoveryRegistry(Arc<DiscoveryInner>);

impl DiscoveryRegistry {
    fn new() -> Self {
        Self(Arc::new(DiscoveryInner {
            functions: RwLock::new(HashSet::new()),
            stale: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            changed: Notify::new(),
            refresh_lock: Mutex::new(()),
        }))
    }

    pub async fn mark_stale(&self) {
        self.0.ready.store(false, Ordering::SeqCst);
        self.0.stale.store(true, Ordering::SeqCst);
        self.0.changed.notify_waiters();
    }

    pub async fn mark_ready(&self) {
        self.0.stale.store(false, Ordering::SeqCst);
        self.0.ready.store(true, Ordering::SeqCst);
        self.0.changed.notify_waiters();
    }

    pub async fn is_ready(&self) -> bool {
        self.0.ready.load(Ordering::SeqCst) && !self.0.stale.load(Ordering::SeqCst)
    }

    pub async fn wait_until_ready(&self, timeout: Duration) -> bool {
        if self.is_ready().await {
            return true;
        }
        tokio::time::timeout(timeout, async {
            loop {
                self.0.changed.notified().await;
                if self.is_ready().await {
                    return;
                }
            }
        })
        .await
        .is_ok()
    }

    async fn replace_functions(&self, functions: HashSet<String>) {
        *self.0.functions.write().await = functions;
    }

    pub async fn has_required_functions(&self) -> bool {
        let functions = self.0.functions.read().await;
        REQUIRED_FUNCTIONS.iter().all(|id| functions.contains(*id))
    }

    async fn refresh_guard(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.0.refresh_lock.lock().await
    }
}

pub async fn init(iii: &Arc<IIIClient>) -> DiscoveryRegistry {
    let registry = DiscoveryRegistry::new();

    // Initial fetch
    if let Err(e) = refresh_registry(iii, &registry).await {
        tracing::warn!(error = %e, "initial function discovery failed");
    }

    let r = registry.clone();
    let client = iii.clone();
    iii.register_function(
        "discovery::on-functions",
        RegisterFunction::new_async(move |input: FunctionsAvailable| {
            let r = r.clone();
            let client = client.clone();
            async move {
                r.mark_stale().await;
                tracing::info!(event = ?input.event, "function discovery invalidated");
                tokio::spawn(async move {
                    for attempt in 1..=8u32 {
                        match refresh_registry(&client, &r).await {
                            Ok(()) if r.has_required_functions().await => {
                                r.mark_ready().await;
                                recover_runs(&client).await;
                                tracing::info!(attempt, "function discovery recovered after engine change");
                                return;
                            }
                            Ok(()) => tracing::debug!(attempt, "workflow functions are still incomplete after discovery refresh"),
                            Err(error) => tracing::warn!(attempt, error = %error, "function discovery refresh failed after engine change"),
                        }
                        tokio::time::sleep(Duration::from_millis((150u64 << (attempt - 1)).min(2_000))).await;
                    }
                    tracing::warn!("function discovery remained stale after engine change");
                });
                Ok::<_, iii_sdk::errors::Error>(())
            }
        }),
    );

    if let Err(e) = iii.register_trigger(RegisterTriggerInput {
        trigger_type: "engine::functions-available".into(),
        function_id: "discovery::on-functions".into(),
        config: json!({}),
        metadata: None,
        namespace: None,
        trigger_namespace: None,
    }) {
        tracing::error!(error = %e, "failed to register functions-available trigger");
    }

    registry
}

pub async fn refresh_registry(iii: &IIIClient, registry: &DiscoveryRegistry) -> Result<(), String> {
    let _guard = registry.refresh_guard().await;
    let resp = iii
        .trigger(TriggerRequest {
            function_id: "engine::functions::list".into(),
            payload: json!({ "include_internal": true }),
            action: None,
            timeout_ms: Some(5000),
        })
        .await
        .map_err(|e| e.to_string())?;

    let input: FunctionsListResponse = serde_json::from_value(resp).map_err(|e| e.to_string())?;

    let mut functions = HashSet::new();
    for f in &input.functions {
        if let Some(id) = extract_function_id(f) {
            functions.insert(id);
        }
    }
    let count = functions.len();
    registry.replace_functions(functions).await;
    tracing::info!(count, "function discovery registry refreshed");
    Ok(())
}

fn extract_function_id(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        let s = s.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
        return None;
    }

    let obj = v.as_object()?;
    obj.get("function_id")
        .and_then(|x| x.as_str())
        .or_else(|| obj.get("id").and_then(|x| x.as_str()))
        .or_else(|| obj.get("functionId").and_then(|x| x.as_str()))
        .map(|s| s.to_string())
}

pub async fn is_function_available(registry: &DiscoveryRegistry, function_id: &str) -> bool {
    if !registry.is_ready().await {
        return false;
    }
    let r = registry.0.functions.read().await;
    r.contains(function_id)
}

pub async fn recover_runs(iii: &IIIClient) {
    let Ok(runs) = crate::state::list_runs(iii).await else {
        tracing::warn!("reconnect recovery could not list workflow runs");
        return;
    };
    for run in runs.into_iter().filter(|run| !run.status.is_terminal()) {
        if let Err(error) =
            crate::functions::start::enqueue_tick(iii, &run.run_id, run.step + 1).await
        {
            tracing::warn!(run_id = %run.run_id, error = %error, "reconnect recovery could not enqueue tick");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn readiness_stays_closed_until_marked_ready() {
        let registry = DiscoveryRegistry::new();
        registry
            .replace_functions(
                REQUIRED_FUNCTIONS
                    .iter()
                    .map(|id| (*id).to_string())
                    .collect(),
            )
            .await;

        assert!(registry.has_required_functions().await);
        assert!(!registry.is_ready().await);
        assert!(!is_function_available(&registry, "nworkflow::node-completed").await);

        registry.mark_ready().await;

        assert!(registry.is_ready().await);
        assert!(is_function_available(&registry, "nworkflow::node-completed").await);
    }

    #[tokio::test]
    async fn stale_transition_closes_gate_and_wait_can_time_out() {
        let registry = DiscoveryRegistry::new();
        registry.mark_ready().await;
        assert!(registry.is_ready().await);

        registry.mark_stale().await;

        assert!(!registry.is_ready().await);
        assert!(!registry.wait_until_ready(Duration::from_millis(5)).await);
    }
}
