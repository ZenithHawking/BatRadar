// Prevent a console window from appearing on Windows release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alerts;
mod config;
mod creds;
mod history;
mod providers;
mod updater;

use config::{Config, Pos};
use providers::{AgServer, Usage};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;

const FLOAT_SIZE: f64 = 62.0;
/// Set when the user hides the icon on purpose, so the recovery loop below
/// does not bring it back.
static FLOATING_HIDDEN: AtomicBool = AtomicBool::new(false);
/// Minimum gap between calls to the same provider, on top of any 429 backoff
const MIN_POLL_GAP: Duration = Duration::from_secs(30);

// ─── State ───────────────────────────────────────────────────────────────────

#[derive(Default)]
struct ProviderState {
    cache: Option<Usage>,
    /// Seconds of extra delay after a 429, doubling up to a cap
    extra_delay: u64,
    last_poll_at: Option<Instant>,
    last_refresh_at: Option<Instant>,
    alert_reset_at: Option<String>,
    alert_flags: alerts::AlertFlags,
    /// Gemini: resolved once per run
    project_id: Option<String>,
    plan: Option<String>,
    /// Antigravity: discovered local server, cleared when the app restarts
    ag_server: Option<AgServer>,
}

struct AppState(Mutex<HashMap<String, ProviderState>>);

fn with_state<T>(app: &AppHandle, id: &str, f: impl FnOnce(&mut ProviderState) -> T) -> T {
    let state = app.state::<AppState>();
    let mut guard = state.0.lock().unwrap();
    f(guard.entry(id.to_string()).or_default())
}

fn provider_name(id: &str) -> &'static str {
    match id {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "gemini" => "Gemini CLI",
        "copilot" => "Copilot",
        "openrouter" => "OpenRouter",
        "antigravity" => "Antigravity",
        _ => "Provider",
    }
}

// ─── Broadcast helpers ───────────────────────────────────────────────────────

fn emit_status(app: &AppHandle, provider: &str, status: &str) {
    let _ = app.emit(
        "provider-status-changed",
        json!({ "provider": provider, "status": status }),
    );
}

fn emit_usage(app: &AppHandle, provider: &str, data: &Usage) {
    history::maybe_log(provider, data);
    let _ = app.emit("usage-update", json!({ "provider": provider, "data": data }));
}

#[tauri::command]
fn get_usage_history(provider: String) -> Vec<history::HistoryPoint> {
    history::read(&provider, 30)
}

// ─── Polling ─────────────────────────────────────────────────────────────────

/// Returns false when the provider was polled too recently to call again.
fn poll_allowed(app: &AppHandle, id: &str) -> bool {
    with_state(app, id, |st| {
        let gap = MIN_POLL_GAP + Duration::from_secs(st.extra_delay);
        match st.last_poll_at {
            Some(at) if at.elapsed() < gap => false,
            _ => {
                st.last_poll_at = Some(Instant::now());
                true
            }
        }
    })
}

/// One refresh attempt per provider per 5 minutes — a rejected fresh token
/// means re-login is genuinely needed, so don't hammer the auth server.
fn refresh_allowed(app: &AppHandle, id: &str) -> bool {
    with_state(app, id, |st| match st.last_refresh_at {
        Some(at) if at.elapsed() < Duration::from_secs(300) => false,
        _ => {
            st.last_refresh_at = Some(Instant::now());
            true
        }
    })
}

fn on_success(app: &AppHandle, id: &str, data: Usage, cfg: &Config) {
    with_state(app, id, |st| {
        st.cache = Some(data.clone());
        st.extra_delay = 0;
    });
    emit_usage(app, id, &data);
    emit_status(app, id, "connected");
    check_alerts(app, id, &data, cfg);
    println!(
        "[BatRadar][{id}] OK — session={:?}",
        data.session.as_ref().map(|s| s.utilization)
    );
}

fn on_error(app: &AppHandle, id: &str, err: &providers::FetchError) {
    eprintln!("[BatRadar][{id}] Error: {err}");
    match err {
        providers::FetchError::TokenExpired => emit_status(app, id, "expired"),
        providers::FetchError::RateLimited => {
            with_state(app, id, |st| {
                st.extra_delay = (st.extra_delay.max(30) * 2).min(300);
            });
        }
        _ => emit_status(app, id, "error"),
    }
}

