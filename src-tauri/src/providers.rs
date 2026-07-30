use crate::creds;
use chrono::{DateTime, TimeZone, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

// ─── Shared types ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct Window {
    pub utilization: f64,
    pub reset_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct LabeledWindow {
    pub label: String,
    pub utilization: f64,
    pub reset_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ExtraUsage {
    pub spend: f64,
    pub limit: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utilization: Option<f64>,
    pub currency: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Usage {
    pub session: Option<Window>,
    pub weekly: Option<Window>,
    pub weekly_sonnet: Option<Window>,
    pub weekly_opus: Option<Window>,
    pub extra_usage: Option<ExtraUsage>,
    /// Provider-supplied labelled rows; the dashboard renders these instead of
    /// the fixed session/weekly pair when present.
    pub windows: Option<Vec<LabeledWindow>>,
    pub plan_type: Option<String>,
    pub last_updated: String,
}

#[derive(Debug)]
pub enum FetchError {
    TokenExpired,
    RateLimited,
    Api(u16),
    Other(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::TokenExpired => write!(f, "token_expired"),
            FetchError::RateLimited => write!(f, "rate_limited"),
            FetchError::Api(c) => write!(f, "api_error:{c}"),
            FetchError::Other(m) => write!(f, "{m}"),
        }
    }
}

impl From<reqwest::Error> for FetchError {
    fn from(e: reqwest::Error) -> Self {
        FetchError::Other(e.to_string())
    }
}

type R<T> = Result<T, FetchError>;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("http client")
}

/// Maps the status codes every provider treats the same way.
fn check_status(status: u16) -> R<()> {
    match status {
        200..=299 => Ok(()),
        401 | 403 => Err(FetchError::TokenExpired),
        429 => Err(FetchError::RateLimited),
        c => Err(FetchError::Api(c)),
    }
}

fn unix_to_iso(secs: i64) -> Option<String> {
    Utc.timestamp_opt(secs, 0)
        .single()
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

// ─── Claude ──────────────────────────────────────────────────────────────────

pub async fn fetch_claude(token: &str) -> R<Value> {
    if token.starts_with("sk-ant-api") {
        return Ok(json!({ "_authMethod": "api-key" }));
    }
    let res = client()
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await?;
    check_status(res.status().as_u16())?;
    Ok(res.json().await?)
}

pub fn parse_claude(raw: &Value) -> Usage {
    // The API reports utilization as a percentage (0-100)
    let win = |key: &str| -> Option<Window> {
        let o = raw.get(key)?;
        let util = o.get("utilization")?.as_f64()?;
        Some(Window {
            utilization: clamp01(util / 100.0),
            reset_at: o
                .get("resets_at")
                .or_else(|| o.get("reset_at"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        })
    };
    let extra = raw.get("extra_usage").and_then(|eu| {
        if !eu.get("is_enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            return None;
        }
        let cents = |k: &str| eu.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) / 100.0;
        Some(ExtraUsage {
            spend: cents("used_credits"),
            limit: cents("monthly_limit"),
            utilization: eu.get("utilization").and_then(|v| v.as_f64()).map(|u| u / 100.0),
            currency: eu
                .get("currency")
                .and_then(|v| v.as_str())
                .unwrap_or("USD")
                .to_string(),
        })
    });
    Usage {
        session: win("five_hour"),
        weekly: win("seven_day"),
        weekly_sonnet: win("seven_day_sonnet"),
        weekly_opus: win("seven_day_opus"),
        extra_usage: extra,
        last_updated: now_iso(),
        ..Default::default()
    }
}

// ─── Codex ───────────────────────────────────────────────────────────────────

pub async fn fetch_codex(token: &str, account_id: &str) -> R<Value> {
    let res = client()
        .get("https://chatgpt.com/backend-api/wham/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("ChatGPT-Account-Id", account_id)
        .send()
        .await?;
    check_status(res.status().as_u16())?;
    Ok(res.json().await?)
}

pub fn parse_codex(raw: &Value) -> Usage {
    // used_percent is an integer percentage; reset_at is unix seconds
    let win = |w: Option<&Value>| -> Option<Window> {
        let w = w?;
        let pct = w.get("used_percent")?.as_f64()?;
        Some(Window {
            utilization: clamp01(pct / 100.0),
            reset_at: w.get("reset_at").and_then(|v| v.as_i64()).and_then(unix_to_iso),
        })
    };
    let rl = raw.get("rate_limit");
    let credits = raw.get("credits");
    let extra = credits.and_then(|c| {
        if !c.get("has_credits").and_then(|v| v.as_bool()).unwrap_or(false) {
            return None;
        }
        let balance = c
            .get("balance")
            .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(0.0);
        Some(ExtraUsage {
            spend: 0.0,
            limit: balance,
            utilization: None,
            currency: "USD".into(),
        })
    });
    Usage {
        session: win(rl.and_then(|r| r.get("primary_window"))),
        weekly: win(rl.and_then(|r| r.get("secondary_window"))),
        extra_usage: extra,
        plan_type: raw.get("plan_type").and_then(|v| v.as_str()).map(String::from),
        last_updated: now_iso(),
        ..Default::default()
    }
}

// ─── Gemini (Code Assist) ────────────────────────────────────────────────────

const GEMINI_API_BASE: &str = "https://cloudcode-pa.googleapis.com/v1internal";

async fn gemini_post(method: &str, token: &str, body: Value) -> R<Value> {
    let res = client()
        .post(format!("{GEMINI_API_BASE}:{method}"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .await?;
    check_status(res.status().as_u16())?;
    Ok(res.json().await?)
}

/// Returns (project_id, plan) — the plan name is only present for some tiers.
pub async fn gemini_load_project(token: &str) -> R<(String, Option<String>)> {
    let env_project = std::env::var("GOOGLE_CLOUD_PROJECT").ok();
    let raw = gemini_post(
        "loadCodeAssist",
        token,
        json!({
            "cloudaicompanionProject": env_project,
            "metadata": {
                "ideType": "GEMINI_CLI",
                "platform": "PLATFORM_UNSPECIFIED",
                "pluginType": "GEMINI"
            }
        }),
    )
    .await?;
    let plan = raw
        .pointer("/currentTier/name")
        .or_else(|| raw.pointer("/currentTier/id"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let project = raw
        .get("cloudaicompanionProject")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or(env_project)
        .unwrap_or_default();
    Ok((project, plan))
}

pub async fn fetch_gemini(token: &str, project: &str) -> R<Value> {
    gemini_post("retrieveUserQuota", token, json!({ "project": project })).await
}

pub fn parse_gemini(raw: &Value) -> Usage {
    // Quotas are daily and reported per model; keep each model's worst bucket
    let mut per_model: Vec<(String, f64, Option<String>)> = Vec::new();
    if let Some(buckets) = raw.get("buckets").and_then(|v| v.as_array()) {
        for b in buckets {
            let Some(frac) = b.get("remainingFraction").and_then(|v| v.as_f64()) else {
                continue;
            };
            let model = b
                .get("modelId")
                .and_then(|v| v.as_str())
                .unwrap_or("All models")
                .to_string();
            let reset = b.get("resetTime").and_then(|v| v.as_str()).map(String::from);
            match per_model.iter_mut().find(|(m, _, _)| *m == model) {
                Some(entry) if frac < entry.1 => {
                    entry.1 = frac;
                    entry.2 = reset;
                }
                Some(_) => {}
                None => per_model.push((model, frac, reset)),
            }
        }
    }
    let mut windows: Vec<LabeledWindow> = per_model
        .into_iter()
        .map(|(model, frac, reset)| LabeledWindow {
            label: format!("{model} (daily)"),
            utilization: clamp01(1.0 - frac),
            reset_at: reset,
        })
        .collect();
    windows.sort_by(|a, b| b.utilization.total_cmp(&a.utilization));
    usage_from_windows(windows)
}

/// Highest-used row drives the floating icon and the alert thresholds.
fn usage_from_windows(windows: Vec<LabeledWindow>) -> Usage {
    let session = windows.first().map(|w| Window {
        utilization: w.utilization,
        reset_at: w.reset_at.clone(),
    });
    Usage {
        session,
        windows: if windows.is_empty() { None } else { Some(windows) },
        last_updated: now_iso(),
        ..Default::default()
    }
}

// ─── Gemini / Google OAuth refresh ───────────────────────────────────────────

// Installed-app client of gemini-cli — the "secret" is public by design
// (shipped in the open-source repo, packages/core/src/code_assist/oauth2.ts)
const GEMINI_OAUTH_CLIENT_ID: &str =
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_OAUTH_CLIENT_SECRET: &str = "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";

pub async fn refresh_gemini_token() -> R<String> {
    let path = creds::gemini_cred_path();
    let mut d: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).map_err(|e| FetchError::Other(e.to_string()))?,
    )
    .map_err(|e| FetchError::Other(e.to_string()))?;
    let rt = d
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| FetchError::Other("no_refresh_token".into()))?
        .to_string();
    let res = client()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &rt),
            ("client_id", GEMINI_OAUTH_CLIENT_ID),
            ("client_secret", GEMINI_OAUTH_CLIENT_SECRET),
        ])
        .send()
        .await?;
    check_status(res.status().as_u16())?;
    let tok: Value = res.json().await?;
    let access = tok
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| FetchError::Other("refresh_failed:no_access_token".into()))?
        .to_string();
    d["access_token"] = json!(access);
    if let Some(id) = tok.get("id_token") {
        d["id_token"] = id.clone();
    }
    if let Some(exp) = tok.get("expires_in").and_then(|v| v.as_i64()) {
        d["expiry_date"] = json!(Utc::now().timestamp_millis() + exp * 1000);
    }
    creds::atomic_write_json(&path, &d).map_err(|e| FetchError::Other(e.to_string()))?;
    Ok(access)
}

// ─── Claude / Codex OAuth refresh ────────────────────────────────────────────

const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

pub async fn refresh_claude_token() -> R<String> {
    let path = creds::claude_cred_path();
    let mut d: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).map_err(|e| FetchError::Other(e.to_string()))?,
    )
    .map_err(|e| FetchError::Other(e.to_string()))?;
    let rt = d
        .pointer("/claudeAiOauth/refreshToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| FetchError::Other("no_refresh_token".into()))?
        .to_string();
    let res = client()
        .post("https://console.anthropic.com/v1/oauth/token")
        .json(&json!({
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "client_id": CLAUDE_OAUTH_CLIENT_ID,
        }))
        .send()
        .await?;
    check_status(res.status().as_u16())?;
    let tok: Value = res.json().await?;
    let access = tok
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| FetchError::Other("refresh_failed:no_access_token".into()))?
        .to_string();
    d["claudeAiOauth"]["accessToken"] = json!(access);
    if let Some(r) = tok.get("refresh_token") {
        d["claudeAiOauth"]["refreshToken"] = r.clone();
    }
    if let Some(exp) = tok.get("expires_in").and_then(|v| v.as_i64()) {
        d["claudeAiOauth"]["expiresAt"] = json!(Utc::now().timestamp_millis() + exp * 1000);
    }
    creds::atomic_write_json(&path, &d).map_err(|e| FetchError::Other(e.to_string()))?;
    Ok(access)
}

