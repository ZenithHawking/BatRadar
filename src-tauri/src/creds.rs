use crate::config;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn read_json(path: &PathBuf) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Write via temp file + rename so a CLI reading the file never sees a
/// half-written state.
pub fn atomic_write_json(path: &PathBuf, value: &Value) -> std::io::Result<()> {
    let tmp = path.with_extension("batradar-tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(value)?)?;
    std::fs::rename(&tmp, path)
}

// ─── Claude ──────────────────────────────────────────────────────────────────

pub fn claude_cred_path() -> PathBuf {
    let mut dirs_to_try = Vec::new();
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        dirs_to_try.push(PathBuf::from(d));
    }
    dirs_to_try.push(home().join(".claude"));
    for dir in &dirs_to_try {
        let p = dir.join(".credentials.json");
        if p.exists() {
            return p;
        }
    }
    home().join(".claude").join(".credentials.json")
}

pub fn read_manual_api_key() -> Option<String> {
    let raw = std::fs::read_to_string(config::apikey_path()).ok()?;
    let bytes = STANDARD.decode(raw.trim()).ok()?;
    String::from_utf8(bytes).ok()
}

pub fn save_manual_api_key(key: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(config::config_dir())?;
    std::fs::write(config::apikey_path(), STANDARD.encode(key))
}

pub fn delete_manual_api_key() {
    let _ = std::fs::remove_file(config::apikey_path());
}

pub fn read_claude_token() -> Option<String> {
    if let Some(k) = read_manual_api_key() {
        return Some(k);
    }
    let d = read_json(&claude_cred_path())?;
    for path in [
        d.pointer("/claudeAiOauth/accessToken"),
        d.get("oauth_token"),
        d.get("access_token"),
    ] {
        if let Some(s) = path.and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

pub fn read_claude_plan() -> Option<String> {
    if read_manual_api_key().is_some() {
        return Some("api-key".into());
    }
    let d = read_json(&claude_cred_path())?;
    d.pointer("/claudeAiOauth/subscriptionType")
        .or_else(|| d.get("account_type"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub fn claude_auth_method() -> &'static str {
    if read_manual_api_key().is_some() {
        return "api-key";
    }
    match read_json(&claude_cred_path()) {
        Some(d) if d.pointer("/claudeAiOauth/accessToken").is_some() => "oauth",
        _ => "none",
    }
}

// ─── Codex ───────────────────────────────────────────────────────────────────

pub fn codex_cred_path() -> PathBuf {
    let mut dirs_to_try = Vec::new();
    if let Ok(d) = std::env::var("CODEX_HOME") {
        dirs_to_try.push(PathBuf::from(d));
    }
    dirs_to_try.push(home().join(".codex"));
    for dir in &dirs_to_try {
        let p = dir.join("auth.json");
        if p.exists() {
            return p;
        }
    }
    home().join(".codex").join("auth.json")
}

pub struct CodexAuth {
    pub token: String,
    pub account_id: String,
}

pub fn read_codex_auth() -> Option<CodexAuth> {
    let d = read_json(&codex_cred_path())?;
    Some(CodexAuth {
        token: d.pointer("/tokens/access_token")?.as_str()?.to_string(),
        account_id: d.pointer("/tokens/account_id")?.as_str()?.to_string(),
    })
}

/// Falls back to decoding the id_token when no cached usage response is around.
pub fn read_codex_plan_from_jwt() -> Option<String> {
    let d = read_json(&codex_cred_path())?;
    let id_token = d.pointer("/tokens/id_token")?.as_str()?;
    let payload_b64 = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .ok()?;
    let payload: Value = serde_json::from_slice(&bytes).ok()?;
    payload
        .pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

pub fn gemini_cred_path() -> PathBuf {
    home().join(".gemini").join("oauth_creds.json")
}

pub struct GeminiAuth {
    pub token: String,
    pub expiry_date: i64,
}

pub fn read_gemini_auth() -> Option<GeminiAuth> {
    let d = read_json(&gemini_cred_path())?;
    Some(GeminiAuth {
        token: d.get("access_token")?.as_str()?.to_string(),
        expiry_date: d.get("expiry_date").and_then(|v| v.as_i64()).unwrap_or(0),
    })
}

// ─── Copilot ─────────────────────────────────────────────────────────────────

/// `gh` keeps its token in Windows Credential Manager by default, so there is
/// no file to read — `gh auth token` prints it. Spawning a process on every
/// poll would be wasteful and the token only changes on re-login, so cache it.
static GH_TOKEN_CACHE: Mutex<Option<(Option<String>, Instant)>> = Mutex::new(None);

fn gh_cli_token() -> Option<String> {
    if let Ok(cache) = GH_TOKEN_CACHE.lock() {
        if let Some((token, at)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(600) {
                return token.clone();
            }
        }
    }
    let program_files =
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
    let candidates = [
        "gh".to_string(),
        format!("{program_files}\\GitHub CLI\\gh.exe"),
    ];
    let mut found = None;
    for bin in &candidates {
        let mut cmd = Command::new(bin);
        cmd.args(["auth", "token"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        if let Ok(out) = cmd.output() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                found = Some(s);
                break;
            }
        }
    }
    if let Ok(mut cache) = GH_TOKEN_CACHE.lock() {
        *cache = Some((found.clone(), Instant::now()));
    }
    found
}

pub fn read_copilot_token() -> Option<String> {
    // Editor plugins (VS Code / JetBrains / Neovim) write apps.json (older: hosts.json)
    let mut dirs_to_try = Vec::new();
    if let Ok(d) = std::env::var("LOCALAPPDATA") {
        dirs_to_try.push(PathBuf::from(d).join("github-copilot"));
    }
    dirs_to_try.push(home().join(".config").join("github-copilot"));
    for dir in &dirs_to_try {
        for file in ["apps.json", "hosts.json"] {
            if let Some(d) = read_json(&dir.join(file)) {
                if let Some(obj) = d.as_object() {
                    for (k, v) in obj {
                        if k.starts_with("github.com") {
                            if let Some(t) = v.get("oauth_token").and_then(|v| v.as_str()) {
                                return Some(t.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    // GitHub CLI config file, when gh was told to use insecure storage
    let mut yml_paths = Vec::new();
    if let Ok(d) = std::env::var("APPDATA") {
        yml_paths.push(PathBuf::from(d).join("GitHub CLI").join("hosts.yml"));
    }
    yml_paths.push(home().join(".config").join("gh").join("hosts.yml"));
    for p in &yml_paths {
        if let Ok(text) = std::fs::read_to_string(p) {
            for line in text.lines() {
                if let Some(rest) = line.trim().strip_prefix("oauth_token:") {
                    let t = rest.trim();
                    if !t.is_empty() {
                        return Some(t.to_string());
                    }
                }
            }
        }
    }
    gh_cli_token()
}

// ─── OpenRouter ──────────────────────────────────────────────────────────────

pub fn read_openrouter_key() -> Option<String> {
    if let Ok(raw) = std::fs::read_to_string(config::openrouter_key_path()) {
        if let Ok(bytes) = STANDARD.decode(raw.trim()) {
            if let Ok(s) = String::from_utf8(bytes) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    std::env::var("OPENROUTER_API_KEY").ok().filter(|s| !s.is_empty())
}

pub fn save_openrouter_key(key: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(config::config_dir())?;
    std::fs::write(config::openrouter_key_path(), STANDARD.encode(key))
}

pub fn delete_openrouter_key() {
    let _ = std::fs::remove_file(config::openrouter_key_path());
}
