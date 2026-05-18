'use strict';

const {
    app, BrowserWindow, Tray, Menu,
    ipcMain, Notification, screen, shell, dialog,
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { autoUpdater } = require('electron-updater');

// ─── Single instance ──────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('com.batradar.app');

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(app.getPath('appData'), 'batradar');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const APIKEY_PATH = path.join(CONFIG_DIR, 'apikey.enc');
const PRELOAD     = path.join(__dirname, 'preload.js');
const ICONS_DIR   = path.join(__dirname, 'src', 'assets', 'icons');
const SRC_DIR     = path.join(__dirname, 'src');

// ─── Credential paths ────────────────────────────────────────────────────────
function getClaudeCredPath() {
    const dirs = [
        process.env.CLAUDE_CONFIG_DIR,
        path.join(os.homedir(), '.claude'),
    ].filter(Boolean);
    for (const dir of dirs) {
        const p = path.join(dir, '.credentials.json');
        if (fs.existsSync(p)) return p;
    }
    return path.join(os.homedir(), '.claude', '.credentials.json');
}

function getCodexCredPath() {
    const dirs = [
        process.env.CODEX_HOME,
        path.join(os.homedir(), '.codex'),
    ].filter(Boolean);
    for (const dir of dirs) {
        const p = path.join(dir, 'auth.json');
        if (fs.existsSync(p)) return p;
    }
    return path.join(os.homedir(), '.codex', 'auth.json');
}

// ─── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    autostart: false,
    poll_interval_seconds: 30,
    alert_threshold: 0.8,
    critical_threshold: 0.95,
    enabled_providers: ['claude', 'codex'],
    floating_position: null,
    notification_enabled: true,
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH))
            return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    } catch {}
    return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    } catch (e) { console.error('saveConfig', e); }
}

// ─── Claude Credentials ──────────────────────────────────────────────────────
function readManualApiKey() {
    try {
        if (fs.existsSync(APIKEY_PATH)) {
            const encoded = fs.readFileSync(APIKEY_PATH, 'utf8').trim();
            return Buffer.from(encoded, 'base64').toString('utf8');
        }
    } catch {}
    return null;
}

function saveManualApiKey(key) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(APIKEY_PATH, Buffer.from(key).toString('base64'));
    } catch (e) { console.error('saveManualApiKey', e); }
}

function deleteManualApiKey() {
    try { if (fs.existsSync(APIKEY_PATH)) fs.unlinkSync(APIKEY_PATH); } catch {}
}

function readClaudeToken() {
    const apiKey = readManualApiKey();
    if (apiKey) return apiKey;
    try {
        const d = JSON.parse(fs.readFileSync(getClaudeCredPath(), 'utf8'));
        return d?.claudeAiOauth?.accessToken || d?.oauth_token || d?.access_token || null;
    } catch { return null; }
}

function readClaudePlan() {
    if (readManualApiKey()) return 'api-key';
    try {
        const d = JSON.parse(fs.readFileSync(getClaudeCredPath(), 'utf8'));
        return d?.claudeAiOauth?.subscriptionType || d?.account_type || null;
    } catch { return null; }
}

function getClaudeAuthMethod() {
    if (readManualApiKey()) return 'api-key';
    try {
        const d = JSON.parse(fs.readFileSync(getClaudeCredPath(), 'utf8'));
        if (d?.claudeAiOauth?.accessToken) return 'oauth';
    } catch {}
    return 'none';
}

// ─── Codex Credentials ───────────────────────────────────────────────────────
function readCodexAuth() {
    try {
        const d = JSON.parse(fs.readFileSync(getCodexCredPath(), 'utf8'));
        const token = d?.tokens?.access_token;
        const accountId = d?.tokens?.account_id;
        if (token && accountId) return { token, accountId };
    } catch {}
    return null;
}