pub async fn refresh_codex_token() -> R<()> {
    let path = creds::codex_cred_path();
    let mut d: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).map_err(|e| FetchError::Other(e.to_string()))?,
    )
    .map_err(|e| FetchError::Other(e.to_string()))?;
    let rt = d
        .pointer("/tokens/refresh_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| FetchError::Other("no_refresh_token".into()))?
        .to_string();
    let res = client()
        .post("https://auth.openai.com/oauth/token")
        .json(&json!({
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "client_id": CODEX_OAUTH_CLIENT_ID,
            "scope": "openid profile email",
        }))
        .send()
        .await?;
    check_status(res.status().as_u16())?;
    let tok: Value = res.json().await?;
    let access = tok
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| FetchError::Other("refresh_failed:no_access_token".into()))?;
    d["tokens"]["access_token"] = json!(access);
    for key in ["id_token", "refresh_token"] {
        if let Some(v) = tok.get(key) {
            d["tokens"][key] = v.clone();
        }
    }
    d["last_refresh"] = json!(now_iso());
    creds::atomic_write_json(&path, &d).map_err(|e| FetchError::Other(e.to_string()))?;
    Ok(())
}

// ─── Copilot ─────────────────────────────────────────────────────────────────

pub async fn fetch_copilot(token: &str) -> R<Value> {
    let res = client()
        .get("https://api.github.com/copilot_internal/user")
        .header("Authorization", format!("token {token}"))
        .header("Accept", "application/json")
        .header("Editor-Version", "vscode/1.101.0")
        .header("Editor-Plugin-Version", "copilot-chat/0.27.0")
        .header("User-Agent", "GitHubCopilotChat/0.27.0")
        .header("X-GitHub-Api-Version", "2025-04-01")
        .send()
        .await?;
    check_status(res.status().as_u16())?;
    Ok(res.json().await?)
}

