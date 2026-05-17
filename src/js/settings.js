import { invoke } from './utils.js';

let cfg = null;

(async () => {
    cfg = await invoke('load_settings');
    applySettings(cfg);
    const providers = await invoke('get_providers');
    renderProviders(providers);
    updateApiKeyStatus();
    loadDisplayToggles();
})();

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
        claude: '<img src="assets/icons/claude.png" width="20" height="20" style="border-radius:4px;vertical-align:middle">',
        codex:  '<img src="assets/icons/codex.png" width="20" height="20" style="border-radius:4px;vertical-align:middle">',
        gemini: '<img src="assets/icons/gemini.png" width="20" height="20" style="border-radius:4px;vertical-align:middle">',
    };
    const labels = {
        connected: '✅ Connected',
        disconnected: 'Not connected',
        expired: '⚠️ Token expired',
        error: '✕ Error'
    };
    const setupHints = {
        claude: 'Run: <code>claude login</code> or enter API key',
        codex: 'Run: <code>npm i -g @openai/codex</code> then <code>codex</code>',
        gemini: 'Coming soon',
    };
    for (const p of providers) {
        const authLabel = p.auth === 'api-key' ? '· via API Key'
                        : p.auth === 'oauth' ? '· via OAuth'
                        : '';
        const div = document.createElement('div');
        div.className = 'provider-item';
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
            ${p.status === 'connected'
                ? `<button class="btn-danger" onclick="disconnectProvider('${p.id}')">Disconnect</button>`
                : `<span style="font-size:10px;color:var(--text-dim)">${setupHints[p.id] || ''}</span>`
            }
          </div>`;
        el.appendChild(div);
    }
}

function badgeLabel(s) {
    return { connected: '● On', disconnected: '○ Off', expired: '⚠', error: '✕' }[s] || s;
}

async function updateApiKeyStatus() {
    const method = await invoke('get_auth_method');
    const statusEl = document.getElementById('apikey-status');
    if (method === 'api-key') {
        statusEl.innerHTML = '🔑 <span style="color:var(--color-green)">Claude API key is set</span>';
    } else if (method === 'oauth') {
        statusEl.innerHTML = '🔗 <span style="color:var(--color-green)">Claude using OAuth</span> — API key not needed';
    } else {
        statusEl.innerHTML = '⚠️ <span style="color:var(--color-yellow)">No Claude auth configured</span>';
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
    const settings = {
        autostart:             document.getElementById('toggle-autostart').checked,
        poll_interval_seconds: parseInt(document.getElementById('select-interval').value),
        alert_threshold:       parseFloat(document.getElementById('select-alert').value),
        critical_threshold:    cfg?.critical_threshold ?? 0.95,
        enabled_providers:     cfg?.enabled_providers ?? ['claude', 'codex'],
        floating_position:     cfg?.floating_position ?? null,
        notification_enabled:  document.getElementById('toggle-notification').checked,
    };
    try {
        await invoke('save_settings', { settings });
        invoke('hide_settings');
    } catch (e) { alert('Failed to save: ' + e); }
};

window.disconnectProvider = async (provider) => {
    if (!confirm(`Disconnect ${provider}?`)) return;
    await invoke('disconnect_provider', { provider });
    await updateApiKeyStatus();
    const providers = await invoke('get_providers');
    renderProviders(providers);
};

window.closeSettings = () => invoke('hide_settings');

// ─── Display toggle (which providers show on floating icon) ───────────────
async function loadDisplayToggles() {
    const providers = await invoke('get_display_providers');
    // null = all enabled
    document.getElementById('display-claude').checked = !providers || providers.includes('claude');
    document.getElementById('display-codex').checked  = !providers || providers.includes('codex');
}

window.updateDisplayProviders = async () => {
    const claude = document.getElementById('display-claude').checked;
    const codex  = document.getElementById('display-codex').checked;

    let providers = null; // null = show all
    if (claude && codex) {
        providers = null;
    } else if (claude) {
        providers = ['claude'];
    } else if (codex) {
        providers = ['codex'];
    } else {
        // At least one must be selected
        providers = ['claude'];
        document.getElementById('display-claude').checked = true;
    }

    await invoke('set_display_providers', { providers });
};