function readCodexPlan() {
    // Check cached usage data first (has plan_type from API)
    if (providerState.codex?.cache?.plan_type) return providerState.codex.cache.plan_type;
    // Fallback: decode JWT
    try {
        const d = JSON.parse(fs.readFileSync(getCodexCredPath(), 'utf8'));
        const idToken = d?.tokens?.id_token;
        if (idToken) {
            const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
            return payload?.['https://api.openai.com/auth']?.chatgpt_plan_type || null;
        }
    } catch {}
    return null;
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function fetchClaudeUsage(token) {
    const isApiKey = token.startsWith('sk-ant-api');
    if (isApiKey) return { _authMethod: 'api-key' };

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) throw new Error('token_expired');
    if (res.status === 429) throw new Error('rate_limited');
    if (!res.ok) throw new Error(`api_error:${res.status}`);
    return res.json();
}

function parseClaudeUsage(raw) {
    const win = (k) => {
        const o = raw[k];
        if (!o || o.utilization == null) return null;
        const util = o.utilization > 1 ? o.utilization / 100 : o.utilization;
        return {
            utilization: Math.min(1, util),
            reset_at: o.resets_at || o.reset_at || null,
        };
    };
    const eu = raw.extra_usage;
    return {
        session:       win('five_hour'),
        weekly:        win('seven_day'),
        weekly_sonnet: win('seven_day_sonnet'),
        weekly_opus:   win('seven_day_opus'),
        extra_usage:   eu && eu.is_enabled
            ? {
                spend: eu.used_credits != null ? eu.used_credits / 100 : 0,
                limit: eu.monthly_limit != null ? eu.monthly_limit / 100 : 0,
                utilization: eu.utilization != null ? (eu.utilization > 1 ? eu.utilization / 100 : eu.utilization) : 0,
                currency: eu.currency || 'USD',
            }
            : null,
        last_updated: new Date().toISOString(),
    };
}

// ─── Codex API ────────────────────────────────────────────────────────────────
async function fetchCodexUsage(token, accountId) {
    // Try /codex/usage first, fallback to /wham/usage
    const urls = [
        'https://chatgpt.com/backend-api/wham/usage',
    ];
    for (const url of urls) {
        try {
            console.log(`[BatRadar][Codex] Trying ${url}`);
            const res = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'ChatGPT-Account-Id': accountId,
                },
                signal: AbortSignal.timeout(15000),
            });
            console.log(`[BatRadar][Codex] ${url} → HTTP ${res.status}`);
            if (res.status === 200) {
                return res.json();
            }
            if (res.status === 429) throw new Error('rate_limited');
            // Try next URL on 401/403
            if (res.status === 401 || res.status === 403) {
                const body = await res.text().catch(() => '');
                console.log(`[BatRadar][Codex] ${res.status} body:`, body.substring(0, 200));
                continue;
            }
            throw new Error(`api_error:${res.status}`);
        } catch (err) {
            if (err.message === 'rate_limited') throw err;
            console.error(`[BatRadar][Codex] ${url} failed:`, err.message);
        }
    }
    throw new Error('token_expired');
}

function parseCodexUsage(raw) {
    const rl = raw.rate_limit || {};
    const pw = rl.primary_window;
    const sw = rl.secondary_window;

    const parseWindow = (w) => {
        if (!w) return null;
        const pct = w.used_percent;
        if (pct == null) return null;
        // Codex used_percent is always integer (1 = 1%, 50 = 50%)
        const util = pct / 100;
        // reset_at is unix timestamp (seconds), convert to ISO
        const resetAt = w.reset_at
            ? new Date(w.reset_at * 1000).toISOString()
            : null;
        return {
            utilization: Math.min(1, util),
            reset_at: resetAt,
        };
    };

    const credits = raw.credits;
    return {
        session: parseWindow(pw),
        weekly:  parseWindow(sw),
        weekly_sonnet: null,
        weekly_opus: null,
        extra_usage: credits && credits.has_credits
            ? { spend: 0, limit: parseFloat(credits.balance) || 0, currency: 'USD' }
            : null,
        plan_type: raw.plan_type || null,
        last_updated: new Date().toISOString(),
    };
}

