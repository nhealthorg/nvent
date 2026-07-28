use std::fs;
use std::path::{Path, PathBuf};

fn read_repo_file(repo_rel_path: &str) -> String {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = crate_dir
        .parent()
        .and_then(Path::parent)
        .expect("workers/workflow must live two levels below repo root");

    let path: PathBuf = repo_root.join(repo_rel_path);
    fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()))
}

#[test]
fn workflow_function_state_handlers_do_not_mutate_workflow_run_via_state_update() {
    let state_set = read_repo_file("workers/workflow/src/functions/state_set.rs");
    let state_delete = read_repo_file("workers/workflow/src/functions/state_delete.rs");

    for (name, content) in [("state_set.rs", state_set), ("state_delete.rs", state_delete)] {
        assert!(
            !content.contains("state::state_update("),
            "{name} must not write registry via iii state::update on workflow_run"
        );
        assert!(
            !content.contains("state::SCOPE_RUN"),
            "{name} must not target workflow_run for state_keys_map maintenance"
        );
        assert!(
            content.contains("set_state_registry_key_presence("),
            "{name} must update state_keys_map via internal state helper"
        );
    }
}

#[test]
fn workflow_wrappers_write_node_results_via_internal_worker_function() {
    let node_wrapper =
        read_repo_file("packages/nvent/src/runtime/nitro/utils/workers/node.ts");
    let py_wrapper = read_repo_file("packages/nvent/src/runtime/python/worker_runtime.py");

    for (name, content) in [
        ("node.ts", node_wrapper),
        ("worker_runtime.py", py_wrapper),
    ] {
        assert!(
            content.contains("workflow::node-result-write"),
            "{name} must call workflow::node-result-write for workflow node results"
        );
        assert!(
            !content.contains("workflow_node_result"),
            "{name} must not use legacy workflow_node_result scope"
        );
    }
}

#[test]
fn worker_state_module_has_no_legacy_node_result_scope_fallback() {
    let state_rs = read_repo_file("workers/workflow/src/state.rs");

    assert!(
        !state_rs.contains("LEGACY_SCOPE_NODE_RESULT"),
        "state.rs must not define a legacy node-result scope fallback"
    );
    assert!(
        !state_rs.contains("workflow_node_result"),
        "state.rs must not read/write legacy workflow_node_result scope"
    );
}

#[test]
fn run_records_store_input_by_ref_only() {
    let types_rs = read_repo_file("workers/workflow/src/types.rs");

    assert!(
        types_rs.contains("pub input_ref: String"),
        "WorkflowRunRecord must store only input_ref"
    );
    assert!(
        !types_rs.contains("pub input: Value"),
        "WorkflowRunRecord must not embed run input payload"
    );
}

#[test]
fn start_and_cleanup_use_dedicated_run_input_store() {
    let start_rs = read_repo_file("workers/workflow/src/functions/start.rs");
    let state_rs = read_repo_file("workers/workflow/src/state.rs");

    assert!(
        start_rs.contains("state::put_run_input("),
        "start must persist run input in dedicated internal store"
    );
    assert!(
        start_rs.contains("input_ref"),
        "start must store input_ref in WorkflowRunRecord"
    );
    assert!(
        state_rs.contains("delete_run_input(iii, &record.run_id).await?"),
        "delete_run must cleanup dedicated run input blob"
    );
}

#[test]
fn run_records_store_run_output_by_ref_only() {
    let types_rs = read_repo_file("workers/workflow/src/types.rs");

    assert!(
        types_rs.contains("pub result_ref: Option<String>"),
        "WorkflowRunRecord must store terminal output as result_ref"
    );
    assert!(
        !types_rs.contains("pub result: Option<Value>"),
        "WorkflowRunRecord must not embed run output payload"
    );
}

#[test]
fn tick_status_and_cleanup_use_dedicated_run_result_store() {
    let tick_rs = read_repo_file("workers/workflow/src/functions/tick.rs");
    let status_rs = read_repo_file("workers/workflow/src/functions/status.rs");
    let state_rs = read_repo_file("workers/workflow/src/state.rs");
    let mod_rs = read_repo_file("workers/workflow/src/functions/mod.rs");

    assert!(
        tick_rs.contains("state::put_run_result("),
        "tick finalize must persist terminal result in dedicated internal store"
    );
    assert!(
        status_rs.contains("state::get_run_result("),
        "status must resolve terminal result from dedicated internal store"
    );
    assert!(
        status_rs.contains("pub include_result: bool"),
        "status request should support lightweight polling via include_result"
    );
    assert!(
        state_rs.contains("delete_run_result(iii, &record.run_id).await?"),
        "delete_run must cleanup dedicated run result blob"
    );
    assert!(
        mod_rs.contains("workflow::run-result"),
        "workflow::run-result must be registered as dedicated run-output fetch API"
    );
}

#[test]
fn run_delete_api_is_registered_and_cleanup_covers_session_index() {
    let mod_rs = read_repo_file("workers/workflow/src/functions/mod.rs");
    let state_rs = read_repo_file("workers/workflow/src/state.rs");
    let store_trait_rs = read_repo_file("workers/workflow/src/internal_state/mod.rs");

    assert!(
        mod_rs.contains("workflow::run-delete"),
        "workflow::run-delete must be registered"
    );
    assert!(
        state_rs.contains("delete_session_index(iii, session_id).await?"),
        "state::delete_run must remove session reverse-index entries"
    );
    assert!(
        store_trait_rs.contains("async fn delete_session_index("),
        "internal state trait must support session-index deletion"
    );
}

#[test]
fn stream_cleanup_handles_key_value_map_list_shape() {
    let state_rs = read_repo_file("workers/workflow/src/state.rs");

    assert!(
        state_rs.contains("fn parse_stream_item_ids("),
        "stream cleanup should normalize stream::list responses via parse_stream_item_ids"
    );
    assert!(
        state_rs.contains("ids.extend(obj.keys().filter(|k| !k.is_empty()).cloned());"),
        "stream cleanup must use object keys as item_ids for key->value list shape"
    );
}

#[test]
fn list_runs_uses_backend_status_filtering_path() {
    let list_runs_rs = read_repo_file("workers/workflow/src/functions/list_runs.rs");
    let state_rs = read_repo_file("workers/workflow/src/state.rs");
    let store_trait_rs = read_repo_file("workers/workflow/src/internal_state/mod.rs");
    let redis_rs = read_repo_file("workers/workflow/src/internal_state/redis.rs");

    assert!(
        list_runs_rs.contains("state::list_runs_filtered(&deps.iii, status, workflow)"),
        "list-runs handler must delegate status/workflow filtering to state layer"
    );
    assert!(
        state_rs.contains("pub async fn list_runs_filtered("),
        "state facade must expose list_runs_filtered wrapper"
    );
    assert!(
        store_trait_rs.contains("async fn list_runs_filtered("),
        "internal store contract must expose list_runs_filtered"
    );
    assert!(
        redis_rs.contains("nvent:wf:runs:status:running"),
        "redis backend must maintain status index keys for direct filtering"
    );
    assert!(
        redis_rs.contains("nvent:wf:runs:workflow:tri:"),
        "redis backend must maintain workflow trigram index keys for direct filtering"
    );
}