async fn poll_claude(app: AppHandle, cfg: Config) {
    let id = "claude";
    if !poll_allowed(&app, id) {
        return;
    }
    let Some(token) = creds::read_claude_token() else {
        emit_status(&app, id, "disconnected");
        return;
    };
    match providers::fetch_claude(&token).await {
        Ok(raw) => on_success(&app, id, providers::parse_claude(&raw), &cfg),
        Err(providers::FetchError::TokenExpired)
            if creds::claude_auth_method() == "oauth" && refresh_allowed(&app, id) =>
        {
            match providers::refresh_claude_token().await {
                Ok(token) => match providers::fetch_claude(&token).await {
                    Ok(raw) => on_success(&app, id, providers::parse_claude(&raw), &cfg),
                    Err(e) => on_error(&app, id, &e),
                },
                Err(e) => {
                    eprintln!("[BatRadar][{id}] Refresh failed: {e}");
                    emit_status(&app, id, "expired");
                }
            }
        }
        Err(e) => on_error(&app, id, &e),
    }
}

async fn poll_codex(app: AppHandle, cfg: Config) {
    let id = "codex";
    if !poll_allowed(&app, id) {
        return;
    }
    let Some(auth) = creds::read_codex_auth() else {
        emit_status(&app, id, "disconnected");
        return;
    };
    match providers::fetch_codex(&auth.token, &auth.account_id).await {
        Ok(raw) => on_success(&app, id, providers::parse_codex(&raw), &cfg),
        Err(providers::FetchError::TokenExpired) if refresh_allowed(&app, id) => {
            if providers::refresh_codex_token().await.is_ok() {
                if let Some(auth) = creds::read_codex_auth() {
                    match providers::fetch_codex(&auth.token, &auth.account_id).await {
                        Ok(raw) => {
                            on_success(&app, id, providers::parse_codex(&raw), &cfg);
                            return;
                        }
                        Err(e) => return on_error(&app, id, &e),
                    }
                }
            }
            emit_status(&app, id, "expired");
        }
        Err(e) => on_error(&app, id, &e),
    }
}

async fn poll_gemini(app: AppHandle, cfg: Config) {
    let id = "gemini";
    if !poll_allowed(&app, id) {
        return;
    }
    let Some(auth) = creds::read_gemini_auth() else {
        emit_status(&app, id, "disconnected");
        return;
    };
    // Google access tokens live ~1h — refresh ahead of expiry like the CLI does
    let mut token = auth.token;
    let expiring = auth.expiry_date > 0
        && auth.expiry_date < chrono::Utc::now().timestamp_millis() + 60_000;
    if expiring && refresh_allowed(&app, id) {
        if let Ok(fresh) = providers::refresh_gemini_token().await {
            token = fresh;
        }
    }
    let project = match with_state(&app, id, |st| st.project_id.clone()) {
        Some(p) => p,
        None => match providers::gemini_load_project(&token).await {
            Ok((project, plan)) => {
                with_state(&app, id, |st| {
                    st.project_id = Some(project.clone());
                    st.plan = plan;
                });
                project
            }
            Err(e) => return on_error(&app, id, &e),
        },
    };
    match providers::fetch_gemini(&token, &project).await {
        Ok(raw) => on_success(&app, id, providers::parse_gemini(&raw), &cfg),
        Err(providers::FetchError::TokenExpired) if refresh_allowed(&app, id) => {
            match providers::refresh_gemini_token().await {
                Ok(fresh) => match providers::fetch_gemini(&fresh, &project).await {
                    Ok(raw) => on_success(&app, id, providers::parse_gemini(&raw), &cfg),
                    Err(e) => on_error(&app, id, &e),
                },
                Err(_) => emit_status(&app, id, "expired"),
            }
        }
        Err(e) => on_error(&app, id, &e),
    }
}