// ─── Windows ─────────────────────────────────────────────────────────────────
let dashWin, floatWin, settWin, tray;
let floatingIntentionallyHidden = false;

const WP = {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
};

const APP_ICON = path.join(ICONS_DIR, 'icon.ico');

function makeWin(opts, file) {
    const w = new BrowserWindow({ icon: APP_ICON, ...opts, webPreferences: WP });
    w.loadFile(path.join(SRC_DIR, file));
    w.setMenuBarVisibility(false);
    return w;
}

function createFloating() {
    const cfg = loadConfig();
    const { x = 80, y = 80 } = cfg.floating_position || {};
    const SIZE = 62;
    floatWin = new BrowserWindow({
        width: SIZE, height: SIZE, x, y,
        title: '', frame: false, transparent: false,
        backgroundColor: '#0f0f1a', alwaysOnTop: true,
        skipTaskbar: true, resizable: false, movable: false,
        hasShadow: false, roundedCorners: false,
        icon: APP_ICON,
        webPreferences: WP,
    });
    floatWin.loadFile(path.join(SRC_DIR, 'floating.html'));
    floatWin.setMenuBarVisibility(false);
    floatWin.setTitle('');
    floatWin.on('close', e => e.preventDefault());

    // Keep floating above screenshot overlays and other always-on-top windows
    floatWin.setAlwaysOnTop(true, 'screen-saver');

    // Restore visibility if something hides it (e.g. Win+Shift+S),
    // but skip when the user intentionally hid it from the dashboard toggle.
    floatWin.on('hide', () => {
        setTimeout(() => {
            if (floatingIntentionallyHidden) return;
            if (floatWin && !floatWin.isDestroyed() && !floatWin.isVisible()) {
                floatWin.show();
                floatWin.setAlwaysOnTop(true, 'screen-saver');
            }
        }, 1000);
    });
    // Circular shape
    const cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2;
    const rects = [];
    for (let row = 0; row < SIZE; row++) {
        const dy = row - cy + 0.5;
        const halfW = Math.sqrt(Math.max(0, R * R - dy * dy));
        if (halfW > 0) {
            const x0 = Math.floor(cx - halfW);
            const x1 = Math.ceil(cx + halfW);
            rects.push({ x: x0, y: row, width: x1 - x0, height: 1 });
        }
    }
    floatWin.setShape(rects);
    floatWin.on('moved', () => {
        const [px, py] = floatWin.getPosition();
        const c = loadConfig(); c.floating_position = { x: px, y: py }; saveConfig(c);
    });
}

function createDashboard() {
    dashWin = makeWin({ width: 400, height: 560, show: false, resizable: false }, 'index.html');
    dashWin.on('close', e => { e.preventDefault(); dashWin.hide(); });
}

function createSettings() {
    settWin = makeWin({ width: 420, height: 500, show: false, resizable: false }, 'settings.html');
    settWin.on('close', e => { e.preventDefault(); settWin.hide(); });
}

function showDash() { dashWin.show(); dashWin.focus(); }
function showSett() { if (!settWin.isVisible()) settWin.center(); settWin.show(); settWin.focus(); }

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
    tray = new Tray(path.join(ICONS_DIR, 'tray-icon.png'));
    tray.setToolTip('BatRadar');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show Dashboard', click: showDash },
        { label: 'Settings', click: showSett },
        { label: `About BatRadar ${app.getVersion()}`, enabled: false },
        { type: 'separator' },
        { label: 'Exit', click: () => app.exit(0) },
    ]));
    tray.on('click', showDash);
    tray.on('double-click', showDash);
}

function broadcast(ch, data) {
    [dashWin, floatWin, settWin].forEach(w => {
        if (w && !w.isDestroyed()) w.webContents.send(ch, data);
    });
}

// ─── Polling (multi-provider, rate limit safe) ────────────────────────────────
let pollTimer = null;
const providerState = {
    claude: { cache: null, extraDelay: 0, lastPollAt: 0, alertSt: {} },
    codex:  { cache: null, extraDelay: 0, lastPollAt: 0, alertSt: {} },
};

