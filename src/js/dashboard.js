import { invoke, listen, usageColorClass, usageColor, secondsUntil, formatDuration, PROVIDER_COLORS } from './utils.js';

const providersEl = document.getElementById('providers');
const statusEl    = document.getElementById('status-text');

const ICONS = {
    claude: '<img src="assets/icons/claude.png" width="24" height="24" style="border-radius:4px">',
    codex:  '<img src="assets/icons/codex.png" width="24" height="24" style="border-radius:4px">',
    gemini: '<img src="assets/icons/gemini.png" width="24" height="24" style="border-radius:4px">',
};

// ─── Live updates (all providers) ─────────────────────────────────────────────
listen('usage-update', ({ payload }) => {
    const card = document.getElementById(`card-${payload.provider}`);
    if (card) { renderUsage(card, payload.provider, payload.data); updateStatus('Updated just now'); }
});

listen('provider-status-changed', ({ payload }) => {
    const card = document.getElementById(`card-${payload.provider}`);
    if (!card) return;
    const badge = card.querySelector('.status-badge');
    if (badge) { badge.className = `status-badge ${payload.status}`; badge.textContent = statusLabel(payload.status); }
    if (payload.status === 'disabled') {
        card.classList.remove('active');
        const sec = card.querySelector(`#usage-${payload.provider}`);
        if (sec) sec.innerHTML = `<div class="provider-disconnected">
            <span class="disconnected-label">Đã tắt — vào Settings để bật lại</span>
            <button class="btn-ghost" onclick="window.openSettings()">Settings</button>
           </div>`;
    }
    if (payload.status === 'expired') updateStatus(`⚠️ ${payload.provider} token expired`);
    else if (payload.status === 'error') updateStatus('Connection error — retrying…');
});

// ─── Initial render ───────────────────────────────────────────────────────────
(async () => {
    const providers = await invoke('get_providers');
    providersEl.innerHTML = '';
    for (const p of providers) {
        const card = buildCard(p);
        providersEl.appendChild(card);
        if (p.status === 'connected') {
            try {
                const data = await invoke('get_usage', { provider: p.id });
                renderUsage(card, p.id, data);
            } catch {
                const sec = card.querySelector(`#usage-${p.id}`);
                if (sec) sec.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:8px;text-align:center">Waiting for data…</div>';
            }
        }
    }
    updateStatus('Live');
})();

// ─── Card builder ─────────────────────────────────────────────────────────────
function buildCard(p) {
    const card = document.createElement('div');
    card.id = `card-${p.id}`;
    card.className = `provider-card ${p.status === 'connected' ? 'active' : ''}`;
    const color = PROVIDER_COLORS[p.id] || '#94a3b8';
    const setupHint = p.id === 'claude' ? "Run: <code>claude login</code>"
                    : p.id === 'codex'  ? "Run: <code>codex</code> and login"
                    : 'Coming soon';
    card.innerHTML = `
      <div class="provider-header">
        <div class="provider-name-row">
          <div class="provider-icon" style="color:${color}">${ICONS[p.id] || '🔧'}</div>
          <span class="provider-name">${p.name}</span>
          ${p.plan ? `<span class="plan-tag">${cap(p.plan)}</span>` : ''}
        </div>
        <span class="status-badge ${p.status}">${statusLabel(p.status)}</span>
      </div>
      <div class="usage-section" id="usage-${p.id}">
        ${p.status !== 'connected'
            ? `<div class="provider-disconnected">
                <span class="disconnected-label">${hint(p)}</span>
                <button class="btn-ghost" onclick="window.openSettings()">Setup</button>
               </div>`
            : `<div style="color:var(--text-dim);font-size:11px;padding:8px;text-align:center">Loading…</div>`
        }
      </div>`;
    return card;
}

function renderUsage(card, id, data) {
    const sec = card.querySelector(`#usage-${id}`);
    if (!sec) return;
    card.classList.add('active');
    let html = '';
    if (data.session)       html += usageRow('Session (5h)',     data.session);
    if (data.weekly)        html += usageRow('Weekly',           data.weekly);
    if (data.weekly_sonnet) html += usageRow('Weekly (Sonnet)',  data.weekly_sonnet);
    if (data.weekly_opus)   html += usageRow('Weekly (Opus)',    data.weekly_opus);
    if (data.extra_usage) {
        const eu = data.extra_usage;
        html += `<div class="extra-usage-row"><span>Extra Usage</span>
            <span class="extra-usage-val">$${eu.spend.toFixed(2)} / $${eu.limit.toFixed(2)} ${eu.currency || 'USD'}</span></div>`;
    }
    if (data.last_updated) {
        html += `<div class="last-updated">Updated ${new Date(data.last_updated).toLocaleTimeString()}</div>`;
    }
    sec.innerHTML = html || `<div style="color:var(--text-dim);font-size:11px;padding:4px 0">No data</div>`;
}

function usageRow(label, w) {
    const u    = w.utilization;
    const color = usageColor(u);
    const pct  = Math.round(u * 100);
    const rst  = formatDuration(secondsUntil(w.reset_at));
    return `<div class="usage-row">
      <div class="usage-row-header">
        <span class="usage-label">${label}</span>
        <div class="usage-right">
          <span class="usage-pct" style="color:${color}">${pct}%${u >= 0.95 ? ' ⚠️' : ''}</span>
          <span class="usage-reset">resets in ${rst}</span>
        </div>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
    </div>`;
}

function renderError(card, msg) {
    const s = card.querySelector('.usage-section');
    if (s) s.innerHTML = `<div style="color:var(--color-red);font-size:11px;padding:4px 0">Error: ${msg}</div>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function statusLabel(s) {
    return { connected: '● Connected', disconnected: '○ Not Connected', disabled: '⏸ Disabled', expired: '⚠ Expired', error: '✕ Error' }[s] || s;
}
function hint(p) {
    if (p.status === 'disabled') return 'Đã tắt — vào Settings để bật lại';
    if (p.status === 'expired') return 'Token expired';
    if (p.status === 'error') return 'Connection error';
    if (p.id === 'claude') return 'Not connected — run: claude login';
    if (p.id === 'codex') return 'Not connected — run: codex';
    return 'Not connected';
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
function updateStatus(msg) { if (statusEl) statusEl.textContent = msg; }

// ─── Button handlers ──────────────────────────────────────────────────────────
window.openSettings      = () => invoke('show_settings');
window.minimizeDashboard = () => invoke('hide_dashboard');
window.closeDashboard    = () => invoke('hide_dashboard');

let floatingVisible = true;
window.toggleFloating = () => {
    floatingVisible = !floatingVisible;
    invoke(floatingVisible ? 'show_floating' : 'hide_floating');
};