async fn poll_copilot(app: AppHandle, cfg: Config) {
    let id = "copilot";
    if !poll_allowed(&app, id) {
        return;
    }
    let Some(token) = creds::read_copilot_token() else {
        emit_status(&app, id, "disconnected");
        return;
    };
    match providers::fetch_copilot(&token).await {
        Ok(raw) => on_success(&app, id, providers::parse_copilot(&raw), &cfg),
        Err(e) => on_error(&app, id, &e),
    }
}

async fn poll_openrouter(app: AppHandle, cfg: Config) {
    let id = "openrouter";
    if !poll_allowed(&app, id) {
        return;
    }
    let Some(key) = creds::read_openrouter_key() else {
        emit_status(&app, id, "disconnected");
        return;
    };
    match providers::fetch_openrouter(&key).await {
        Ok(raw) => on_success(&app, id, providers::parse_openrouter(&raw), &cfg),
        Err(e) => on_error(&app, id, &e),
    }
}

async fn poll_antigravity(app: AppHandle, cfg: Config) {
    let id = "antigravity";
    if !poll_allowed(&app, id) {
        return;
    }
    // Reuse the discovered server; a failure means the app restarted on a new port
    let known = with_state(&app, id, |st| st.ag_server.clone());
    if let Some(server) = known {
        match providers::ag_post(&server, "RetrieveUserQuotaSummary").await {
            Ok(raw) => return on_success(&app, id, providers::parse_antigravity(&raw), &cfg),
            Err(_) => with_state(&app, id, |st| st.ag_server = None),
        }
    }
    match providers::discover_antigravity().await {
        Some((server, raw)) => {
            // Best-effort plan name ("Pro", "Ultra", …)
            if let Ok(status) = providers::ag_post(&server, "GetUserStatus").await {
                let plan = status
                    .pointer("/userStatus/planStatus/planInfo/planName")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                with_state(&app, id, |st| st.plan = plan);
            }
            with_state(&app, id, |st| st.ag_server = Some(server));
            on_success(&app, id, providers::parse_antigravity(&raw), &cfg);
        }
        None => emit_status(&app, id, "disconnected"),
    }
}

