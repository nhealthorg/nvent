use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{config::WorkerConfig, error::WorkflowError};

use super::Deps;

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct ConfigRequest {}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ConfigResponse {
    pub config: WorkerConfig,
}

pub async fn handle(deps: &Deps, _req: ConfigRequest) -> Result<ConfigResponse, WorkflowError> {
    let cfg = deps.cfg().await;
    Ok(ConfigResponse {
        config: (*cfg).clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_response_serializes() {
        let resp = ConfigResponse {
            config: WorkerConfig::default(),
        };
        let value = serde_json::to_value(resp).expect("serialize config response");
        assert!(value.get("config").is_some());
    }
}
