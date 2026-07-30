use crate::config::config_dir;
use crate::providers::Usage;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Snapshots are coarser than the poll interval — a point every 15 minutes
/// is plenty for a burn-rate chart and keeps the log small regardless of
/// how aggressively the user has configured polling.
const LOG_INTERVAL_SECS: i64 = 15 * 60;
const RETENTION_DAYS: i64 = 30;
const PRUNE_INTERVAL_SECS: i64 = 60 * 60;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HistoryPoint {
    pub ts: i64,
    pub provider: String,
    pub risk: f64,
}

fn history_path() -> std::path::PathBuf {
    config_dir().join("history.jsonl")
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

/// The same "worst window" number the dashboard uses for the collapsed
/// summary badge — one figure per provider per snapshot is enough for a
/// trend line without needing to track every window separately.
pub fn top_risk(u: &Usage) -> Option<f64> {
    let mut best: Option<f64> = None;
    let mut consider = |v: f64| {
        if best.map_or(true, |b| v > b) {
            best = Some(v);
        }
    };
    if let Some(w) = &u.windows {
        for lw in w {
            consider(lw.utilization);
        }
    } else {
        if let Some(w) = &u.session {
            consider(w.utilization);
        }
        if let Some(w) = &u.weekly {
            consider(w.utilization);
        }
        if let Some(w) = &u.weekly_sonnet {
            consider(w.utilization);
        }
        if let Some(w) = &u.weekly_opus {
            consider(w.utilization);
        }
    }
    best
}

static LAST_LOGGED: Mutex<Option<HashMap<String, i64>>> = Mutex::new(None);
static LAST_PRUNE: AtomicI64 = AtomicI64::new(0);

pub fn maybe_log(provider: &str, usage: &Usage) {
    let Some(risk) = top_risk(usage) else { return };
    let ts = now();

    {
        let mut guard = LAST_LOGGED.lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some(&last) = map.get(provider) {
            if ts - last < LOG_INTERVAL_SECS {
                return;
            }
        }
        map.insert(provider.to_string(), ts);
    }

    let point = HistoryPoint { ts, provider: provider.to_string(), risk };
    let dir = config_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(line) = serde_json::to_string(&point) {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(history_path()) {
            let _ = writeln!(f, "{line}");
        }
    }

    let last_prune = LAST_PRUNE.load(Ordering::Relaxed);
    if ts - last_prune >= PRUNE_INTERVAL_SECS {
        LAST_PRUNE.store(ts, Ordering::Relaxed);
        prune(ts);
    }
}

fn prune(ts: i64) {
    let cutoff = ts - RETENTION_DAYS * 86400;
    let Ok(content) = std::fs::read_to_string(history_path()) else { return };
    let kept: Vec<&str> = content
        .lines()
        .filter(|line| {
            serde_json::from_str::<HistoryPoint>(line)
                .map(|p| p.ts >= cutoff)
                .unwrap_or(false)
        })
        .collect();
    let _ = std::fs::write(history_path(), kept.join("\n") + "\n");
}

pub fn read(provider: &str, days: i64) -> Vec<HistoryPoint> {
    let Ok(f) = std::fs::File::open(history_path()) else { return Vec::new() };
    let cutoff = now() - days * 86400;
    BufReader::new(f)
        .lines()
        .filter_map(|l| l.ok())
        .filter_map(|line| serde_json::from_str::<HistoryPoint>(&line).ok())
        .filter(|p| p.provider == provider && p.ts >= cutoff)
        .collect()
}