async fn poll_all(app: AppHandle, cfg: Config) {
    let on = |id: &str| cfg.enabled_providers.iter().any(|p| p == id);
    // Run every provider concurrently — one slow API must not delay the rest
    let mut tasks = Vec::new();
    if on("claude") {
        tasks.push(tokio::spawn(poll_claude(app.clone(), cfg.clone())));
    }
    if on("codex") {
        tasks.push(tokio::spawn(poll_codex(app.clone(), cfg.clone())));
    }
    if on("gemini") {
        tasks.push(tokio::spawn(poll_gemini(app.clone(), cfg.clone())));
    }
    if on("copilot") {
        tasks.push(tokio::spawn(poll_copilot(app.clone(), cfg.clone())));
    }
    if on("openrouter") {
        tasks.push(tokio::spawn(poll_openrouter(app.clone(), cfg.clone())));
    }
    if on("antigravity") {
        tasks.push(tokio::spawn(poll_antigravity(app.clone(), cfg.clone())));
    }
    for t in tasks {
        let _ = t.await;
    }
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

fn fmt_dur(secs: i64) -> String {
    if secs <= 0 {
        return "now".into();
    }
    let (d, h, m) = (secs / 86400, (secs % 86400) / 3600, (secs % 3600) / 60);
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

fn check_alerts(app: &AppHandle, id: &str, data: &Usage, cfg: &Config) {
    if !cfg.notification_enabled {
        return;
    }
    let Some(session) = data.session.as_ref() else {
        return;
    };
    let util = session.utilization;
    let pct = (util * 100.0).round() as i64;
    let secs = session
        .reset_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| (dt.timestamp() - chrono::Utc::now().timestamp()).max(0))
        .unwrap_or(0);
    let rst = fmt_dur(secs);

    // A new quota window resets which alerts have already fired
    let level = with_state(app, id, |st| {
        if st.alert_reset_at != session.reset_at {
            st.alert_reset_at = session.reset_at.clone();
            st.alert_flags = alerts::AlertFlags::default();
        }
        alerts::pick(util, cfg.alert_threshold, cfg.critical_threshold, &mut st.alert_flags)
    });
    let name = provider_name(id);
    let (sub, body) = match level {
        Some(alerts::Level::Limit) => ("Limit Reached", format!("Session full! Resets in {rst}")),
        Some(alerts::Level::Critical) => ("Critical", format!("Session {pct}%! Resets in {rst}")),
        Some(alerts::Level::Warning) => ("Warning", format!("Session {pct}%. Resets in {rst}")),
        None => return,
    };
    let _ = app
        .notification()
        .builder()
        .title(format!("{name} – {sub}"))
        .body(body)
        .show();
}

// ─── Windows ─────────────────────────────────────────────────────────────────

fn build_floating(app: &AppHandle, pos: Option<Pos>) -> tauri::Result<()> {
    let Pos { x, y } = pos.unwrap_or(Pos { x: 80, y: 80 });
    WebviewWindowBuilder::new(app, "floating", WebviewUrl::App("floating.html".into()))
        .title("")
        .inner_size(FLOAT_SIZE, FLOAT_SIZE)
        .position(x as f64, y as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        // Never take focus: keeps the overlay out of Alt+Tab and stops it
        // stealing focus from whatever the user is working in
        .focused(false)
        .focusable(false)
        .build()?;
    Ok(())
}

fn build_dashboard(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::App("index.html".into()))
        .title("BatRadar")
        .inner_size(400.0, 560.0)
        .resizable(false)
        // Tauri's native drag-drop handler (for OS file drops) intercepts
        // pointer events before the page sees them, which blocks the
        // provider cards' own HTML5 drag-to-reorder — the page doesn't
        // accept file drops, so there's nothing to lose by disabling it.
        .disable_drag_drop_handler()
        .center()
        .visible(false)
        .build()?;
    Ok(())
}

fn build_settings(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("BatRadar — Settings")
        .inner_size(420.0, 500.0)
        .resizable(false)
        .center()
        .visible(false)
        .build()?;
    Ok(())
}

fn show_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Windows can drop WS_EX_TOPMOST from the overlay (display sleep, fullscreen
/// apps, explorer restart) without hiding it, and tao's set_always_on_top is a
/// no-op when its own flag is already set — so push the HWND back to the
/// topmost band directly. NOACTIVATE keeps focus where the user left it.
#[cfg(windows)]
fn reassert_topmost(w: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    };
    if let Ok(hwnd) = w.hwnd() {
        unsafe {
            SetWindowPos(
                hwnd.0 as _,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
        }
    }
}
#[cfg(not(windows))]
fn reassert_topmost(_w: &tauri::WebviewWindow) {}

fn hide_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.hide();
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ProviderInfo {
    id: String,
    name: String,
    icon: String,
    plan: Option<String>,
    status: String,
    auth: String,
    error: Option<String>,
}

#[tauri::command]
fn get_providers(app: AppHandle) -> Vec<ProviderInfo> {
    let cfg = config::load();
    let enabled = |id: &str| cfg.enabled_providers.iter().any(|p| p == id);
    let status = |id: &str, has_auth: bool| {
        if !enabled(id) {
            "disabled"
        } else if has_auth {
            "connected"
        } else {
            "disconnected"
        }
        .to_string()
    };
    let claude_auth = creds::claude_auth_method();
    let codex_auth = creds::read_codex_auth().is_some();
    let gemini_auth = creds::read_gemini_auth().is_some();
    let copilot_auth = creds::read_copilot_token().is_some();
    let or_auth = creds::read_openrouter_key().is_some();
    let ag_auth = with_state(&app, "antigravity", |st| st.ag_server.is_some());

    let cached_plan = |id: &str| with_state(&app, id, |st| st.cache.as_ref().and_then(|c| c.plan_type.clone()));
    let state_plan = |id: &str| with_state(&app, id, |st| st.plan.clone());

    vec![
        ProviderInfo {
            id: "claude".into(),
            name: "Claude Code".into(),
            icon: "claude".into(),
            plan: creds::read_claude_plan(),
            status: status("claude", creds::read_claude_token().is_some()),
            auth: claude_auth.into(),
            error: None,
        },
        ProviderInfo {
            id: "codex".into(),
            name: "Codex".into(),
            icon: "codex".into(),
            plan: cached_plan("codex").or_else(creds::read_codex_plan_from_jwt),
            status: status("codex", codex_auth),
            auth: if codex_auth { "oauth" } else { "none" }.into(),
            error: None,
        },
        ProviderInfo {
            id: "gemini".into(),
            name: "Gemini CLI".into(),
            icon: "gemini".into(),
            plan: state_plan("gemini"),
            status: status("gemini", gemini_auth),
            auth: if gemini_auth { "oauth" } else { "none" }.into(),
            error: None,
        },
        ProviderInfo {
            id: "copilot".into(),
            name: "Copilot".into(),
            icon: "copilot".into(),
            plan: cached_plan("copilot"),
            status: status("copilot", copilot_auth),
            auth: if copilot_auth { "oauth" } else { "none" }.into(),
            error: None,
        },
        ProviderInfo {
            id: "openrouter".into(),
            name: "OpenRouter".into(),
            icon: "openrouter".into(),
            plan: cached_plan("openrouter"),
            status: status("openrouter", or_auth),
            auth: if or_auth { "api-key" } else { "none" }.into(),
            error: None,
        },
        ProviderInfo {
            id: "antigravity".into(),
            name: "Antigravity".into(),
            icon: "antigravity".into(),
            plan: state_plan("antigravity"),
            status: status("antigravity", ag_auth),
            auth: if ag_auth { "local" } else { "none" }.into(),
            error: None,
        },
    ]
}

#[tauri::command]
fn get_usage(app: AppHandle, provider: String) -> Result<Usage, String> {
    with_state(&app, &provider, |st| st.cache.clone()).ok_or_else(|| "Waiting for data…".to_string())
}

#[tauri::command]
fn load_settings() -> Config {
    config::load()
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Value) {
    // Merge onto the current config so keys this form doesn't own
    // (display_providers, floating_position, enabled_providers…) survive
    let mut current = serde_json::to_value(config::load()).unwrap_or_else(|_| json!({}));
    if let (Some(base), Some(patch)) = (current.as_object_mut(), settings.as_object()) {
        for (k, v) in patch {
            base.insert(k.clone(), v.clone());
        }
    }
    if let Ok(cfg) = serde_json::from_value::<Config>(current) {
        config::save(&cfg);
        set_autostart(app.clone(), cfg.autostart);
        let _ = app.emit("settings-changed", &cfg);
    }
}

#[tauri::command]
fn show_dashboard(app: AppHandle) {
    show_window(&app, "dashboard");
}

#[tauri::command]
fn hide_dashboard(app: AppHandle) {
    hide_window(&app, "dashboard");
}

#[tauri::command]
fn show_settings(app: AppHandle) {
    show_window(&app, "settings");
}

#[tauri::command]
fn hide_settings(app: AppHandle) {
    hide_window(&app, "settings");
}

#[tauri::command]
fn check_credential(provider: String) -> Value {
    let found = |method: &str, message: &str| {
        json!({ "found": true, "valid": true, "method": method, "message": message })
    };
    let missing =
        |message: &str| json!({ "found": false, "valid": false, "method": "none", "message": message });
    match provider.as_str() {
        "claude" => match creds::claude_auth_method() {
            "none" => missing("Run 'claude login'"),
            m => found(m, if m == "api-key" { "API Key" } else { "OAuth" }),
        },
        "codex" => {
            if creds::read_codex_auth().is_some() {
                found("oauth", "OAuth token found")
            } else {
                missing("Run 'codex' and login")
            }
        }
        "gemini" => {
            if creds::read_gemini_auth().is_some() {
                found("oauth", "OAuth token found")
            } else {
                missing("Run 'gemini' and login")
            }
        }
        "copilot" => {
            if creds::read_copilot_token().is_some() {
                found("oauth", "GitHub token found")
            } else {
                missing("Login Copilot in your editor or run gh auth login")
            }
        }
        "openrouter" => {
            if creds::read_openrouter_key().is_some() {
                found("api-key", "API key set")
            } else {
                missing("Enter API key in Settings")
            }
        }
        _ => missing("Not supported"),
    }
}

#[tauri::command]
fn get_auth_method() -> String {
    creds::claude_auth_method().to_string()
}

#[tauri::command]
fn save_api_key(app: AppHandle, key: String) -> Result<Value, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Empty key".into());
    }
    creds::save_manual_api_key(key).map_err(|e| e.to_string())?;
    with_state(&app, "claude", |st| {
        st.cache = None;
        st.last_poll_at = None;
    });
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn remove_api_key(app: AppHandle) -> Value {
    creds::delete_manual_api_key();
    with_state(&app, "claude", |st| {
        st.cache = None;
        st.last_poll_at = None;
    });
    json!({ "success": true })
}

#[tauri::command]
fn save_openrouter_key(app: AppHandle, key: String) -> Result<Value, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Empty key".into());
    }
    creds::save_openrouter_key(key).map_err(|e| e.to_string())?;
    with_state(&app, "openrouter", |st| {
        st.cache = None;
        st.last_poll_at = None;
    });
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn remove_openrouter_key(app: AppHandle) -> Value {
    creds::delete_openrouter_key();
    with_state(&app, "openrouter", |st| st.cache = None);
    emit_status(&app, "openrouter", "disconnected");
    json!({ "success": true })
}

