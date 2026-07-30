use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const PROVIDER_IDS: [&str; 6] = [
    "claude",
    "codex",
    "gemini",
    "copilot",
    "openrouter",
    "antigravity",
];

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    pub autostart: bool,
    pub poll_interval_seconds: u64,
    pub alert_threshold: f64,
    pub critical_threshold: f64,
    pub enabled_providers: Vec<String>,
    pub floating_position: Option<Pos>,
    pub notification_enabled: bool,
    /// None = show every provider on the floating icon
    pub display_providers: Option<Vec<String>>,
    /// Providers already offered to existing installs; see `migrate`
    pub migrated_providers: Option<Vec<String>>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            autostart: false,
            poll_interval_seconds: 30,
            alert_threshold: 0.8,
            critical_threshold: 0.95,
            enabled_providers: PROVIDER_IDS.iter().map(|s| s.to_string()).collect(),
            floating_position: None,
            notification_enabled: true,
            display_providers: None,
            migrated_providers: None,
        }
    }
}

/// Same directory the Electron build used, so an upgrade keeps the user's
/// settings and their saved OpenRouter key.
pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("batradar")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

pub fn apikey_path() -> PathBuf {
    config_dir().join("apikey.enc")
}

pub fn openrouter_key_path() -> PathBuf {
    config_dir().join("openrouter.enc")
}

pub fn load() -> Config {
    let mut cfg: Config = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if migrate(&mut cfg) {
        save(&cfg);
    }
    cfg
}

/// Enable providers added after this config was first written, then remember
/// that we did — so a later Disconnect is not undone on the next launch.
fn migrate(cfg: &mut Config) -> bool {
    let known = ["gemini", "copilot", "openrouter", "antigravity"];
    let mut migrated = cfg.migrated_providers.clone().unwrap_or_default();
    let missing: Vec<&str> = known
        .iter()
        .filter(|p| !migrated.iter().any(|m| m == *p))
        .copied()
        .collect();
    if missing.is_empty() {
        return false;
    }
    for p in &missing {
        if !cfg.enabled_providers.iter().any(|e| e == p) {
            cfg.enabled_providers.push(p.to_string());
        }
        migrated.push(p.to_string());
    }
    cfg.migrated_providers = Some(migrated);
    true
}

pub fn save(cfg: &Config) {
    let dir = config_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(config_path(), json);
    }
}
