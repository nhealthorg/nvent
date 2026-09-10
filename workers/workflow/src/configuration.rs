//! Integration with the `configuration` worker — register the schema, fetch
//! the authoritative value at boot, and hot-reload it when it changes.
//!
//! `sweep_expression` is the one STRUCTURAL field (the cron binding for the
//! node-timeout sweep). On a change the handler re-binds the trigger live
//! (register-new-then-unregister-old: a fail-safe overlap).
//!
//! Every other field is a per-call tuning knob read from the live snapshot via
//! [`Deps::cfg`](crate::functions::Deps::cfg); a change swaps the snapshot.

use std::sync::Arc;
use std::time::Duration;

use iii_sdk::errors::Error;
use iii_sdk::protocol::{RegisterTriggerInput, TriggerRequest};
use iii_sdk::trigger::Trigger;
use iii_sdk::{IIIClient, RegisterFunction};
use serde_json::{json, Value};

use crate::config::WorkerConfig;
// Reuse the ConfigCell type declared in functions::mod — do NOT redefine.
use crate::functions::ConfigCell;

pub const CONFIG_ID: &str = "nworkflow";
const CONFIG_FN_ID: &str = "nworkflow::on-config-change";
pub const SWEEP_ID: &str = "nworkflow::sweep";

const CONFIG_TIMEOUT_MS: u64 = 5_000;
const CONFIG_RETRIES: u32 = 3;
const CONFIG_RETRY_BACKOFF_MS: u64 = 250;

/// Register the `workflow` configuration schema. The built-in default is seeded
/// as `initial_value` only when nothing is stored yet (safe to call every boot).
pub async fn register_config(iii: &IIIClient) -> Result<(), String> {
    let mut payload = json!({
        "id": CONFIG_ID,
        "name": "Workflow",
        "description": "Workflow worker settings: default node-pending timeout, \
                        cron sweep schedule, RPC dispatch timeout, and max node retries.",
        "schema": WorkerConfig::json_schema(),
    });
    if should_seed_default_value(iii).await? {
        payload["initial_value"] = WorkerConfig::default().to_json();
    }
    trigger_with_retry(iii, "configuration::register", payload).await?;
    Ok(())
}

/// Read the live `workflow` configuration (env-expanded by the configuration
/// worker — `from_json` does NOT re-expand).
pub async fn fetch_config(iii: &IIIClient) -> Result<WorkerConfig, String> {
    let value = try_get_config_value(iii)
        .await?
        .ok_or_else(|| format!("configuration `{CONFIG_ID}` not found"))?;
    if value.is_null() {
        tracing::info!("no configuration value found; using built-in default configuration");
        return Ok(WorkerConfig::default());
    }
    WorkerConfig::from_json(&value)
}

async fn should_seed_default_value(iii: &IIIClient) -> Result<bool, String> {
    match try_get_config_value(iii).await? {
        None => Ok(true),
        Some(value) if value.is_null() => Ok(true),
        Some(_) => Ok(false),
    }
}

/// Returns `Ok(None)` when the entry does not exist.
async fn try_get_config_value(iii: &IIIClient) -> Result<Option<Value>, String> {
    match trigger_with_retry(iii, "configuration::get", json!({ "id": CONFIG_ID })).await {
        Ok(resp) => Ok(resp.get("value").cloned()),
        Err(e) if e.to_ascii_uppercase().contains("NOT_FOUND") => Ok(None),
        Err(e) => Err(e),
    }
}

/// Swap the config snapshot under the write lock.
pub async fn apply_config(cell: &ConfigCell, cfg: WorkerConfig) {
    // Keep the state-layer RPC timeout in sync with the live config.
    crate::state::set_dispatch_timeout_ms(cfg.dispatch_timeout_ms);
    *cell.write().await = Arc::new(cfg);
}

/// Live handle for the one hot-reloadable trigger binding — the cron sweep.
pub struct TriggerHandles {
    pub sweep: std::sync::Mutex<Option<Trigger>>,
}

/// Best-effort binding: the cron trigger type always exists (engine built-in),
/// but a transient failure must not brick boot — it surfaces as a `None` handle.
fn bind(iii: &IIIClient, trigger_type: &str, function_id: &str, config: Value) -> Option<Trigger> {
    match iii.register_trigger(RegisterTriggerInput {
        trigger_type: trigger_type.to_string(),
        function_id: function_id.to_string(),
        config,
        metadata: None,
    }) {
        Ok(handle) => {
            tracing::info!(trigger_type, function_id, "trigger binding requested");
            Some(handle)
        }
        Err(e) => {
            tracing::warn!(trigger_type, function_id, error = %e, "trigger binding failed");
            None
        }
    }
}

/// (Re)bind the cron node-timeout sweep from the current config.
pub fn bind_sweep(iii: &IIIClient, cfg: &WorkerConfig) -> Option<Trigger> {
    bind(
        iii,
        "cron",
        SWEEP_ID,
        json!({ "expression": cfg.sweep_expression }),
    )
}