pub fn parse_copilot(raw: &Value) -> Usage {
    let label_for = |key: &str| -> String {
        match key {
            "premium_interactions" | "premium_requests" => "Premium requests".into(),
            "credits" => "Credits".into(),
            "chat" => "Chat".into(),
            "completions" => "Completions".into(),
            other => other.to_string(),
        }
    };
    let reset_at = raw
        .get("quota_reset_date")
        .and_then(|v| v.as_str())
        .and_then(|d| DateTime::parse_from_rfc3339(&format!("{d}T00:00:00Z")).ok())
        .map(|dt| {
            dt.with_timezone(&Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
    let mut windows = Vec::new();
    if let Some(snapshots) = raw.get("quota_snapshots").and_then(|v| v.as_object()) {
        for (key, s) in snapshots {
            if s.get("unlimited").and_then(|v| v.as_bool()).unwrap_or(false) {
                continue;
            }
            // Buckets the plan doesn't include report entitlement 0 with
            // percent_remaining 0 — that is "no quota", not "quota exhausted"
            if s.get("has_quota").and_then(|v| v.as_bool()) == Some(false) {
                continue;
            }
            if let Some(e) = s.get("entitlement").and_then(|v| v.as_f64()) {
                if e <= 0.0 {
                    continue;
                }
            }
            let Some(pct) = s.get("percent_remaining").and_then(|v| v.as_f64()) else {
                continue;
            };
            windows.push(LabeledWindow {
                label: label_for(key),
                utilization: clamp01(1.0 - pct / 100.0),
                reset_at: reset_at.clone(),
            });
        }
    }
    windows.sort_by(|a, b| b.utilization.total_cmp(&a.utilization));
    let mut usage = usage_from_windows(windows);
    // copilot_plan reads "individual" even on free_limited_copilot, so prefer
    // the SKU when it marks a free account
    let sku = raw.get("access_type_sku").and_then(|v| v.as_str()).unwrap_or("");
    usage.plan_type = if sku.contains("free") {
        Some("free".into())
    } else {
        raw.get("copilot_plan")
            .and_then(|v| v.as_str())
            .or(Some(sku).filter(|s| !s.is_empty()))
            .map(String::from)
    };
    usage
}

// ─── OpenRouter ──────────────────────────────────────────────────────────────

pub async fn fetch_openrouter(key: &str) -> R<Value> {
    let c = client();
    let res = c
        .get("https://openrouter.ai/api/v1/credits")
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await?;
    check_status(res.status().as_u16())?;
    let credits: Value = res.json().await?;
    // /key is best-effort: the balance still renders without it
    let key_info = match c
        .get("https://openrouter.ai/api/v1/key")
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
        _ => None,
    };
    Ok(json!({
        "credits": credits.get("data").cloned().unwrap_or(json!({})),
        "keyInfo": key_info.and_then(|k| k.get("data").cloned()),
    }))
}

pub fn parse_openrouter(raw: &Value) -> Usage {
    let num = |v: Option<&Value>| v.and_then(|v| v.as_f64()).unwrap_or(0.0);
    let total = num(raw.pointer("/credits/total_credits"));
    let used = num(raw.pointer("/credits/total_usage"));
    let key_info = raw.get("keyInfo").filter(|v| !v.is_null());

    let mut windows = Vec::new();
    if let Some(limit) = key_info.and_then(|k| k.get("limit")).and_then(|v| v.as_f64()) {
        if limit > 0.0 {
            windows.push(LabeledWindow {
                label: "Key limit".into(),
                utilization: clamp01(num(key_info.and_then(|k| k.get("usage"))) / limit),
                reset_at: None,
            });
        }
    }
    windows.push(LabeledWindow {
        label: "Credits used".into(),
        utilization: if total > 0.0 { clamp01(used / total) } else { 0.0 },
        reset_at: None,
    });

    let mut usage = usage_from_windows(windows);
    usage.extra_usage = Some(ExtraUsage {
        spend: used,
        limit: total,
        utilization: None,
        currency: "USD".into(),
    });
    usage.plan_type = key_info.map(|k| {
        if k.get("is_free_tier").and_then(|v| v.as_bool()).unwrap_or(false) {
            "free".to_string()
        } else {
            "paid".to_string()
        }
    });
    usage
}

// ─── Antigravity (local language server) ─────────────────────────────────────

const AG_RPC: &str = "exa.language_server_pb.LanguageServerService";

#[derive(Clone, Debug)]
pub struct AgServer {
    pub port: String,
    pub csrf: String,
}

pub async fn ag_post(server: &AgServer, method: &str) -> R<Value> {
    let res = client()
        .post(format!(
            "http://127.0.0.1:{}/{AG_RPC}/{method}",
            server.port
        ))
        .header("Content-Type", "application/json")
        .header("X-Codeium-Csrf-Token", &server.csrf)
        .header("Connect-Protocol-Version", "1")
        .json(&json!({
            "metadata": {
                "ideName": "antigravity",
                "extensionName": "antigravity",
                "locale": "en"
            }
        }))
        .send()
        .await?;
    check_status(res.status().as_u16())?;
    Ok(res.json().await?)
}

/// The Antigravity app runs a local language server exposing the same quota
/// data as its Model Quota UI. Find the process, read `--csrf_token` from its
/// command line, then probe the ports it listens on.
pub async fn discover_antigravity() -> Option<(AgServer, Value)> {
    let procs = run_hidden(
        "powershell.exe",
        &[
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"name='language_server.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }",
        ],
    )?;
    for line in procs.lines() {
        let Some((pid, cmd)) = line.split_once('|') else {
            continue;
        };
        let pid = pid.trim();
        let args: Vec<&str> = cmd.split_whitespace().collect();
        // The IDE build passes `antigravity-ide` and has no quota endpoint,
        // so match the value exactly rather than by prefix
        let is_app = args
            .windows(2)
            .any(|w| w[0] == "--app_data_dir" && w[1] == "antigravity");
        if !is_app {
            continue;
        }
        let Some(csrf) = args
            .windows(2)
            .find(|w| w[0] == "--csrf_token")
            .map(|w| w[1])
        else {
            continue;
        };
        let net = run_hidden("netstat", &["-ano"])?;
        let mut ports: Vec<String> = Vec::new();
        for l in net.lines() {
            if !l.contains("LISTENING") || l.split_whitespace().last() != Some(pid) {
                continue;
            }
            if let Some(rest) = l.split("127.0.0.1:").nth(1) {
                let port: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if !port.is_empty() && !ports.contains(&port) {
                    ports.push(port);
                }
            }
        }
        // The gRPC port rejects plain HTTP; only the HTTP port answers
        for port in ports {
            let server = AgServer {
                port,
                csrf: csrf.to_string(),
            };
            if let Ok(raw) = ag_post(&server, "RetrieveUserQuotaSummary").await {
                if raw.pointer("/response/groups").is_some() {
                    return Some((server, raw));
                }
            }
        }
    }
    None
}

fn run_hidden(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

pub fn parse_antigravity(raw: &Value) -> Usage {
    let mut windows = Vec::new();
    if let Some(groups) = raw.pointer("/response/groups").and_then(|v| v.as_array()) {
        for g in groups {
            let display = g.get("displayName").and_then(|v| v.as_str()).unwrap_or("Models");
            let group = if display == "Gemini Models" {
                "Gemini"
            } else if display.to_lowercase().contains("claude") {
                "Claude + GPT"
            } else {
                display
            };
            let Some(buckets) = g.get("buckets").and_then(|v| v.as_array()) else {
                continue;
            };
            for b in buckets {
                // proto3 JSON omits zero fields — a missing fraction means exhausted
                let remaining = b.get("remainingFraction").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let window = b.get("window").and_then(|v| v.as_str()).unwrap_or("weekly");
                windows.push(LabeledWindow {
                    label: format!("{group} ({})", if window == "5h" { "5h" } else { "weekly" }),
                    utilization: clamp01(1.0 - remaining),
                    reset_at: b.get("resetTime").and_then(|v| v.as_str()).map(String::from),
                });
            }
        }
    }
    // Keep the group ordering for display, but let the worst row drive the icon
    let session = windows
        .iter()
        .max_by(|a, b| a.utilization.total_cmp(&b.utilization))
        .map(|w| Window {
            utilization: w.utilization,
            reset_at: w.reset_at.clone(),
        });
    Usage {
        session,
        windows: if windows.is_empty() { None } else { Some(windows) },
        last_updated: now_iso(),
        ..Default::default()
    }
}
