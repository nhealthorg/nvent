use iii_sdk::errors::Error;
use iii_sdk::{IIIClient, RegisterFunction};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::config::WorkerConfig;
use crate::locks::WorkflowLocks;

pub mod node_completed;
pub mod node_result;
pub mod start;
pub mod status;
pub mod stop;
pub mod sweep;
pub mod tick;
pub mod log_write;
pub mod log_read;
pub mod log_delete;
pub mod trace_write;
pub mod trace_read;
pub mod trace_delete;
pub mod state_set;
pub mod state_get;
pub mod state_delete;
pub mod state_list;
pub mod stream_publish;
pub mod stream_list;
pub mod list_runs;
pub mod config_get;

pub type ConfigCell = Arc<tokio::sync::RwLock<Arc<WorkerConfig>>>;

#[derive(Clone)]
pub struct Deps {
    pub iii: Arc<IIIClient>,
    pub cfg: ConfigCell,
    pub locks: WorkflowLocks,
}

impl Deps {
    pub async fn cfg(&self) -> Arc<WorkerConfig> {
        self.cfg.read().await.clone()
    }

    pub fn now_ms(&self) -> i64 {
        crate::ids::now_ms()
    }
}

// ---------------------------------------------------------------------------
// TickRequest / TickResponse (shared between mod.rs registration and tick.rs)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct TickRequest {
    pub run_id: String,
    #[serde(default)]
    pub step: u64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TickResponse {
    pub skipped: bool,
}

// ---------------------------------------------------------------------------
// register_all
// ---------------------------------------------------------------------------

