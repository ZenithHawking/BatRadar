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
    /// Seasonal theme on/off (Settings → "Giao diện theo mùa")
    pub seasonal_theme: bool,
    /// Dev-only: force a theme id regardless of the schedule; edited by hand
    pub theme_preview: Option<String>,
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
            seasonal_theme: true,
            theme_preview: None,
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

/// Returns the config and whether it should be written back (new file or migration).
/// A file that exists but fails to parse is left untouched — overwriting it with
/// defaults would wipe the user's settings.
pub fn load_from(path: &std::path::Path) -> (Config, bool) {
    match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str::<Config>(&s) {
            Ok(mut cfg) => {
                let migrated = migrate(&mut cfg);
                (cfg, migrated)
            }
            Err(e) => {
                eprintln!("[BatRadar] config.json unreadable, using defaults: {e}");
                (Config::default(), false)
            }
        },
        Err(_) => {
            let mut cfg = Config::default();
            migrate(&mut cfg);
            (cfg, true)
        }
    }
}

pub fn load() -> Config {
    let (cfg, needs_save) = load_from(&config_path());
    if needs_save {
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

/// Temp file + rename so a concurrent reader never sees a half-written file.
pub fn save_to(path: &std::path::Path, cfg: &Config) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg)?)?;
    std::fs::rename(&tmp, path)
}

pub fn save(cfg: &Config) {
    if let Err(e) = save_to(&config_path(), cfg) {
        eprintln!("[BatRadar] config save failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("batradar-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("config.json")
    }

    #[test]
    fn missing_file_gives_defaults_and_needs_save() {
        let p = tmp("missing");
        let _ = std::fs::remove_file(&p);
        let (cfg, needs_save) = load_from(&p);
        assert!(cfg.seasonal_theme);
        assert!(cfg.theme_preview.is_none());
        assert!(needs_save);
    }

    #[test]
    fn corrupt_file_is_never_overwritten() {
        let p = tmp("corrupt");
        std::fs::write(&p, "{ not json").unwrap();
        let (cfg, needs_save) = load_from(&p);
        assert!(!needs_save);
        assert_eq!(cfg.poll_interval_seconds, 30);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{ not json");
    }

    #[test]
    fn old_config_gets_new_fields_with_defaults() {
        let p = tmp("old");
        std::fs::write(&p, r#"{"poll_interval_seconds":60,"migrated_providers":["gemini","copilot","openrouter","antigravity"]}"#).unwrap();
        let (cfg, _) = load_from(&p);
        assert_eq!(cfg.poll_interval_seconds, 60);
        assert!(cfg.seasonal_theme);
    }

    #[test]
    fn save_is_atomic_and_round_trips() {
        let p = tmp("save");
        let mut cfg = Config::default();
        cfg.theme_preview = Some("halloween-bi-ngo".into());
        save_to(&p, &cfg).unwrap();
        assert!(!p.with_extension("json.tmp").exists());
        let (back, _) = load_from(&p);
        assert_eq!(back.theme_preview.as_deref(), Some("halloween-bi-ngo"));
    }
}