async function pollClaude() {
    const st = providerState.claude;
    const now = Date.now();
    // Rate limit guard: minimum 30s between API calls
    if (now - st.lastPollAt < 30000) {
        console.log('[BatRadar][Claude] Skipped — too soon since last poll');
        return;
    }
    const token = readClaudeToken();
    if (!token) {
        broadcast('provider-status-changed', { provider: 'claude', status: 'disconnected' });
        return;
    }
    try {
        st.lastPollAt = now;
        const raw  = await fetchClaudeUsage(token);
        const data = parseClaudeUsage(raw);
        st.cache = data;
        st.extraDelay = 0;
        broadcast('usage-update', { provider: 'claude', data });
        broadcast('provider-status-changed', { provider: 'claude', status: 'connected' });
        checkAlerts('claude', data, loadConfig());
        console.log(`[BatRadar][Claude] OK — session=${data.session?.utilization ?? 'n/a'}`);
    } catch (err) {
        console.error('[BatRadar][Claude] Error:', err.message);
        if (err.message === 'token_expired') {
            broadcast('provider-status-changed', { provider: 'claude', status: 'expired' });
        } else if (err.message === 'rate_limited') {
            st.extraDelay = Math.min((st.extraDelay || 30) * 2, 300);
            console.log(`[BatRadar][Claude] Rate limited, extra delay: ${st.extraDelay}s`);
        } else {
            broadcast('provider-status-changed', { provider: 'claude', status: 'error' });
        }
    }
}

async function pollCodex() {
    const st = providerState.codex;
    const now = Date.now();
    console.log(`[BatRadar][Codex] Polling... lastPollAt=${st.lastPollAt}, diff=${now - st.lastPollAt}ms`);
    if (st.lastPollAt > 0 && now - st.lastPollAt < 30000) {
        console.log('[BatRadar][Codex] Skipped — too soon since last poll');
        return;
    }
    const auth = readCodexAuth();
    console.log(`[BatRadar][Codex] Auth: ${auth ? 'found (accountId=' + auth.accountId.substring(0,8) + '...)' : 'NOT FOUND'}`);
    if (!auth) {
        broadcast('provider-status-changed', { provider: 'codex', status: 'disconnected' });
        return;
    }
    try {
        st.lastPollAt = now;
        const raw  = await fetchCodexUsage(auth.token, auth.accountId);
        console.log('[BatRadar][Codex] RAW:', JSON.stringify(raw, null, 2));
        const data = parseCodexUsage(raw);
        st.cache = data;
        st.extraDelay = 0;
        broadcast('usage-update', { provider: 'codex', data });
        broadcast('provider-status-changed', { provider: 'codex', status: 'connected' });
        checkAlerts('codex', data, loadConfig());
        console.log(`[BatRadar][Codex] OK — session=${data.session?.utilization ?? 'n/a'}`);
    } catch (err) {
        console.error('[BatRadar][Codex] Error:', err.message);
        if (err.message === 'token_expired') {
            broadcast('provider-status-changed', { provider: 'codex', status: 'expired' });
        } else if (err.message === 'rate_limited') {
            st.extraDelay = Math.min((st.extraDelay || 30) * 2, 300);
        } else {
            broadcast('provider-status-changed', { provider: 'codex', status: 'error' });
        }
    }
}

async function doPoll() {
    const cfg = loadConfig();
    const enabled = cfg.enabled_providers || ['claude', 'codex'];
    // Run all providers in parallel — don't wait for one to finish before starting next
    const tasks = [];
    if (enabled.includes('claude')) tasks.push(pollClaude());
    if (enabled.includes('codex'))  tasks.push(pollCodex());
    await Promise.allSettled(tasks);
}

