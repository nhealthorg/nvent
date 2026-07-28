//! `workflow` binary entry.
//!
//! Boot sequence:
//!   1. Init tracing.
//!   2. Parse CLI. `--manifest` short-circuits to print manifest and exit.
//!   3. Connect to the local iii engine.
//!   4. Register config schema (seed = None for MVP) and fetch authoritative value.
//!   5. Build ConfigCell + Deps.
//!   6. Register all functions.
//!   7. Bind the cron sweep trigger (retain handle for hot-reload).
//!   8. Set up the harness hooks: react to `engine::workers-available` and bind the
//!      turn-completed / pre-trigger / pre-generate hooks once the harness is up (no poll).
//!   9. Resume-scan: re-enqueue a tick for every non-terminal run (crash recovery).
//!  10. LAST: bind the configuration-change trigger so its handler closes over
//!      the fully-built snapshot cell + the cron handle.
//!  11. Sleep on Ctrl+C, then `shutdown_async` cleanly.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use iii_helpers::observability::OtelConfig;
use iii_sdk::runtime::WorkerMetadata;
use iii_sdk::{register_worker, InitOptions, IIIClient};
use serde_json::Value;
use tokio::sync::RwLock;

use workflow::configuration::{self, TriggerHandles};
use workflow::functions::{self, ConfigCell};
use workflow::locks::WorkflowLocks;
use workflow::{manifest, state};

fn apply_boot_config_override(
    base: workflow::config::WorkerConfig,
    raw_override: Option<&str>,
) -> Result<workflow::config::WorkerConfig> {
    let Some(raw_override) = raw_override else {
        return Ok(base);
    };

    let override_value: Value = serde_json::from_str(raw_override)
        .with_context(|| "parsing --config as JSON object")?;
    let override_obj = override_value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("--config must be a JSON object"))?;

    let mut merged = base.to_json();
    let merged_obj = merged
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("internal error: WorkerConfig JSON is not an object"))?;

    for (k, v) in override_obj {
        merged_obj.insert(k.clone(), v.clone());
    }

    workflow::config::WorkerConfig::from_json(&merged)
        .map_err(anyhow::Error::msg)
        .with_context(|| "applying --config override onto fetched worker config")
}

#[derive(Parser, Debug)]
#[command(
    name = "workflow",
    about = "Durable workflow orchestrator: fan-out, barrier, and sequential DAG execution."
)]
struct Cli {
    /// Optional seed config for the first registration only.
    #[arg(long)]
    config: Option<String>,

    #[arg(long, default_value = "ws://127.0.0.1:49134")]
    url: String,

    #[arg(long)]
    manifest: bool,
}

fn is_boot_dependency_not_ready(error_text: &str) -> bool {
    // state/queue/stream workers can register a bit later than this worker during
    // engine startup. Treat missing function/provider as transient at boot.
    error_text.contains("function_not_found")
        || error_text.contains("Function not found")
        || error_text.contains("no provider registered")
}

async fn boot_resume_scan_with_retry(
    iii: &IIIClient,
    attempts: u32,
    initial_delay_ms: u64,
) -> Result<(), workflow::error::WorkflowError> {
    let mut delay_ms = initial_delay_ms.max(50);

    for attempt in 1..=attempts {
        match state::list_runs(iii).await {
            Ok(runs) => {
                for r in runs.iter().filter(|r| !r.status.is_terminal()) {
                    if let Err(e) =
                        workflow::functions::start::enqueue_tick(iii, &r.run_id, r.step + 1).await
                    {
                        tracing::warn!(run_id = %r.run_id, error = %e, "resume-scan: re-enqueue failed");
                    }
                }
                return Ok(());
            }
            Err(e) => {
                if attempt < attempts && is_boot_dependency_not_ready(&e.to_string()) {
                    tracing::warn!(
                        attempt,
                        attempts,
                        error = %e,
                        delay_ms,
                        "resume-scan: dependency not ready yet; retrying"
                    );
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    delay_ms = (delay_ms.saturating_mul(2)).min(2_000);
                    continue;
                }
                return Err(e);
            }
        }
    }

    Ok(())
}