#[tauri::command]
fn get_openrouter_key_status() -> bool {
    creds::read_openrouter_key().is_some()
}

#[tauri::command]
fn disconnect_provider(app: AppHandle, provider: String) {
    let mut cfg = config::load();
    cfg.enabled_providers.retain(|p| *p != provider);
    config::save(&cfg);
    // Keep the saved credentials — disconnect only pauses monitoring
    with_state(&app, &provider, |st| {
        st.cache = None;
        st.last_poll_at = None;
        st.alert_reset_at = None;
    });
    emit_status(&app, &provider, "disabled");
}

#[tauri::command]
fn reconnect_provider(app: AppHandle, provider: String) {
    let mut cfg = config::load();
    if !cfg.enabled_providers.contains(&provider) {
        cfg.enabled_providers.push(provider.clone());
    }
    config::save(&cfg);
    with_state(&app, &provider, |st| st.last_poll_at = None);
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let _ = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
}

#[tauri::command]
fn save_position(x: i32, y: i32) {
    let mut cfg = config::load();
    cfg.floating_position = Some(Pos { x, y });
    config::save(&cfg);
}

/// The renderer works in CSS pixels, so every position crossing the IPC
/// boundary is logical — converting is what keeps dragging accurate on
/// displays with scaling other than 100%.
fn floating_logical_pos(w: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let p = w.outer_position().ok()?;
    let scale = w.scale_factor().unwrap_or(1.0);
    let l = p.to_logical::<f64>(scale);
    Some((l.x, l.y))
}