function startPolling() {
    stopPolling();
    const cfg = loadConfig();
    // Delay first poll by 5 seconds to avoid rate limit on restart
    console.log('[BatRadar] First poll in 5 seconds...');
    setTimeout(() => {
        doPoll();
        pollTimer = setInterval(doPoll, cfg.poll_interval_seconds * 1000);
    }, 5000);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── Alerts ───────────────────────────────────────────────────────────────────
function checkAlerts(provider, data, cfg) {
    if (!cfg.notification_enabled) return;
    const { session } = data;
    if (!session) return;
    const key = `${provider}_session`;
    const st = providerState[provider]?.alertSt || {};
    if (!st[key] || st[key].resetAt !== session.reset_at)
        st[key] = { resetAt: session.reset_at };
    const a = st[key];
    const util = session.utilization;
    const pct  = Math.round(util * 100);
    const secs = Math.max(0, Math.floor((new Date(session.reset_at) - Date.now()) / 1000));
    const rst  = fmtDur(secs);
    const name = provider === 'claude' ? 'Claude Code' : 'Codex';

    if      (util >= 1.0            && !a.limit) { a.limit = true; toast(name, 'Limit Reached', `Session full! Resets in ${rst}`); }
    else if (util >= cfg.critical_threshold && !a.crit) { a.crit = true; toast(name, 'Critical', `Session ${pct}%! Resets in ${rst}`); }
    else if (util >= cfg.alert_threshold    && !a.warn) { a.warn = true; toast(name, 'Warning', `Session ${pct}%. Resets in ${rst}`); }
}

function toast(provider, sub, body) {
    if (Notification.isSupported())
        new Notification({ title: `${provider} – ${sub}`, body }).show();
}

function fmtDur(s) {
    if (s <= 0) return 'now';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
function setupIPC() {
    ipcMain.handle('get_providers', () => {
        const cfg = loadConfig();
        const enabled = cfg.enabled_providers || ['claude', 'codex'];
        const claudeToken = readClaudeToken();
        const claudePlan  = readClaudePlan();
        const claudeAuth  = getClaudeAuthMethod();
        const codexAuth   = readCodexAuth();
        const codexPlan   = readCodexPlan();
        const claudeStatus = !enabled.includes('claude') ? 'disabled'
                           : claudeToken ? 'connected' : 'disconnected';
        const codexStatus  = !enabled.includes('codex') ? 'disabled'
                           : codexAuth ? 'connected' : 'disconnected';
        return [
            { id: 'claude', name: 'Claude Code', icon: 'claude', plan: claudePlan, status: claudeStatus, auth: claudeAuth, error: null },
            { id: 'codex',  name: 'Codex',       icon: 'codex',  plan: codexPlan,  status: codexStatus,  auth: codexAuth ? 'oauth' : 'none', error: null },
            { id: 'gemini', name: 'Gemini CLI',   icon: 'gemini', plan: null, status: 'disconnected', auth: 'none', error: null },
        ];
    });

    ipcMain.handle('get_usage', async (_, { provider }) => {
        const st = providerState[provider];
        if (!st) throw new Error('Not supported');
        if (st.cache) return st.cache;
        throw new Error('Waiting for data…');
    });

    ipcMain.handle('load_settings', () => loadConfig());
    ipcMain.handle('save_settings', (_, { settings }) => {
        saveConfig(settings);
        app.setLoginItemSettings({ openAtLogin: !!settings.autostart });
        stopPolling(); startPolling();
    });

    ipcMain.handle('show_dashboard', () => showDash());
    ipcMain.handle('hide_dashboard', () => dashWin.hide());
    ipcMain.handle('show_settings',  () => showSett());
    ipcMain.handle('hide_settings',  () => settWin.hide());

    ipcMain.handle('check_credential', (_, { provider }) => {
        if (provider === 'claude') {
            const t = readClaudeToken();
            const m = getClaudeAuthMethod();
            return t ? { found: true, valid: true, method: m, message: m === 'api-key' ? 'API Key' : 'OAuth' }
                     : { found: false, valid: false, method: 'none', message: "Run 'claude login'" };
        }
        if (provider === 'codex') {
            const a = readCodexAuth();
            return a ? { found: true, valid: true, method: 'oauth', message: 'OAuth token found' }
                     : { found: false, valid: false, method: 'none', message: "Run 'codex' and login" };
        }
        return { found: false, valid: false, method: 'none', message: 'Not supported' };
    });

    ipcMain.handle('save_api_key', (_, { key }) => {
        if (!key || !key.trim()) throw new Error('Empty key');
        saveManualApiKey(key.trim());
        providerState.claude.cache = null;
        stopPolling(); startPolling();
        return { success: true };
    });

    ipcMain.handle('remove_api_key', () => {
        deleteManualApiKey();
        providerState.claude.cache = null;
        stopPolling(); startPolling();
        return { success: true };
    });

    ipcMain.handle('get_auth_method', () => getClaudeAuthMethod());

    ipcMain.handle('disconnect_provider', (_, { provider }) => {
        const cfg = loadConfig();
        cfg.enabled_providers = (cfg.enabled_providers || ['claude', 'codex'])
            .filter(p => p !== provider);
        saveConfig(cfg);
        if (provider === 'claude') deleteManualApiKey();
        if (providerState[provider]) {
            providerState[provider].cache = null;
            providerState[provider].alertSt = {};
            providerState[provider].lastPollAt = 0;
        }
        broadcast('provider-status-changed', { provider, status: 'disabled' });
        stopPolling(); startPolling();
        return null;
    });

    ipcMain.handle('reconnect_provider', (_, { provider }) => {
        const cfg = loadConfig();
        const enabled = new Set(cfg.enabled_providers || ['claude', 'codex']);
        enabled.add(provider);
        cfg.enabled_providers = Array.from(enabled);
        saveConfig(cfg);
        stopPolling(); startPolling();
        return null;
    });

    ipcMain.handle('set_autostart', (_, { enabled }) => {
        app.setLoginItemSettings({ openAtLogin: !!enabled });
    });

    ipcMain.handle('save_position', (_, { x, y }) => {
        const c = loadConfig(); c.floating_position = { x, y }; saveConfig(c);
    });

    ipcMain.handle('get_floating_position', () => {
        if (floatWin && !floatWin.isDestroyed()) {
            const [x, y] = floatWin.getPosition();
            return { x, y };
        }
        return loadConfig().floating_position;
    });

    ipcMain.handle('set_floating_pos', (_, { x, y }) => {
        if (floatWin && !floatWin.isDestroyed())
            floatWin.setPosition(Math.round(x), Math.round(y));
    });

    ipcMain.handle('move_floating', (_, { dx, dy }) => {
        if (floatWin && !floatWin.isDestroyed()) {
            const [cx, cy] = floatWin.getPosition();
            floatWin.setPosition(cx + dx, cy + dy);
        }
    });

    ipcMain.handle('set_float_interactive', () => {});

    ipcMain.handle('show_floating', () => {
        floatingIntentionallyHidden = false;
        if (!floatWin || floatWin.isDestroyed()) { createFloating(); return; }
        const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;
        const [x, y] = floatWin.getPosition();
        if (x < 0 || y < 0 || x > width || y > height) floatWin.setPosition(80, 80);
        floatWin.show();
    });

    ipcMain.handle('hide_floating', () => {
        floatingIntentionallyHidden = true;
        floatWin?.hide();
    });

    // Display toggle — which providers show on floating icon
    ipcMain.handle('get_display_providers', () => {
        const cfg = loadConfig();
        return cfg.display_providers || null; // null = show all
    });

    ipcMain.handle('set_display_providers', (_, { providers }) => {
        const cfg = loadConfig();
        cfg.display_providers = providers;
        saveConfig(cfg);
        broadcast('display-providers-changed', { providers });
    });

    // Open URL in default browser
    ipcMain.handle('open_external', (_, { url }) => {
        if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
            shell.openExternal(url);
        }
    });

    ipcMain.handle('check_for_updates', () => checkForUpdatesManual());

    ipcMain.handle('get_app_version', () => app.getVersion());
}

// ─── Auto Update ──────────────────────────────────────────────────────────────
let updateCheckInFlight = false;
let updateDeclinedForThisVersion = null;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = { info: (...a) => console.log('[Updater]', ...a),
                      warn: (...a) => console.warn('[Updater]', ...a),
                      error: (...a) => console.error('[Updater]', ...a),
                      debug: () => {} };

autoUpdater.on('update-available', async (info) => {
    if (updateDeclinedForThisVersion === info.version) return;
    const owner = dashWin && !dashWin.isDestroyed() ? dashWin : null;
    const { response } = await dialog.showMessageBox(owner, {
        type: 'info',
        title: 'BatRadar — Có phiên bản mới',
        message: `BatRadar ${info.version} đã có.`,
        detail: `Phiên bản hiện tại: ${app.getVersion()}\n\nBấm "Cập nhật" để tải về và cài đặt.`,
        buttons: ['Cập nhật', 'Để sau'],
        defaultId: 0,
        cancelId: 1,
    });
    if (response === 0) {
        autoUpdater.downloadUpdate().catch(err => {
            console.error('[Updater] downloadUpdate failed:', err);
            dialog.showErrorBox('Tải thất bại', String(err?.message || err));
        });
    } else {
        updateDeclinedForThisVersion = info.version;
    }
});

autoUpdater.on('update-not-available', () => {
    if (updateCheckInFlight === 'manual') {
        dialog.showMessageBox({
            type: 'info',
            title: 'BatRadar',
            message: 'Bạn đang dùng phiên bản mới nhất.',
            detail: `Phiên bản: ${app.getVersion()}`,
            buttons: ['OK'],
        });
    }
});

autoUpdater.on('download-progress', (p) => {
    const pct = Math.round(p.percent);
    console.log(`[Updater] Downloading… ${pct}%`);
    broadcast('update-download-progress', { percent: pct });
});

autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'BatRadar — Sẵn sàng cài',
        message: `Phiên bản ${info.version} đã tải xong.`,
        detail: 'App sẽ khởi động lại để cài đặt phiên bản mới.',
        buttons: ['Khởi động lại ngay', 'Khi tắt app'],
        defaultId: 0,
        cancelId: 1,
    });
    if (response === 0) {
        setImmediate(() => autoUpdater.quitAndInstall(false, true));
    }
});