async fn boot_sweep_with_retry(
    deps: &workflow::functions::Deps,
    attempts: u32,
    initial_delay_ms: u64,
) -> Result<(), workflow::error::WorkflowError> {
    let mut delay_ms = initial_delay_ms.max(50);

    for attempt in 1..=attempts {
        match workflow::functions::sweep::handle(deps, workflow::functions::sweep::SweepEvent::default()).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                if attempt < attempts && is_boot_dependency_not_ready(&e.to_string()) {
                    tracing::warn!(
                        attempt,
                        attempts,
                        error = %e,
                        delay_ms,
                        "boot-sweep: dependency not ready yet; retrying"
                    );
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    delay_ms = (delay_ms.saturating_mul(2)).min(2_000);
                    continue;
                }
                return Err(e);
            }
        }
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    if cli.manifest {
        let m = manifest::build_manifest();
        println!("{}", serde_json::to_string_pretty(&m).unwrap());
        return Ok(());
    }

    let iii = Arc::new(register_worker(
        &cli.url,
        InitOptions {
            metadata: Some(WorkerMetadata {
                runtime: "rust".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                name: "workflow".to_string(),
                os: std::env::consts::OS.to_string(),
                pid: Some(std::process::id()),
                telemetry: None,
                ..WorkerMetadata::default()
            }),
            otel: Some(OtelConfig::default()),
            ..InitOptions::default()
        },
    ));

    configuration::register_config(&iii)
        .await
        .map_err(anyhow::Error::msg)
        .context("registering workflow configuration schema")?;
    // Don't brick boot on a transient config-worker hiccup: warn and come up
    // inert on defaults, then recover on the next config-change hot-reload (same
    // resilience stance as on_config_change keeping the previous config on a
    // fetch failure). Matches the warn-and-default convention of the other
    // worker binaries in this repo.
    let fetched_cfg = match configuration::fetch_config(&iii).await {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::warn!(error = %e, "loading workflow configuration failed; using defaults");
            workflow::config::WorkerConfig::default()
        }
    };

    let cfg = apply_boot_config_override(fetched_cfg, cli.config.as_deref())?;

    // Wire the state-layer RPC timeout from the authoritative config at boot
    // (kept in sync afterwards by configuration::apply_config on hot-reload).
    state::set_dispatch_timeout_ms(cfg.dispatch_timeout_ms);

    let internal_state = workflow::internal_state::build_store(&cfg)
        .map_err(anyhow::Error::msg)
        .context("building internal workflow state store")?;
    state::set_internal_state_store(internal_state.clone());

    let discovery = workflow::discovery::init(&iii).await;

    let cell: ConfigCell = Arc::new(RwLock::new(Arc::new(cfg.clone())));
    let deps = functions::Deps {
        iii: iii.clone(),
        cfg: cell.clone(),
        locks: WorkflowLocks::default(),
        discovery,
        internal_state,
    };

    functions::register_all(&iii, &deps);

    // Bind the cron sweep; retain the handle so a sweep_expression change
    // re-binds it live.
    let handles = Arc::new(TriggerHandles {
        sweep: std::sync::Mutex::new(configuration::bind_sweep(&iii, &cfg)),
    });

    // Crash recovery: a parked AwaitingNodes run has no enqueued tick.
    // Re-drive each non-terminal run so it can make progress.
    match boot_resume_scan_with_retry(&iii, 8, 150).await {
        Ok(()) => {}
        Err(e) => tracing::error!(error = %e, "resume-scan: list_runs failed"),
    }

    // Immediate one-shot sweep after resume-scan so a reboot doesn't wait for
    // the next cron minute to reconcile stale Running nodes / overdue timeouts.
    if let Err(e) = boot_sweep_with_retry(&deps, 8, 150).await {
        tracing::warn!(error = %e, "boot-sweep failed");
    }

    // LAST: bind the configuration-change trigger.
    configuration::register_config_trigger(&iii, cell, handles)
        .context("registering the configuration change trigger")?;

    tracing::info!("workflow ready");

    tokio::signal::ctrl_c().await?;
    tracing::info!("workflow shutting down");
    iii.shutdown_async().await;
    Ok(())
}
