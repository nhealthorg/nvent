use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use tokio::task::JoinSet;

use crate::error::WorkflowError;
use crate::state::{self, SCOPE_RUN_STATE};

use super::Deps;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct StateListRequest {
    pub run_id: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct StateEntry {
    pub key: String,
    pub value: Value,
}

pub async fn handle(deps: &Deps, req: StateListRequest) -> Result<Vec<StateEntry>, WorkflowError> {
    let run = state::get_run(&deps.iii, &req.run_id).await?;
    let registry_keys = run
        .map(|record| registry_keys_from_map(&record.state_keys_map))
        .unwrap_or_default();

    let mut entries = if !registry_keys.is_empty() {
        fetch_registry_entries(&deps.iii, &req.run_id, registry_keys).await?
    } else {
        fetch_scanned_entries(&deps.iii, &req.run_id).await?
    };

    entries.sort_by(|left, right| left.key.cmp(&right.key));
    entries.dedup_by(|left, right| left.key == right.key);

    if let Some(limit) = req.limit {
        entries.truncate(limit);
    }

    Ok(entries)
}

async fn fetch_registry_entries(
    iii: &iii_sdk::IIIClient,
    run_id: &str,
    keys: Vec<String>,
) -> Result<Vec<StateEntry>, WorkflowError> {
    const MAX_PARALLEL_FETCHES: usize = 64;
    let mut tasks = JoinSet::new();
    let mut keys_iter = keys.into_iter();

    for _ in 0..MAX_PARALLEL_FETCHES {
        let Some(key) = keys_iter.next() else {
            break;
        };
        spawn_registry_fetch_task(&mut tasks, iii, run_id, key);
    }

    let mut entries = Vec::new();
    while let Some(result) = tasks.join_next().await {
        if let Some(entry) = result.map_err(|error| WorkflowError::State(format!("state::list task failed: {error}")))?? {
            entries.push(entry);
        }

        if let Some(next_key) = keys_iter.next() {
            spawn_registry_fetch_task(&mut tasks, iii, run_id, next_key);
        }
    }

    Ok(entries)
}

fn spawn_registry_fetch_task(
    tasks: &mut JoinSet<Result<Option<StateEntry>, WorkflowError>>,
    iii: &iii_sdk::IIIClient,
    run_id: &str,
    key: String,
) {
    let iii = iii.clone();
    let run_id = run_id.to_string();
    tasks.spawn(async move {
        let state_key = state::run_scoped_key(&run_id, &key);
        let value = state::state_get(&iii, SCOPE_RUN_STATE, &state_key).await?;

        Ok::<_, WorkflowError>(if value.is_null() {
            None
        } else {
            Some(StateEntry { key, value })
        })
    });
}

async fn fetch_scanned_entries(
    iii: &iii_sdk::IIIClient,
    run_id: &str,
) -> Result<Vec<StateEntry>, WorkflowError> {
    let list = state::state_list(iii, SCOPE_RUN_STATE).await?;
    Ok(collect_scanned_entries(&list, run_id))
}

fn collect_scanned_entries(list: &Value, run_id: &str) -> Vec<StateEntry> {
    let underscore_prefix = state::run_scoped_prefix(run_id);
    let mut entries = Vec::new();

    if let Some(map) = list.as_object() {
        for (raw_key, raw_value) in map {
            let stripped = raw_key.strip_prefix(&underscore_prefix);
            if let Some(stripped) = stripped {
                entries.push(StateEntry {
                    key: stripped.to_string(),
                    value: raw_value.clone(),
                });
            }
        }
    }

    for item in state::parse_state_list_values(list) {
        let key = item.get("key").and_then(|v| v.as_str()).unwrap_or("");
        let value = item.get("value").cloned().unwrap_or_else(|| item.clone());
        let stripped = key.strip_prefix(&underscore_prefix);
        if let Some(stripped) = stripped {
            entries.push(StateEntry {
                key: stripped.to_string(),
                value,
            });
        }
    }

    entries
}

fn registry_keys_from_map(map: &std::collections::BTreeMap<String, bool>) -> Vec<String> {
    let mut keys = BTreeSet::new();
    for (encoded_key, present) in map {
        if *present {
            if let Some(decoded_key) = state::decode_state_registry_key(encoded_key) {
                keys.insert(decoded_key);
            }
        }
    }
    keys.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use serde_json::json;

    #[test]
    fn collect_scanned_entries_strips_run_prefix() {
        let list = json!({
            "r_1_count": 3,
            "r_1_result": {"ok": true},
            "other:ignored": 99
        });

        let entries = collect_scanned_entries(&list, "r_1");

        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| entry.key == "count" && entry.value == json!(3)));
        assert!(entries.iter().any(|entry| entry.key == "result" && entry.value == json!({"ok": true})));
    }

    #[test]
    fn registry_keys_from_map_decodes_and_filters() {
        let mut map = BTreeMap::new();
        map.insert(
            format!(
                "{}{}",
                state::STATE_REGISTRY_KEY_PREFIX,
                state::encode_state_registry_key("count")
            ),
            true,
        );
        map.insert(
            format!(
                "{}{}",
                state::STATE_REGISTRY_KEY_PREFIX,
                state::encode_state_registry_key("result.value")
            ),
            true,
        );
        map.insert(
            format!(
                "{}{}",
                state::STATE_REGISTRY_KEY_PREFIX,
                state::encode_state_registry_key("ignored")
            ),
            false,
        );
        map.insert("zz-not-hex".to_string(), true);

        let keys = registry_keys_from_map(&map);

        assert_eq!(keys, vec!["count".to_string(), "result.value".to_string()]);
    }

    #[test]
    fn registry_keys_from_map_ignores_false_and_invalid_entries() {
        let mut map = BTreeMap::new();
        map.insert(
            format!(
                "{}{}",
                state::STATE_REGISTRY_KEY_PREFIX,
                state::encode_state_registry_key("keep")
            ),
            true,
        );
        map.insert(
            format!(
                "{}{}",
                state::STATE_REGISTRY_KEY_PREFIX,
                state::encode_state_registry_key("drop")
            ),
            false,
        );
        map.insert("k_not_hex".to_string(), true);

        let keys = registry_keys_from_map(&map);
        assert_eq!(keys, vec!["keep".to_string()]);
    }
}