pub fn register_all(iii: &Arc<IIIClient>, deps: &Deps) {
    let d = deps.clone();
    iii.register_function(
        "workflow::start",
        RegisterFunction::new_async(move |req: start::StartRequest| {
            let d = d.clone();
            async move { start::handle(&d, req).await.map_err(Error::from) }
        })
        .description(
            "Launch a declarative multi-agent DAG (fan-out + barrier/join, durable & \
             crash-resumable) and return its run_id immediately. Use this to ORCHESTRATE \
             MULTIPLE distinct agents whose pipeline you can draw up front. Do NOT use it for \
             work you can finish in the current turn: if you already hold the inputs you need \
             (e.g. you were handed results to synthesize), produce the answer DIRECTLY — never \
             wrap a single reasoning step in a one-node workflow. For a genuine pipeline it runs \
             for as long as it needs without blocking the caller. PREFER `notify` (a function_id \
             pushed {run_id, status, result, result_error} once the run is terminal) over polling: \
             each workflow::status call costs one of your turns and a poll loop can exhaust your \
             turn budget. Use workflow::status only for the occasional check, not a tight loop. \
             Request shape: \
             `{\"definition\":{\"version\":1,\"nodes\":{\"<id>\":{\"agent\":{\"model\":\"<id from \
             router::models::list>\"},\"input\":{\"from\":\"run_input\"}}},\"output\":{\"from\":\"node:<id>\"}},\
             \"notify\":{\"function_id\":\"...\"},\"reply_to\":{}}` — `nodes` is an OBJECT \
             keyed by node id (NOT an array); each node is `{agent, input, depends_on?, fanout?}`. To get \
             the result: set `reply_to:{}` (or notify) \
             and then END YOUR TURN — do NOT claim a result was delivered or produce one this turn, it \
             arrives as a separate message when the run finishes. Never poll workflow::status in a loop. \
             Full field docs are inline in this function's request schema.",
        ),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::log-write",
        RegisterFunction::new_async(move |req: log_write::LogWriteRequest| {
            let d = d.clone();
            async move { log_write::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Write a workflow-scoped log entry into workflow worker storage."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::log-read",
        RegisterFunction::new_async(move |req: log_read::LogReadRequest| {
            let d = d.clone();
            async move { log_read::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Read workflow-scoped log entries by run_id with optional filters."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::log-delete",
        RegisterFunction::new_async(move |req: log_delete::LogDeleteRequest| {
            let d = d.clone();
            async move { log_delete::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Delete one or all workflow-scoped log entries for a run."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::trace-write",
        RegisterFunction::new_async(move |req: trace_write::TraceWriteRequest| {
            let d = d.clone();
            async move { trace_write::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Write a workflow-scoped trace event into workflow worker storage."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::trace-read",
        RegisterFunction::new_async(move |req: trace_read::TraceReadRequest| {
            let d = d.clone();
            async move { trace_read::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Read workflow-scoped trace events by run_id with optional filters."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::trace-delete",
        RegisterFunction::new_async(move |req: trace_delete::TraceDeleteRequest| {
            let d = d.clone();
            async move { trace_delete::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Delete one or all workflow-scoped trace events for a run."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::state-set",
        RegisterFunction::new_async(move |req: state_set::StateSetRequest| {
            let d = d.clone();
            async move { state_set::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Set a workflow-scoped state value and update the run registry."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::state-get",
        RegisterFunction::new_async(move |req: state_get::StateGetRequest| {
            let d = d.clone();
            async move { state_get::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Get a workflow-scoped state value."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::state-delete",
        RegisterFunction::new_async(move |req: state_delete::StateDeleteRequest| {
            let d = d.clone();
            async move { state_delete::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Delete a workflow-scoped state value and remove it from the run registry."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::state-list",
        RegisterFunction::new_async(move |req: state_list::StateListRequest| {
            let d = d.clone();
            async move { state_list::handle(&d, req).await.map_err(Error::from) }
        })
        .description("List all workflow-scoped state keys and values for a run via registry."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::stream-publish",
        RegisterFunction::new_async(move |req: stream_publish::StreamPublishRequest| {
            let d = d.clone();
            async move { stream_publish::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Publish data to a workflow-scoped stream and update the run registry."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::stream-list",
        RegisterFunction::new_async(move |req: stream_list::StreamListRequest| {
            let d = d.clone();
            async move { stream_list::handle(&d, req).await.map_err(Error::from) }
        })
        .description("List all known stream IDs for a run via registry."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::config",
        RegisterFunction::new_async(move |req: config_get::ConfigRequest| {
            let d = d.clone();
            async move { config_get::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Return the effective workflow worker configuration."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::tick",
        RegisterFunction::new_async(move |req: TickRequest| {
            let d = d.clone();
            async move { tick::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Internal durable workflow step."),
    );
    let d = deps.clone();
    iii.register_function(
        "workflow::status",
        RegisterFunction::new_async(move |req: status::StatusRequest| {
            let d = d.clone();
            async move { status::handle(&d, req).await.map_err(Error::from) }
        })
        .description(
            "Return the current status of a workflow run (state per node, plus node_errors / \
             node_results / result / result_error), or null if not found. A single check is \
             cheap, but each call costs one of your turns — do NOT poll in a loop waiting for a \
             long run to finish, that exhausts your turn budget. To be pushed the outcome when \
             the run reaches a terminal state, pass `notify` to workflow::start instead.",
        ),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::list-runs",
        RegisterFunction::new_async(move |req: list_runs::ListRunsRequest| {
            let d = d.clone();
            async move { list_runs::handle(&d, req).await.map_err(Error::from) }
        })
        .description("List and filter workflow runs with pagination."),
    );

    let d = deps.clone();
    iii.register_function(
        "workflow::node-result",
        RegisterFunction::new_async(move |req: node_result::NodeResultRequest| {
            let d = d.clone();
            async move { node_result::handle(&d, req).await.map_err(Error::from) }
        })
        .description(
            "Fetch the stored JSON result of a single node by its uid — the `node_uid` arg \
             (alias `uid`): a node_id, or '{node_id}#{i}' for a fanned-out item. Use it to \
             recover partial outputs after a run fails partway: workflow::status lists the uids \
             that have a result under `node_results`. Returns {result: null} if the node has not \
             completed or has no stored result.",
        ),
    );
    let d = deps.clone();
    iii.register_function(
        "workflow::stop",
        RegisterFunction::new_async(move |req: stop::StopRequest| {
            let d = d.clone();
            async move { stop::handle(&d, req).await.map_err(Error::from) }
        })
        .description("Cooperatively cancel a workflow run and cascade harness::stop to each live node session."),
    );
    let d = deps.clone();
    iii.register_function(
        sweep::SWEEP_ID,
        RegisterFunction::new_async(move |req: sweep::SweepEvent| {
            let d = d.clone();
            async move { sweep::handle(&d, req).await.map_err(Error::from) }
        })
        .description(sweep::SWEEP_DESC),
    );
    let d = deps.clone();
    iii.register_function(
        node_completed::NODE_COMPLETED_ID,
        RegisterFunction::new_async(move |event: node_completed::NodeCompletedEvent| {
            let d = d.clone();
            async move { node_completed::handle(&d, event).await.map_err(Error::from) }
        })
        .description(node_completed::NODE_COMPLETED_DESC),
    );
}
