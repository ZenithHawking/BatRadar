'use strict';

const {
    app, BrowserWindow, Tray, Menu,
    ipcMain, Notification, screen, shell, dialog,
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execFileSync } = require('child_process');
const { autoUpdater } = require('electron-updater');

// ─── Single instance ──────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('com.batradar.app');

// Windows marks the tiny transparent overlay as "occluded" when focus moves
// elsewhere and stops compositing it — the transparent area then falls back
// to the window's white base layer (white strip/flash). Disable the tracker.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Software rendering: the GPU compositing path still flashes the transparent
// overlay white during fast window switching; the software path doesn't.
// UI is tiny (progress bars + one 62px overlay), so the cost is negligible.
app.disableHardwareAcceleration();

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(app.getPath('appData'), 'batradar');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const APIKEY_PATH = path.join(CONFIG_DIR, 'apikey.enc');
const ORKEY_PATH  = path.join(CONFIG_DIR, 'openrouter.enc');
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

function getGeminiCredPath() {
    return path.join(os.homedir(), '.gemini', 'oauth_creds.json');
}

// ─── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    autostart: false,
    poll_interval_seconds: 30,
    alert_threshold: 0.8,
    critical_threshold: 0.95,
    enabled_providers: ['claude', 'codex', 'gemini', 'copilot', 'openrouter', 'antigravity'],
    floating_position: null,
    notification_enabled: true,
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
            // One-time migration: enable providers added after the config was
            // first saved, then respect the user's disconnect choice
            const known = ['gemini', 'copilot', 'openrouter', 'antigravity'];
            const migrated = cfg.migrated_providers || (cfg.gemini_migrated ? ['gemini'] : []);
            const missing = known.filter(p => !migrated.includes(p));
            if (missing.length) {
                if (Array.isArray(cfg.enabled_providers))
                    for (const p of missing)
                        if (!cfg.enabled_providers.includes(p)) cfg.enabled_providers.push(p);
                cfg.migrated_providers = [...migrated, ...missing];
                saveConfig(cfg);
            }
            return cfg;
        }
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

// ─── Copilot Credentials ─────────────────────────────────────────────────────
function getCopilotToken() {
    // Editor plugins (VS Code / JetBrains / Neovim) write apps.json (older: hosts.json)
    const dirs = [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'github-copilot'),
        path.join(os.homedir(), '.config', 'github-copilot'),
    ].filter(Boolean);
    for (const dir of dirs) {
        for (const file of ['apps.json', 'hosts.json']) {
            try {
                const d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
                for (const k of Object.keys(d))
                    if (k.startsWith('github.com') && d[k]?.oauth_token) return d[k].oauth_token;
            } catch {}
        }
    }
    // Fallback: GitHub CLI token (gh auth login)
    const ghFiles = [
        process.env.APPDATA && path.join(process.env.APPDATA, 'GitHub CLI', 'hosts.yml'),
        path.join(os.homedir(), '.config', 'gh', 'hosts.yml'),
    ].filter(Boolean);
    for (const f of ghFiles) {
        try {
            const m = fs.readFileSync(f, 'utf8').match(/oauth_token:\s*(\S+)/);
            if (m) return m[1];
        } catch {}
    }
    return getGhCliToken();
}