autoUpdater.on('error', (err) => {
    console.error('[Updater] error:', err?.message || err);
    if (updateCheckInFlight === 'manual') {
        dialog.showErrorBox('Không kiểm tra được cập nhật', String(err?.message || err));
    }
    updateCheckInFlight = false;
});

autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking…');
});

function checkForUpdatesSilent() {
    if (!app.isPackaged) {
        console.log('[Updater] Skip — running unpackaged (dev mode)');
        return;
    }
    if (updateCheckInFlight) return;
    updateCheckInFlight = 'auto';
    autoUpdater.checkForUpdates()
        .catch(err => console.error('[Updater] check failed:', err?.message || err))
        .finally(() => { updateCheckInFlight = false; });
}

function checkForUpdatesManual() {
    if (!app.isPackaged) {
        dialog.showMessageBox({
            type: 'info',
            title: 'BatRadar',
            message: 'Auto-update chỉ chạy trên bản đã đóng gói.',
            detail: 'Đang chạy từ source (dev) — không kiểm tra được.',
            buttons: ['OK'],
        });
        return;
    }
    if (updateCheckInFlight) return;
    updateCheckInFlight = 'manual';
    autoUpdater.checkForUpdates()
        .catch(err => console.error('[Updater] manual check failed:', err?.message || err))
        .finally(() => { updateCheckInFlight = false; });
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
    createFloating();
    createDashboard();
    createSettings();
    createTray();
    setupIPC();
    startPolling();
    setTimeout(() => { dashWin.show(); dashWin.center(); dashWin.focus(); }, 400);
    // Check for updates 10s after startup so it doesn't compete with initial polling
    setTimeout(checkForUpdatesSilent, 10000);
});

app.on('second-instance', showDash);
app.on('window-all-closed', () => { /* keep alive via tray */ });