/// Store the freshly-registered handle, then unregister the old one
/// (register-new-then-unregister-old: a fail-safe overlap).
fn rebind_slot(slot: &std::sync::Mutex<Option<Trigger>>, new: Option<Trigger>) {
    let Some(new) = new else {
        return;
    };
    let old = slot.lock().unwrap_or_else(|p| p.into_inner()).replace(new);
    if let Some(old) = old {
        old.unregister();
    }
}

/// Internal `nworkflow::on-config-change` trigger payload.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct OnConfigChangeEvent {
    /// Configuration id that changed (advisory; the handler re-fetches).
    #[serde(default)]
    pub id: Option<String>,
}

/// Ack returned by the internal `nworkflow::on-config-change` handler.
#[derive(Debug, serde::Serialize, schemars::JsonSchema)]
pub struct OnConfigChangeResponse {
    pub ok: bool,
}

/// Register the internal config-change handler and bind a `configuration`
/// trigger. `handles` holds the live cron `Trigger` the handler re-binds when
/// `sweep_expression` changes.
pub fn register_config_trigger(
    iii: &Arc<IIIClient>,
    cell: ConfigCell,
    handles: Arc<TriggerHandles>,
) -> Result<(), Error> {
    let cell_for_fn = cell.clone();
    let handles_for_fn = handles.clone();
    let engine = iii.clone();
    iii.register_function(
        CONFIG_FN_ID,
        RegisterFunction::new_async(move |_event: OnConfigChangeEvent| {
            let cell = cell_for_fn.clone();
            let handles = handles_for_fn.clone();
            let engine = engine.clone();
            async move {
                on_config_change(&engine, &cell, &handles).await;
                Ok::<OnConfigChangeResponse, Error>(OnConfigChangeResponse { ok: true })
            }
        })
        .description(
            "Internal: hot-reload workflow config — re-binds the cron sweep on a \
             sweep_expression change and swaps the per-call tuning snapshot otherwise.",
        ),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "configuration".to_string(),
        function_id: CONFIG_FN_ID.to_string(),
        config: json!({
            "configuration_id": CONFIG_ID,
            "event_types": ["configuration:updated"],
        }),
        metadata: None,
    })?;
    Ok(())
}

/// Reload from the AUTHORITATIVE configuration. The caller-supplied trigger
/// payload is intentionally ignored: a direct call can never inject config.
async fn on_config_change(iii: &IIIClient, cell: &ConfigCell, handles: &TriggerHandles) {
    let cfg = match fetch_config(iii).await {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::error!(error = %e, "config-change: fetch failed; keeping previous config");
            return;
        }
    };

    let old = cell.read().await.clone();
    // Re-bind the cron sweep only when a boot-relevant field changes — one baked
    // into a live trigger binding rather than hot-applied per call. Today that is
    // only the sweep schedule. Commit the new expression into the live snapshot
    // ONLY when the rebind actually succeeds; on failure keep the old expression so
    // the next config-change still sees a diff and retries — otherwise the snapshot
    // would advertise a schedule the active cron trigger isn't running.
    let mut applied = cfg;
    if old.sweep_expression != applied.sweep_expression {
        match bind_sweep(iii, &applied) {
            Some(trigger) => {
                rebind_slot(&handles.sweep, Some(trigger));
                tracing::info!("workflow sweep re-bound (sweep_expression changed)");
            }
            None => {
                applied.sweep_expression = old.sweep_expression.clone();
                tracing::error!(
                    "workflow sweep rebind failed; keeping the previous sweep binding and schedule"
                );
            }
        }
    }

    apply_config(cell, applied).await;
    tracing::info!("workflow configuration reloaded");
}

async fn trigger_with_retry(
    iii: &IIIClient,
    function_id: &str,
    payload: Value,
) -> Result<Value, String> {
    let mut last_err = String::new();
    for attempt in 1..=CONFIG_RETRIES {
        match iii
            .trigger(TriggerRequest {
                function_id: function_id.to_string(),
                payload: payload.clone(),
                action: None,
                timeout_ms: Some(CONFIG_TIMEOUT_MS),
            })
            .await
        {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e.to_string();
                if attempt < CONFIG_RETRIES {
                    tracing::warn!(function_id, attempt, error = %last_err, "configuration RPC failed; retrying");
                    tokio::time::sleep(Duration::from_millis(
                        CONFIG_RETRY_BACKOFF_MS * u64::from(attempt),
                    ))
                    .await;
                }
            }
        }
    }
    Err(format!(
        "{function_id} failed after {CONFIG_RETRIES} attempts: {last_err}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::RwLock;

    #[tokio::test]
    async fn apply_config_swaps_snapshot() {
        let cell: ConfigCell = Arc::new(RwLock::new(Arc::new(WorkerConfig::default())));
        assert_eq!(cell.read().await.default_pending_timeout_ms, 300_000);
        apply_config(
            &cell,
            WorkerConfig {
                default_pending_timeout_ms: 9999,
                ..WorkerConfig::default()
            },
        )
        .await;
        assert_eq!(cell.read().await.default_pending_timeout_ms, 9999);
    }
}
