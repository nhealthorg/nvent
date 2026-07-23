use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::RwLock;
use serde::Deserialize;
use schemars::JsonSchema;
use iii_sdk::{IIIClient, RegisterFunction, protocol::RegisterTriggerInput, protocol::TriggerRequest};
use serde_json::{json, Value};

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

pub type DiscoveryRegistry = Arc<RwLock<HashSet<String>>>;

pub async fn init(iii: &Arc<IIIClient>) -> DiscoveryRegistry {
    let registry = Arc::new(RwLock::new(HashSet::new()));
    
    // Initial fetch
    if let Err(e) = refresh_registry(iii, &registry).await {
        tracing::warn!(error = %e, "initial function discovery failed");
    }

    let r = registry.clone();
    iii.register_function(
        "discovery::on-functions",
        RegisterFunction::new_async(move |input: FunctionsAvailable| {
            let r = r.clone();
            async move {
                let mut w = r.write().await;
                w.clear();
                for f in &input.functions {
                    if let Some(id) = extract_function_id(f) {
                        w.insert(id);
                    }
                }
                tracing::info!(
                    count = w.len(),
                    event = ?input.event,
                    "function discovery registry updated"
                );
                Ok::<_, iii_sdk::errors::Error>(())
            }
        }),
    );

    if let Err(e) = iii.register_trigger(RegisterTriggerInput {
        trigger_type: "engine::functions-available".into(),
        function_id: "discovery::on-functions".into(),
        config: json!({}),
        metadata: None,
    }) {
        tracing::error!(error = %e, "failed to register functions-available trigger");
    }

    registry
}

pub async fn refresh_registry(iii: &IIIClient, registry: &DiscoveryRegistry) -> Result<(), String> {
    let resp = iii.trigger(TriggerRequest {
        function_id: "engine::functions::list".into(),
        payload: json!({ "include_internal": false }),
        action: None,
        timeout_ms: Some(5000),
    }).await.map_err(|e| e.to_string())?;

    let input: FunctionsListResponse = serde_json::from_value(resp).map_err(|e| e.to_string())?;
    
    let mut w = registry.write().await;
    w.clear();
    for f in &input.functions {
        if let Some(id) = extract_function_id(f) {
            w.insert(id);
        }
    }
    tracing::info!(count = w.len(), "function discovery registry refreshed");
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
    let r = registry.read().await;
    r.contains(function_id)
}