// gh stores its token in Windows Credential Manager by default (no file to
// read) — `gh auth token` prints it. Cached: spawning a process every poll
// would be wasteful, and the token only changes on re-login.
let ghCliToken = { token: null, at: 0 };
function getGhCliToken() {
    const now = Date.now();
    if (now - ghCliToken.at < 10 * 60 * 1000) return ghCliToken.token;
    ghCliToken.at = now;
    ghCliToken.token = null;
    const bins = [
        'gh',
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
    ];
    for (const bin of bins) {
        try {
            const out = execFileSync(bin, ['auth', 'token'],
                { timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
                .toString().trim();
            if (out) { ghCliToken.token = out; break; }
        } catch {}
    }
    return ghCliToken.token;
}

// ─── OpenRouter Credentials (user-entered API key) ───────────────────────────
function readOpenrouterKey() {
    try {
        if (fs.existsSync(ORKEY_PATH))
            return Buffer.from(fs.readFileSync(ORKEY_PATH, 'utf8').trim(), 'base64').toString('utf8');
    } catch {}
    return process.env.OPENROUTER_API_KEY || null;
}

function saveOpenrouterKey(key) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(ORKEY_PATH, Buffer.from(key).toString('base64'));
}

function deleteOpenrouterKey() {
    try { if (fs.existsSync(ORKEY_PATH)) fs.unlinkSync(ORKEY_PATH); } catch {}
}

// ─── Gemini Credentials ──────────────────────────────────────────────────────
function readGeminiAuth() {
    try {
        const d = JSON.parse(fs.readFileSync(getGeminiCredPath(), 'utf8'));
        if (d?.access_token) return { token: d.access_token, expiryDate: d.expiry_date || 0 };
    } catch {}
    return null;
}

// ─── OAuth token refresh ──────────────────────────────────────────────────────
// Public OAuth client IDs of the official CLIs (same ones they use to log in)
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CODEX_OAUTH_CLIENT_ID  = 'app_EMoamEEZ73f0CkXaXp7hrann';
// Installed-app client of gemini-cli — the "secret" is public by design
// (shipped in the open-source repo, packages/core/src/code_assist/oauth2.ts)
const GEMINI_OAUTH_CLIENT_ID     = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_OAUTH_CLIENT_SECRET = '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';

// Write via temp file + rename so the CLI never sees a half-written file
function atomicWriteJson(file, obj) {
    const tmp = `${file}.batradar-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}

async function refreshClaudeToken() {
    const credPath = getClaudeCredPath();
    const d = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const rt = d?.claudeAiOauth?.refreshToken;
    if (!rt) throw new Error('no_refresh_token');
    const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: rt,
            client_id: CLAUDE_OAUTH_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`refresh_failed:${res.status}`);
    const tok = await res.json();
    if (!tok.access_token) throw new Error('refresh_failed:no_access_token');
    d.claudeAiOauth.accessToken = tok.access_token;
    if (tok.refresh_token) d.claudeAiOauth.refreshToken = tok.refresh_token;
    if (tok.expires_in)    d.claudeAiOauth.expiresAt = Date.now() + tok.expires_in * 1000;
    atomicWriteJson(credPath, d);
    console.log('[BatRadar][Claude] Token refreshed, new expiry:', new Date(d.claudeAiOauth.expiresAt).toISOString());
    return tok.access_token;
}

async function refreshCodexToken() {
    const credPath = getCodexCredPath();
    const d = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const rt = d?.tokens?.refresh_token;
    if (!rt) throw new Error('no_refresh_token');
    const res = await fetch('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: rt,
            client_id: CODEX_OAUTH_CLIENT_ID,
            scope: 'openid profile email',
        }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`refresh_failed:${res.status}`);
    const tok = await res.json();
    if (!tok.access_token) throw new Error('refresh_failed:no_access_token');
    d.tokens.access_token = tok.access_token;
    if (tok.id_token)      d.tokens.id_token = tok.id_token;
    if (tok.refresh_token) d.tokens.refresh_token = tok.refresh_token;
    d.last_refresh = new Date().toISOString();
    atomicWriteJson(credPath, d);
    console.log('[BatRadar][Codex] Token refreshed');
    return { token: d.tokens.access_token, accountId: d.tokens.account_id };
}

async function refreshGeminiToken() {
    const credPath = getGeminiCredPath();
    const d = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const rt = d?.refresh_token;
    if (!rt) throw new Error('no_refresh_token');
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: rt,
            client_id: GEMINI_OAUTH_CLIENT_ID,
            client_secret: GEMINI_OAUTH_CLIENT_SECRET,
        }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`refresh_failed:${res.status}`);
    const tok = await res.json();
    if (!tok.access_token) throw new Error('refresh_failed:no_access_token');
    d.access_token = tok.access_token;
    if (tok.id_token)   d.id_token = tok.id_token;
    if (tok.expires_in) d.expiry_date = Date.now() + tok.expires_in * 1000;
    atomicWriteJson(credPath, d);
    console.log('[BatRadar][Gemini] Token refreshed');
    return d.access_token;
}

// One refresh attempt per provider per 5 minutes — a rejected fresh token
// means re-login is genuinely needed, don't hammer the auth server
async function tryRefresh(provider, st) {
    const now = Date.now();
    if (now - (st.lastRefreshAt || 0) < 5 * 60 * 1000) return false;
    st.lastRefreshAt = now;
    try {
        console.log(`[BatRadar][${provider}] Access token expired — attempting refresh…`);
        if (provider === 'claude')      await refreshClaudeToken();
        else if (provider === 'gemini') await refreshGeminiToken();
        else                            await refreshCodexToken();
        return true;
    } catch (e) {
        console.error(`[BatRadar][${provider}] Refresh failed:`, e.message);
        return false;
    }
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
        // API returns utilization as a percentage (0-100)
        const util = o.utilization / 100;
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
                utilization: eu.utilization != null ? eu.utilization / 100 : 0,
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
    let sawAuthError = false;
    let lastErr = null;
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
                sawAuthError = true;
                const body = await res.text().catch(() => '');
                console.log(`[BatRadar][Codex] ${res.status} body:`, body.substring(0, 200));
                continue;
            }
            throw new Error(`api_error:${res.status}`);
        } catch (err) {
            if (err.message === 'rate_limited') throw err;
            lastErr = err;
            console.error(`[BatRadar][Codex] ${url} failed:`, err.message);
        }
    }
    // Only report an expired token when the API actually rejected it —
    // network failures / 5xx must surface as generic errors, not "expired"
    if (sawAuthError) throw new Error('token_expired');
    throw lastErr || new Error('api_error:unknown');
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

// ─── Gemini API (Code Assist) ────────────────────────────────────────────────
const GEMINI_API_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';

async function geminiPost(method, token, body) {
    const res = await fetch(`${GEMINI_API_BASE}:${method}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) throw new Error('token_expired');
    if (res.status === 429) throw new Error('rate_limited');
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.log(`[BatRadar][Gemini] ${method} → HTTP ${res.status}:`, txt.substring(0, 200));
        throw new Error(`api_error:${res.status}`);
    }
    return res.json();
}

