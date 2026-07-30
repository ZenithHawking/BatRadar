import { invoke } from './utils.js';
import { icon } from './icons.js';

let cfg = null;

(async () => {
    cfg = await invoke('load_settings');
    applySettings(cfg);
    const providers = await invoke('get_providers');
    renderProviders(providers);
    updateApiKeyStatus();
    updateOpenrouterKeyStatus();
    loadDisplayToggles();
    loadAppVersion();
})();

async function updateOpenrouterKeyStatus() {
    const el = document.getElementById('orkey-status');
    if (!el) return;
    try {
        const has = await invoke('get_openrouter_key_status');
        el.innerHTML = has
            ? `${icon('key', 12)} <span style="color:var(--color-green)">OpenRouter API key is set</span>`
            : `${icon('alert', 12)} <span style="color:var(--color-yellow)">No OpenRouter key — create one free at openrouter.ai/keys</span>`;
    } catch {}
}

window.saveOpenrouterKey = async () => {
    const input = document.getElementById('input-orkey');
    const key = input.value.trim();
    if (!key) { alert('Please enter an API key'); return; }
    if (!key.startsWith('sk-or-')) { alert('Invalid format. Should start with sk-or-'); return; }
    try {
        await invoke('save_openrouter_key', { key });
        input.value = '';
        await updateOpenrouterKeyStatus();
        renderProviders(await invoke('get_providers'));
    } catch (e) { alert('Failed: ' + e); }
};

window.removeOpenrouterKey = async () => {
    if (!confirm('Remove saved OpenRouter API key?')) return;
    try {
        await invoke('remove_openrouter_key');
        await updateOpenrouterKeyStatus();
        renderProviders(await invoke('get_providers'));
    } catch (e) { alert('Failed: ' + e); }
};

async function loadAppVersion() {
    try {
        const v = await invoke('get_app_version');
        const el = document.getElementById('app-version');
        if (el) el.textContent = `Phiên bản: ${v}`;
    } catch {}
}

window.checkUpdates = async () => {
    const btn = document.getElementById('btn-check-updates');
    if (btn) { btn.disabled = true; btn.textContent = 'Đang kiểm tra…'; }
    try {
        await invoke('check_for_updates');
    } catch (e) {
        alert('Lỗi: ' + e);
    } finally {
        setTimeout(() => {
            if (btn) { btn.disabled = false; btn.textContent = 'Kiểm tra'; }
        }, 2000);
    }
};

function applySettings(s) {
    document.getElementById('toggle-autostart').checked    = s.autostart;
    document.getElementById('select-interval').value       = String(s.poll_interval_seconds);
    document.getElementById('select-alert').value          = String(s.alert_threshold);
    document.getElementById('toggle-notification').checked = s.notification_enabled;
}

function renderProviders(providers) {
    const el = document.getElementById('providers-list');
    el.innerHTML = '';
    const ICONS = {
        claude:     '<img src="assets/icons/claude.png" width="20" height="20" style="border-radius:4px;vertical-align:middle">',
        codex:      '<img src="assets/icons/codex.png" width="20" height="20" style="border-radius:4px;vertical-align:middle">',
        gemini:     '<img src="assets/icons/gemini.png" width="20" height="20" style="border-radius:4px;vertical-align:middle">',
        copilot:    '<img src="assets/icons/copilot.svg" width="20" height="20" style="border-radius:4px;vertical-align:middle">',
        openrouter: '<img src="assets/icons/openrouter.ico" width="20" height="20" style="border-radius:4px;vertical-align:middle">',
        antigravity:'<img src="assets/icons/antigravity.png" width="20" height="20" style="border-radius:4px;vertical-align:middle">',
    };
    const labels = {
        connected: 'Connected',
        disconnected: 'Not connected',
        disabled: 'Disabled (paused by you)',
        expired: 'Token expired',
        error: 'Error'
    };
    const setupHints = {
        claude: 'Run: <code>claude login</code> or enter API key',
        codex: 'Run: <code>npm i -g @openai/codex</code> then <code>codex</code>',
        gemini: 'Run: <code>npm i -g @google/gemini-cli</code> then <code>gemini</code>',
        copilot: 'Login Copilot in your editor or run <code>gh auth login</code>',
        openrouter: 'Enter API key below (OpenRouter API Key)',
        antigravity: 'Open the Antigravity app and login with Google',
    };
    for (const p of providers) {
        const authLabel = p.auth === 'api-key' ? '· via API Key'
                        : p.auth === 'oauth' ? '· via OAuth'
                        : '';
        const div = document.createElement('div');
        div.className = 'provider-item';
        let actionHtml;
        if (p.status === 'connected') {
            actionHtml = `<button class="btn-danger" onclick="disconnectProvider('${p.id}')">Disconnect</button>`;
        } else if (p.status === 'disabled') {
            actionHtml = `<button class="btn-primary" onclick="reconnectProvider('${p.id}')">Bật lại</button>`;
        } else {
            actionHtml = `<span style="font-size:10px;color:var(--text-dim)">${setupHints[p.id] || ''}</span>`;
        }
        div.innerHTML = `
          <div class="provider-row">
            <div class="provider-row-left">
              <span class="provider-icon-sm">${ICONS[p.id] || '🔧'}</span>
              <span>${p.name}</span>
            </div>
            <span class="status-badge ${p.status}">${badgeLabel(p.status)}</span>
          </div>
          <div class="provider-detail">
            <span>${labels[p.status] || p.status} ${authLabel}</span>
            ${actionHtml}
          </div>`;
        el.appendChild(div);
    }
}