#[tauri::command]
fn get_floating_position(app: AppHandle) -> Option<Pos> {
    if let Some(w) = app.get_webview_window("floating") {
        if let Some((x, y)) = floating_logical_pos(&w) {
            return Some(Pos {
                x: x.round() as i32,
                y: y.round() as i32,
            });
        }
    }
    config::load().floating_position
}

/// Called on every mousemove during a drag, so it must not touch disk —
/// the renderer persists the final position on mouseup via `save_position`.
#[tauri::command]
fn set_floating_pos(app: AppHandle, x: f64, y: f64) {
    if let Some(w) = app.get_webview_window("floating") {
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    }
}

#[tauri::command]
fn move_floating(app: AppHandle, dx: f64, dy: f64) {
    if let Some(w) = app.get_webview_window("floating") {
        if let Some((x, y)) = floating_logical_pos(&w) {
            let (nx, ny) = (x + dx, y + dy);
            let _ = w.set_position(tauri::LogicalPosition::new(nx, ny));
            save_position(nx.round() as i32, ny.round() as i32);
        }
    }
}

#[tauri::command]
fn show_floating(app: AppHandle) {
    FLOATING_HIDDEN.store(false, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window("floating") {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
    }
}

#[tauri::command]
fn hide_floating(app: AppHandle) {
    FLOATING_HIDDEN.store(true, Ordering::Relaxed);
    hide_window(&app, "floating");
}

#[tauri::command]
fn get_display_providers() -> Option<Vec<String>> {
    config::load().display_providers
}

#[tauri::command]
fn set_display_providers(app: AppHandle, providers: Option<Vec<String>>) {
    let mut cfg = config::load();
    cfg.display_providers = providers.clone();
    config::save(&cfg);
    let _ = app.emit("display-providers-changed", json!({ "providers": providers }));
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) {
    if url.starts_with("https://") || url.starts_with("http://") {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The Electron updater runs the 0.4.0 installer from its own cache folder, so
/// the installer cannot delete it; anything of the Electron install it could
/// not remove is cleaned here once the installer has exited.
fn cleanup_electron_leftovers() {
    let Some(local) = dirs::data_local_dir() else { return };
    for dir in [local.join("bat-radar-updater"), local.join("Programs").join("bat-radar")] {
        if dir.exists() {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => println!("[BatRadar] removed leftover {}", dir.display()),
                Err(e) => eprintln!("[BatRadar] could not remove {}: {e}", dir.display()),
            }
        }
    }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        // Must be registered first: a second launch focuses the running app
        // instead of starting a duplicate tray icon and poller
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app, "dashboard");
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .manage(AppState(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            get_providers,
            get_usage,
            load_settings,
            save_settings,
            show_dashboard,
            hide_dashboard,
            show_settings,
            hide_settings,
            check_credential,
            get_auth_method,
            save_api_key,
            remove_api_key,
            save_openrouter_key,
            remove_openrouter_key,
            get_openrouter_key_status,
            disconnect_provider,
            reconnect_provider,
            set_autostart,
            save_position,
            get_floating_position,
            set_floating_pos,
            move_floating,
            show_floating,
            hide_floating,
            get_display_providers,
            set_display_providers,
            open_external,
            get_app_version,
            updater::check_update,
            updater::install_update,
            get_usage_history,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let cfg = config::load();

            build_floating(&handle, cfg.floating_position)?;
            build_dashboard(&handle)?;
            build_settings(&handle)?;

            let version = env!("CARGO_PKG_VERSION");
            let show = MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let about = MenuItem::with_id(
                app,
                "about",
                format!("About BatRadar {version}"),
                false,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &settings, &about, &quit])?;

            TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../../src/assets/icons/tray-icon.png"
                ))?)
                .tooltip("BatRadar")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_window(app, "dashboard"),
                    "settings" => show_window(app, "settings"),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                        if button == tauri::tray::MouseButton::Left {
                            show_window(tray.app_handle(), "dashboard");
                        }
                    }
                })
                .build(app)?;

            updater::spawn_auto_check(handle.clone());
            tauri::async_runtime::spawn(async {
                tokio::time::sleep(Duration::from_secs(15)).await;
                cleanup_electron_leftovers();
            });

            // Show the dashboard shortly after startup
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                show_window(&h, "dashboard");
            });

            // Polling loop: re-reads the config each tick so an interval change
            // in Settings takes effect without restarting anything
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                println!("[BatRadar] First poll in 5 seconds...");
                tokio::time::sleep(Duration::from_secs(5)).await;
                loop {
                    let cfg = config::load();
                    poll_all(h.clone(), cfg.clone()).await;
                    tokio::time::sleep(Duration::from_secs(cfg.poll_interval_seconds.max(5))).await;
                }
            });

            // Safety net for the floating icon: WebView2/DWM can leave a
            // transparent layered window invisible after display sleep,
            // lock screen, or a GPU reset without firing any window event
            // Tauri exposes. Poll and re-show it, and rebuild it outright if
            // the handle itself is gone (e.g. a webview crash tore it down).
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if FLOATING_HIDDEN.load(Ordering::Relaxed) {
                        continue;
                    }
                    match h.get_webview_window("floating") {
                        Some(w) => {
                            if matches!(w.is_visible(), Ok(false)) {
                                let _ = w.show();
                            }
                            reassert_topmost(&w);
                        }
                        None => {
                            let cfg = config::load();
                            let _ = build_floating(&h, cfg.floating_position);
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing a window hides it — the app lives in the tray
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running BatRadar");
}