// Project ID + tier come from loadCodeAssist; cached until app restart
async function getGeminiProject(token) {
    const st = providerState.gemini;
    if (st.projectId != null) return st.projectId;
    const envProject = process.env.GOOGLE_CLOUD_PROJECT || undefined;
    const raw = await geminiPost('loadCodeAssist', token, {
        cloudaicompanionProject: envProject,
        metadata: { ideType: 'GEMINI_CLI', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    });
    st.plan = raw?.currentTier?.name || raw?.currentTier?.id || null;
    st.projectId = raw?.cloudaicompanionProject || envProject || '';
    return st.projectId;
}

async function fetchGeminiUsage(token) {
    const project = await getGeminiProject(token);
    return geminiPost('retrieveUserQuota', token, { project });
}

function parseGeminiUsage(raw) {
    // Response: { buckets: [{ remainingFraction, resetTime, modelId, tokenType }] }
    // Quotas are daily; keep the most-used bucket per model
    const perModel = new Map();
    for (const b of raw?.buckets || []) {
        if (b.remainingFraction == null) continue;
        const key = b.modelId || 'All models';
        const cur = perModel.get(key);
        if (!cur || b.remainingFraction < cur.remainingFraction) perModel.set(key, b);
    }
    const windows = [...perModel.entries()]
        .map(([model, b]) => ({
            label: `${model} (daily)`,
            utilization: Math.min(1, Math.max(0, 1 - b.remainingFraction)),
            reset_at: b.resetTime || null,
        }))
        .sort((a, b) => b.utilization - a.utilization);
    return {
        // Highest-used quota drives the floating icon and alerts
        session: windows[0] ? { utilization: windows[0].utilization, reset_at: windows[0].reset_at } : null,
        weekly: null, weekly_sonnet: null, weekly_opus: null,
        extra_usage: null,
        windows: windows.length ? windows : null,
        last_updated: new Date().toISOString(),
    };
}

// ─── Copilot API ─────────────────────────────────────────────────────────────
async function fetchCopilotUsage(token) {
    const res = await fetch('https://api.github.com/copilot_internal/user', {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/json',
            'Editor-Version': 'vscode/1.101.0',
            'Editor-Plugin-Version': 'copilot-chat/0.27.0',
            'User-Agent': 'GitHubCopilotChat/0.27.0',
            'X-GitHub-Api-Version': '2025-04-01',
        },
        signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) throw new Error('token_expired');
    if (res.status === 429) throw new Error('rate_limited');
    if (!res.ok) throw new Error(`api_error:${res.status}`);
    return res.json();
}

function parseCopilotUsage(raw) {
    // quota_snapshots buckets report percent REMAINING; reset date is account-wide
    const LABELS = {
        premium_interactions: 'Premium requests',
        premium_requests:     'Premium requests',
        credits:              'Credits',
        chat:                 'Chat',
        completions:          'Completions',
    };
    const resetAt = raw?.quota_reset_date
        ? new Date(`${raw.quota_reset_date}T00:00:00Z`).toISOString()
        : null;
    const windows = [];
    for (const [key, s] of Object.entries(raw?.quota_snapshots || {})) {
        if (!s || s.unlimited || s.percent_remaining == null) continue;
        // Buckets the plan doesn't include report entitlement 0 / has_quota false
        // with percent_remaining 0 — that's "no quota", not "quota exhausted"
        if (s.has_quota === false || (s.entitlement != null && s.entitlement <= 0)) continue;
        windows.push({
            label: LABELS[key] || key,
            utilization: Math.min(1, Math.max(0, 1 - s.percent_remaining / 100)),
            reset_at: resetAt,
        });
    }
    windows.sort((a, b) => b.utilization - a.utilization);
    return {
        session: windows[0] ? { utilization: windows[0].utilization, reset_at: windows[0].reset_at } : null,
        weekly: null, weekly_sonnet: null, weekly_opus: null,
        extra_usage: null,
        windows: windows.length ? windows : null,
        // access_type_sku distinguishes the free tier; copilot_plan reads
        // "individual" even on free_limited_copilot
        plan_type: (raw?.access_type_sku || '').includes('free') ? 'free'
                 : raw?.copilot_plan || raw?.access_type_sku || null,
        last_updated: new Date().toISOString(),
    };
}

// ─── OpenRouter API ──────────────────────────────────────────────────────────
async function fetchOpenrouterUsage(key) {
    const headers = { 'Authorization': `Bearer ${key}` };
    const res = await fetch('https://openrouter.ai/api/v1/credits', {
        headers, signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) throw new Error('token_expired');
    if (res.status === 429) throw new Error('rate_limited');
    if (!res.ok) throw new Error(`api_error:${res.status}`);
    const credits = (await res.json())?.data || {};
    // /key is best-effort: tier + per-key cap; balance still renders without it
    let keyInfo = null;
    try {
        const kres = await fetch('https://openrouter.ai/api/v1/key', {
            headers, signal: AbortSignal.timeout(15000),
        });
        if (kres.ok) keyInfo = (await kres.json())?.data || null;
    } catch {}
    return { credits, keyInfo };
}

function parseOpenrouterUsage(raw) {
    const total = raw.credits?.total_credits ?? 0;
    const used  = raw.credits?.total_usage ?? 0;
    const windows = [];
    if (raw.keyInfo?.limit > 0) {
        windows.push({
            label: 'Key limit',
            utilization: Math.min(1, (raw.keyInfo.usage || 0) / raw.keyInfo.limit),
            reset_at: null,
        });
    }
    windows.push({
        label: 'Credits used',
        utilization: total > 0 ? Math.min(1, used / total) : 0,
        reset_at: null,
    });
    return {
        session: { utilization: windows[0].utilization, reset_at: null },
        weekly: null, weekly_sonnet: null, weekly_opus: null,
        extra_usage: { spend: used, limit: total, currency: 'USD' },
        windows,
        plan_type: raw.keyInfo ? (raw.keyInfo.is_free_tier ? 'free' : 'paid') : null,
        last_updated: new Date().toISOString(),
    };
}

// ─── Antigravity (local language server) ─────────────────────────────────────
// The Antigravity app runs a local language_server.exe exposing the same quota
// data as its Model Quota UI. Discovery: find the process, read --csrf_token
// from its command line, then probe its listening ports. Cached until a call
// fails (app restart changes the random port).

const AG_RPC = 'exa.language_server_pb.LanguageServerService';
const AG_BODY = { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } };

async function agPost(port, csrf, method) {
    const res = await fetch(`http://127.0.0.1:${port}/${AG_RPC}/${method}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Codeium-Csrf-Token': csrf,
            'Connect-Protocol-Version': '1',
        },
        body: JSON.stringify(AG_BODY),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`api_error:${res.status}`);
    return res.json();
}

async function discoverAntigravity() {
    let procs = '';
    try {
        procs = execFileSync('powershell.exe', ['-NoProfile', '-Command',
            `Get-CimInstance Win32_Process -Filter "name='language_server.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`],
            { timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch { return null; }
    for (const line of procs.split(/\r?\n/)) {
        const sep = line.indexOf('|');
        if (sep < 0) continue;
        const pid = line.slice(0, sep).trim();
        const cmd = line.slice(sep + 1);
        // --app_data_dir antigravity is the app's server; antigravity-ide lacks the quota endpoint
        if (!/--app_data_dir antigravity(\s|$)/.test(cmd)) continue;
        const csrf = cmd.match(/--csrf_token\s+(\S+)/)?.[1];
        if (!csrf) continue;
        let net = '';
        try {
            net = execFileSync('netstat', ['-ano'],
                { timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        } catch { continue; }
        const ports = [...new Set(net.split(/\r?\n/)
            .filter(l => l.includes('LISTENING') && l.trim().endsWith(pid))
            .map(l => l.match(/127\.0\.0\.1:(\d+)/)?.[1])
            .filter(Boolean))];
        // The HTTPS/gRPC port rejects plain HTTP; the HTTP port answers the quota call
        for (const port of ports) {
            try {
                const raw = await agPost(port, csrf, 'RetrieveUserQuotaSummary');
                if (raw?.response?.groups) return { port, csrf, raw };
            } catch {}
        }
    }
    return null;
}

function parseAntigravityUsage(raw) {
    const windows = [];
    for (const g of raw?.response?.groups || []) {
        const group = g.displayName === 'Gemini Models' ? 'Gemini'
                    : /claude/i.test(g.displayName || '') ? 'Claude + GPT'
                    : g.displayName || 'Models';
        for (const b of g.buckets || []) {
            // proto3 JSON omits zero fields — a missing remainingFraction means exhausted
            const remaining = b.remainingFraction ?? 0;
            windows.push({
                label: `${group} (${b.window === '5h' ? '5h' : 'weekly'})`,
                utilization: Math.min(1, Math.max(0, 1 - remaining)),
                reset_at: b.resetTime || null,
            });
        }
    }
    const most = windows.slice().sort((a, b) => b.utilization - a.utilization)[0];
    return {
        session: most ? { utilization: most.utilization, reset_at: most.reset_at } : null,
        weekly: null, weekly_sonnet: null, weekly_opus: null,
        extra_usage: null,
        windows: windows.length ? windows : null,
        last_updated: new Date().toISOString(),
    };
}

async function pollAntigravity() {
    const st = providerState.antigravity;
    const now = Date.now();
    const minGap = 30000 + (st.extraDelay || 0) * 1000;
    if (st.lastPollAt > 0 && now - st.lastPollAt < minGap) return;
    try {
        st.lastPollAt = now;
        let raw = null;
        if (st.server) {
            try {
                raw = await agPost(st.server.port, st.server.csrf, 'RetrieveUserQuotaSummary');
            } catch { st.server = null; }   // app restarted — rediscover below
        }
        if (!st.server) {
            st.server = await discoverAntigravity();
            if (!st.server) {
                broadcast('provider-status-changed', { provider: 'antigravity', status: 'disconnected' });
                return;
            }
            raw = st.server.raw;
            // Best-effort plan name from GetUserStatus (e.g. "Pro")
            agPost(st.server.port, st.server.csrf, 'GetUserStatus')
                .then(s => { st.plan = s?.userStatus?.planStatus?.planInfo?.planName || st.plan; })
                .catch(() => {});
        }
        const data = parseAntigravityUsage(raw);
        st.cache = data;
        st.extraDelay = 0;
        broadcast('usage-update', { provider: 'antigravity', data });
        broadcast('provider-status-changed', { provider: 'antigravity', status: 'connected' });
        checkAlerts('antigravity', data, loadConfig());
        console.log(`[BatRadar][Antigravity] OK — session=${data.session?.utilization ?? 'n/a'}`);
    } catch (err) {
        console.error('[BatRadar][Antigravity] Error:', err.message);
        broadcast('provider-status-changed', { provider: 'antigravity', status: 'error' });
    }
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
    // Dark base layer — without it the window flashes white on show/activate
    // before Chromium paints the UI
    const w = new BrowserWindow({ icon: APP_ICON, backgroundColor: '#0a0a0f', ...opts, webPreferences: WP });
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
        // Truly transparent window: the circle is drawn by CSS with
        // antialiased edges — no black fringing on light backgrounds
        title: '', frame: false, transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        // Never take focus: prevents the white DWM caption strip on activation,
        // keeps the icon out of Alt+Tab, and stops it stealing focus from the
        // app the user is working in. Mouse events still work.
        focusable: false,
        skipTaskbar: true, resizable: false, movable: false,
        hasShadow: false, roundedCorners: false,
        icon: APP_ICON,
        // Never throttle the overlay's renderer — a throttled transparent
        // window repaints as a white rectangle until the next frame
        webPreferences: { ...WP, backgroundThrottling: false },
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
    // Keep-alive repaint: Chromium evicts the last frame of small occluded
    // windows during window switching, leaving the white base layer on screen.
    // The icon is static between polls, so force a fresh frame continuously —
    // at 62x62 px the cost is negligible and any white flash heals in ~300ms.
    setInterval(() => {
        if (floatWin && !floatWin.isDestroyed() && floatWin.isVisible())
            floatWin.webContents.invalidate();
    }, 300);

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
    claude:     { cache: null, extraDelay: 0, lastPollAt: 0, alertSt: {} },
    codex:      { cache: null, extraDelay: 0, lastPollAt: 0, alertSt: {} },
    gemini:     { cache: null, extraDelay: 0, lastPollAt: 0, alertSt: {}, projectId: null, plan: null },
    copilot:    { cache: null, extraDelay: 0, lastPollAt: 0, alertSt: {} },
    openrouter: { cache: null, extraDelay: 0, lastPollAt: 0, alertSt: {} },
    antigravity:{ cache: null, extraDelay: 0, lastPollAt: 0, alertSt: {}, server: null, plan: null },
};

async function pollClaude() {
    const st = providerState.claude;
    const now = Date.now();
    // Rate limit guard: minimum 30s between API calls, plus backoff after 429
    const minGap = 30000 + (st.extraDelay || 0) * 1000;
    if (now - st.lastPollAt < minGap) {
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
            if (getClaudeAuthMethod() === 'oauth' && await tryRefresh('claude', st)) {
                st.lastPollAt = 0;      // retry immediately with the fresh token
                return pollClaude();    // a second 401 falls through to 'expired' (refresh is rate-limited)
            }
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
    const minGap = 30000 + (st.extraDelay || 0) * 1000;
    if (st.lastPollAt > 0 && now - st.lastPollAt < minGap) {
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
            if (await tryRefresh('codex', st)) {
                st.lastPollAt = 0;      // retry immediately with the fresh token
                return pollCodex();     // a second 401 falls through to 'expired' (refresh is rate-limited)
            }
            broadcast('provider-status-changed', { provider: 'codex', status: 'expired' });
        } else if (err.message === 'rate_limited') {
            st.extraDelay = Math.min((st.extraDelay || 30) * 2, 300);
        } else {
            broadcast('provider-status-changed', { provider: 'codex', status: 'error' });
        }
    }
}

async function pollGemini() {
    const st = providerState.gemini;
    const now = Date.now();
    const minGap = 30000 + (st.extraDelay || 0) * 1000;
    if (st.lastPollAt > 0 && now - st.lastPollAt < minGap) {
        console.log('[BatRadar][Gemini] Skipped — too soon since last poll');
        return;
    }
    const auth = readGeminiAuth();
    if (!auth) {
        broadcast('provider-status-changed', { provider: 'gemini', status: 'disconnected' });
        return;
    }
    try {
        st.lastPollAt = now;
        // Google access tokens live ~1h — refresh ahead of expiry like the CLI does
        let token = auth.token;
        if (auth.expiryDate && auth.expiryDate < Date.now() + 60000) {
            if (await tryRefresh('gemini', st)) token = readGeminiAuth()?.token || token;
        }
        const raw  = await fetchGeminiUsage(token);
        const data = parseGeminiUsage(raw);
        st.cache = data;
        st.extraDelay = 0;
        broadcast('usage-update', { provider: 'gemini', data });
        broadcast('provider-status-changed', { provider: 'gemini', status: 'connected' });
        checkAlerts('gemini', data, loadConfig());
        console.log(`[BatRadar][Gemini] OK — session=${data.session?.utilization ?? 'n/a'}`);
    } catch (err) {
        console.error('[BatRadar][Gemini] Error:', err.message);
        if (err.message === 'token_expired') {
            if (await tryRefresh('gemini', st)) {
                st.lastPollAt = 0;      // retry immediately with the fresh token
                return pollGemini();    // a second 401 falls through to 'expired' (refresh is rate-limited)
            }
            broadcast('provider-status-changed', { provider: 'gemini', status: 'expired' });
        } else if (err.message === 'rate_limited') {
            st.extraDelay = Math.min((st.extraDelay || 30) * 2, 300);
        } else {
            // 403 here usually means the account has no Code Assist access —
            // Google cut personal-account OAuth for Gemini CLI in June 2026
            broadcast('provider-status-changed', { provider: 'gemini', status: 'error' });
        }
    }
}

// Copilot and OpenRouter have no refreshable OAuth — a rejected token means
// re-login / new key, so the simple poll cycle is shared
async function pollSimple(provider, getAuth, fetchFn, parseFn) {
    const st = providerState[provider];
    const now = Date.now();
    const minGap = 30000 + (st.extraDelay || 0) * 1000;
    if (st.lastPollAt > 0 && now - st.lastPollAt < minGap) return;
    const auth = getAuth();
    if (!auth) {
        broadcast('provider-status-changed', { provider, status: 'disconnected' });
        return;
    }
    try {
        st.lastPollAt = now;
        const data = parseFn(await fetchFn(auth));
        st.cache = data;
        st.extraDelay = 0;
        broadcast('usage-update', { provider, data });
        broadcast('provider-status-changed', { provider, status: 'connected' });
        checkAlerts(provider, data, loadConfig());
        console.log(`[BatRadar][${provider}] OK — session=${data.session?.utilization ?? 'n/a'}`);
    } catch (err) {
        console.error(`[BatRadar][${provider}] Error:`, err.message);
        if (err.message === 'token_expired')
            broadcast('provider-status-changed', { provider, status: 'expired' });
        else if (err.message === 'rate_limited')
            st.extraDelay = Math.min((st.extraDelay || 30) * 2, 300);
        else
            broadcast('provider-status-changed', { provider, status: 'error' });
    }
}

const pollCopilot    = () => pollSimple('copilot', getCopilotToken, fetchCopilotUsage, parseCopilotUsage);
const pollOpenrouter = () => pollSimple('openrouter', readOpenrouterKey, fetchOpenrouterUsage, parseOpenrouterUsage);

async function doPoll() {
    const cfg = loadConfig();
    const enabled = cfg.enabled_providers || DEFAULT_CONFIG.enabled_providers;
    // Run all providers in parallel — don't wait for one to finish before starting next
    const tasks = [];
    if (enabled.includes('claude'))     tasks.push(pollClaude());
    if (enabled.includes('codex'))      tasks.push(pollCodex());
    if (enabled.includes('gemini'))     tasks.push(pollGemini());
    if (enabled.includes('copilot'))     tasks.push(pollCopilot());
    if (enabled.includes('openrouter'))  tasks.push(pollOpenrouter());
    if (enabled.includes('antigravity')) tasks.push(pollAntigravity());
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
    const name = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'Copilot', openrouter: 'OpenRouter', antigravity: 'Antigravity' }[provider] || provider;

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
        const enabled = cfg.enabled_providers || DEFAULT_CONFIG.enabled_providers;
        const status = (id, hasAuth) => !enabled.includes(id) ? 'disabled'
                                      : hasAuth ? 'connected' : 'disconnected';
        const claudeToken  = readClaudeToken();
        const claudeAuth   = getClaudeAuthMethod();
        const codexAuth    = readCodexAuth();
        const geminiAuth   = readGeminiAuth();
        const copilotToken = getCopilotToken();
        const orKey        = readOpenrouterKey();
        return [
            { id: 'claude',     name: 'Claude Code', icon: 'claude',     plan: readClaudePlan(), status: status('claude', claudeToken), auth: claudeAuth, error: null },
            { id: 'codex',      name: 'Codex',       icon: 'codex',      plan: readCodexPlan(),  status: status('codex', codexAuth),    auth: codexAuth ? 'oauth' : 'none', error: null },
            { id: 'gemini',     name: 'Gemini CLI',  icon: 'gemini',     plan: providerState.gemini.plan, status: status('gemini', geminiAuth), auth: geminiAuth ? 'oauth' : 'none', error: null },
            { id: 'copilot',    name: 'Copilot',     icon: 'copilot',    plan: providerState.copilot.cache?.plan_type || null, status: status('copilot', copilotToken), auth: copilotToken ? 'oauth' : 'none', error: null },
            { id: 'openrouter', name: 'OpenRouter',  icon: 'openrouter', plan: providerState.openrouter.cache?.plan_type || null, status: status('openrouter', orKey), auth: orKey ? 'api-key' : 'none', error: null },
            { id: 'antigravity', name: 'Antigravity', icon: 'antigravity', plan: providerState.antigravity.plan, status: status('antigravity', providerState.antigravity.server), auth: providerState.antigravity.server ? 'local' : 'none', error: null },
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
        // Merge onto current config so keys the settings UI doesn't own
        // (display_providers, floating_position, enabled_providers…) survive
        saveConfig({ ...loadConfig(), ...settings });
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
        if (provider === 'gemini') {
            const a = readGeminiAuth();
            return a ? { found: true, valid: true, method: 'oauth', message: 'OAuth token found' }
                     : { found: false, valid: false, method: 'none', message: "Run 'gemini' and login" };
        }
        if (provider === 'copilot') {
            const t = getCopilotToken();
            return t ? { found: true, valid: true, method: 'oauth', message: 'GitHub token found' }
                     : { found: false, valid: false, method: 'none', message: 'Login Copilot in your editor or run gh auth login' };
        }
        if (provider === 'openrouter') {
            const k = readOpenrouterKey();
            return k ? { found: true, valid: true, method: 'api-key', message: 'API key set' }
                     : { found: false, valid: false, method: 'none', message: 'Enter API key in Settings' };
        }
        if (provider === 'antigravity') {
            const s = providerState.antigravity.server;
            return s ? { found: true, valid: true, method: 'local', message: 'Antigravity app detected' }
                     : { found: false, valid: false, method: 'none', message: 'Open the Antigravity app and login' };
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

    ipcMain.handle('save_openrouter_key', (_, { key }) => {
        if (!key || !key.trim()) throw new Error('Empty key');
        saveOpenrouterKey(key.trim());
        providerState.openrouter.cache = null;
        providerState.openrouter.lastPollAt = 0;
        stopPolling(); startPolling();
        return { success: true };
    });

    ipcMain.handle('remove_openrouter_key', () => {
        deleteOpenrouterKey();
        providerState.openrouter.cache = null;
        broadcast('provider-status-changed', { provider: 'openrouter', status: 'disconnected' });
        return { success: true };
    });

    ipcMain.handle('get_openrouter_key_status', () => !!readOpenrouterKey());

    ipcMain.handle('disconnect_provider', (_, { provider }) => {
        const cfg = loadConfig();
        cfg.enabled_providers = (cfg.enabled_providers || DEFAULT_CONFIG.enabled_providers)
            .filter(p => p !== provider);
        saveConfig(cfg);
        // Keep the saved API key — disconnect only pauses monitoring,
        // matching the confirm dialog's promise. Use remove_api_key to delete it.
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
        const enabled = new Set(cfg.enabled_providers || DEFAULT_CONFIG.enabled_providers);
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