function badgeLabel(s) {
    // Dot glyph comes from .status-badge::before in CSS
    return { connected: 'On', disconnected: 'Off', disabled: 'Off', expired: 'Expired', error: 'Error' }[s] || s;
}

async function updateApiKeyStatus() {
    const method = await invoke('get_auth_method');
    const statusEl = document.getElementById('apikey-status');
    if (method === 'api-key') {
        statusEl.innerHTML = `${icon('key', 12)} <span style="color:var(--color-green)">Claude API key is set</span>`;
    } else if (method === 'oauth') {
        statusEl.innerHTML = `${icon('link', 12)} <span style="color:var(--color-green)">Claude using OAuth</span> — API key not needed`;
    } else {
        statusEl.innerHTML = `${icon('alert', 12)} <span style="color:var(--color-yellow)">No Claude auth configured</span>`;
    }
}

window.toggleHelp = () => {
    const panel = document.getElementById('apikey-help');
    const btn = document.getElementById('help-toggle');
    panel.classList.toggle('show');
    btn.classList.toggle('active');
};

window.openExternal = (url) => {
    invoke('open_external', { url });
};

window.saveApiKey = async () => {
    const input = document.getElementById('input-apikey');
    const key = input.value.trim();
    if (!key) { alert('Please enter an API key'); return; }
    if (!key.startsWith('sk-ant-')) { alert('Invalid format. Should start with sk-ant-'); return; }
    try {
        await invoke('save_api_key', { key });
        input.value = '';
        await updateApiKeyStatus();
        const providers = await invoke('get_providers');
        renderProviders(providers);
    } catch (e) { alert('Failed: ' + e); }
};

window.removeApiKey = async () => {
    if (!confirm('Remove saved API key?')) return;
    try {
        await invoke('remove_api_key');
        await updateApiKeyStatus();
        const providers = await invoke('get_providers');
        renderProviders(providers);
    } catch (e) { alert('Failed: ' + e); }
};

window.saveSettings = async () => {
    // Only send the fields this form owns — main merges onto the current
    // config, so stale values from app startup can't clobber anything.
    const settings = {
        autostart:             document.getElementById('toggle-autostart').checked,
        poll_interval_seconds: parseInt(document.getElementById('select-interval').value),
        alert_threshold:       parseFloat(document.getElementById('select-alert').value),
        notification_enabled:  document.getElementById('toggle-notification').checked,
    };
    try {
        await invoke('save_settings', { settings });
        invoke('hide_settings');
    } catch (e) { alert('Failed to save: ' + e); }
};

window.disconnectProvider = async (provider) => {
    const loginCmd = { claude: 'claude login', codex: 'codex login', gemini: 'gemini', copilot: 'editor login / gh', openrouter: 'API key', antigravity: 'Antigravity app' }[provider] || provider;
    if (!confirm(`Disconnect ${provider}?\n\nApp sẽ ngừng theo dõi provider này. Credentials gốc (${loginCmd}) không bị xóa — bạn có thể bật lại bất cứ lúc nào.`)) return;
    await invoke('disconnect_provider', { provider });
    await updateApiKeyStatus();
    const providers = await invoke('get_providers');
    renderProviders(providers);
};

window.reconnectProvider = async (provider) => {
    await invoke('reconnect_provider', { provider });
    await updateApiKeyStatus();
    const providers = await invoke('get_providers');
    renderProviders(providers);
};

window.closeSettings = () => invoke('hide_settings');

// ─── Display toggle (which providers show on floating icon) ───────────────
const DISPLAY_PROVIDERS = ['claude', 'codex', 'gemini', 'copilot', 'openrouter', 'antigravity'];

async function loadDisplayToggles() {
    const providers = await invoke('get_display_providers');
    // null = all enabled
    for (const id of DISPLAY_PROVIDERS) {
        const el = document.getElementById(`display-${id}`);
        if (el) el.checked = !providers || providers.includes(id);
    }
}

window.updateDisplayProviders = async () => {
    let selected = DISPLAY_PROVIDERS.filter(id => document.getElementById(`display-${id}`)?.checked);
    if (selected.length === 0) {
        // At least one must be selected
        selected = ['claude'];
        document.getElementById('display-claude').checked = true;
    }
    const providers = selected.length === DISPLAY_PROVIDERS.length ? null : selected;
    await invoke('set_display_providers', { providers });
};
