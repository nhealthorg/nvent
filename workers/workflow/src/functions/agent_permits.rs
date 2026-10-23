use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::WorkflowError;
use crate::functions::{agent, stop, Deps};
use crate::internal_state::AgentPermit;
use crate::state::WorkflowRunLogRecord;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListRequest {}

#[derive(Debug, Serialize, JsonSchema)]
pub struct Group {
    key: String,
    limit: u64,
    active: u64,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ListResponse {
    permits: Vec<AgentPermit>,
    groups: Vec<Group>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Check,
    Stop,
    ForceRelease,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ManageRequest {
    pub owner: String,
    pub action: Action,
    pub reason: Option<String>,
    pub confirmation: Option<String>,
    pub actor: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Released,
    Retained,
    NotFound,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ManageResponse {
    owner: String,
    outcome: Outcome,
    message: String,
}

pub async fn list(deps: &Deps, _req: ListRequest) -> Result<ListResponse, WorkflowError> {
    let mut permits = deps.internal_state.list_agent_permits().await?;
    permits.sort_by(|left, right| left.owner.cmp(&right.owner));
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for permit in &permits {
        let group = groups.entry(permit.key.clone()).or_insert_with(|| Group {
            key: permit.key.clone(), limit: permit.limit, active: 0,
        });
        group.limit = group.limit.min(permit.limit);
        group.active += 1;
    }
    Ok(ListResponse { permits, groups: groups.into_values().collect() })
}

async fn audit(
    deps: &Deps,
    permit: &AgentPermit,
    req: &ManageRequest,
    operation_id: &str,
    outcome: &str,
) -> Result<(), WorkflowError> {
    let actor = req.actor.as_deref().map(str::trim).filter(|actor| !actor.is_empty())
        .unwrap_or("operator");
    let entry = WorkflowRunLogRecord {
        id: crate::ids::new_trace_id(), run_id: permit.run_id.clone(),
        node_uid: None, function_id: Some("nworkflow::agent-permits-manage".into()),
        runtime: Some("workflow".into()), level: "warn".into(),
        message: "Agent permit force release audit".into(), ts_unix_ms: deps.now_ms(),
        data: Some(json!({"operation_id": operation_id, "owner": permit.owner,
            "action": "force_release", "actor": actor, "reason": req.reason,
            "outcome": outcome})),
    };
    deps.internal_state.put_run_log(&permit.run_id, &entry).await?;
    tracing::warn!(owner = %permit.owner, operation_id, actor, outcome,
        "agent permit force release audit persisted");
    Ok(())
}

pub async fn manage(deps: &Deps, req: ManageRequest) -> Result<ManageResponse, WorkflowError> {
    if req.owner.trim().is_empty() {
        return Err(WorkflowError::InvalidDef("owner must not be empty".into()));
    }
    if matches!(req.action, Action::ForceRelease) && (req.confirmation.as_deref() != Some(&req.owner)
        || req.reason.as_deref().is_none_or(|reason| reason.trim().is_empty())) {
        return Err(WorkflowError::InvalidDef(
            "force_release requires confirmation exactly equal to owner and a nonempty reason".into()));
    }
    let permit = deps.internal_state.list_agent_permits().await?.into_iter()
        .find(|permit| permit.owner == req.owner);
    let Some(permit) = permit else {
        return Ok(ManageResponse { owner: req.owner, outcome: Outcome::NotFound,
            message: "Permit not found.".into() });
    };
    let mut response = ManageResponse { owner: req.owner.clone(), outcome: Outcome::Retained,
        message: String::new() };
    match req.action {
        Action::Check => response.message = agent::check_permit(deps, &permit).await?,
        Action::Stop => {
            if stop::handle(deps, stop::StopRequest { run_id: permit.run_id.clone() }).await.is_err() {
                response.message = "Workflow stop did not finish; permit retained. Check again.".into();
                return Ok(response);
            }
            if let Some(session_id) = permit.session_id.as_deref() {
                let _ = deps.trigger_bounded(iii_sdk::protocol::TriggerRequest {
                    function_id: "harness::stop".into(), payload: json!({"session_id": session_id}),
                    action: None, timeout_ms: None,
                }, deps.cfg().await.cleanup_timeout_ms).await;
            }
            response.message = agent::check_permit(deps, &permit).await?;
        }
        Action::ForceRelease => {
            let Some(_guard) = deps.locks.guard_bounded(&permit.run_id,
                deps.cfg().await.cleanup_timeout_ms).await else {
                response.message = "Run is busy; force release refused.".into();
                return Ok(response);
            };
            if deps.internal_state.list_agent_permits().await?.into_iter()
                .find(|current| current.owner == permit.owner).as_ref() != Some(&permit) {
                response.message = "Permit changed; force release refused.".into();
                return Ok(response);
            }
            if deps.internal_state.get_run(&permit.run_id).await?
                .is_some_and(|run| !run.status.is_terminal()) {
                response.message = "Run is nonterminal; stop it before force release.".into();
                return Ok(response);
            }
            let operation_id = crate::ids::new_trace_id();
            audit(deps, &permit, &req, &operation_id, "requested").await?;
            let released = deps.internal_state.compare_and_release_agent_permit(&permit).await?;
            let outcome = if released { "released" } else { "retained" };
            if let Err(error) = audit(deps, &permit, &req, &operation_id, outcome).await {
                tracing::error!(operation_id, error = %error, "force release outcome audit failed; intent remains persisted");
            }
            response.outcome = if released { Outcome::Released } else { Outcome::Retained };
            response.message = if released {
                "Force released. Harness termination is NOT proven; a surviving remote session can exceed capacity. Audit intent persisted."
            } else { "Permit changed before CAS; retained." }.into();
            return Ok(response);
        }
    }
    if !deps.internal_state.list_agent_permits().await?.iter().any(|current| current.owner == permit.owner) {
        response.outcome = Outcome::Released;
    }
    Ok(response)
}