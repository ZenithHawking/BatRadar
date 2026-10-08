//! Checks GitHub for a signed update in the background and installs only when
//! the user clicks. Mirrors the Electron build's "ask first" behaviour.
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

static PENDING: Mutex<Option<Update>> = Mutex::new(None);
static NOTIFIED: Mutex<Option<String>> = Mutex::new(None);
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct UpdateInfo {
    available: bool,
    version: String,
    current: String,
}

async fn check_inner(app: &AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = match &update {
        Some(u) => UpdateInfo { available: true, version: u.version.clone(), current },
        None => UpdateInfo { available: false, version: current.clone(), current },
    };
    if info.available {
        let _ = app.emit("update-available", json!({ "version": info.version }));
    }
    *PENDING.lock().unwrap() = update;
    Ok(info)
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    check_inner(&app).await
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("Đang cập nhật".into());
    }
    let result = async {
        let pending = PENDING.lock().unwrap().take();
        let update = match pending {
            Some(u) => u,
            None => app
                .updater()
                .map_err(|e| e.to_string())?
                .check()
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Không có bản mới".to_string())?,
        };
        let mut downloaded: u64 = 0;
        let progress_app = app.clone();
        update
            .download_and_install(
                move |chunk, total| {
                    downloaded += chunk as u64;
                    let percent = total.map(|t| ((downloaded * 100) / t.max(1)).min(100) as u8);
                    let _ = progress_app.emit("update-progress", json!({ "percent": percent }));
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    match result {
        Ok(()) => app.restart(),
        Err(e) => {
            INSTALLING.store(false, Ordering::SeqCst);
            let _ = app.emit("update-error", json!({ "message": e }));
            Err(e)
        }
    }
}

/// 30 s after start, then every 6 h. Notifies once per new version.
pub fn spawn_auto_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            match check_inner(&app).await {
                Ok(info) if info.available => {
                    let mut seen = NOTIFIED.lock().unwrap();
                    if seen.as_deref() != Some(info.version.as_str()) {
                        *seen = Some(info.version.clone());
                        let _ = app
                            .notification()
                            .builder()
                            .title("BatRadar")
                            .body(format!("Có bản {} — mở dashboard để cập nhật", info.version))
                            .show();
                    }
                }
                Ok(_) => {}
                Err(e) => eprintln!("[BatRadar][updater] {e}"),
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}
