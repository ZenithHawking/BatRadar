import { invoke, listen, usageColorClass, usageColor, secondsUntil, formatDuration, PROVIDER_COLORS } from './utils.js';
import { icon } from './icons.js';

const providersEl = document.getElementById('providers');
const statusEl    = document.getElementById('status-text');

const ICONS = {
    claude:     '<img src="assets/icons/claude.png" width="24" height="24" style="border-radius:4px">',
    codex:      '<img src="assets/icons/codex.png" width="24" height="24" style="border-radius:4px">',
    gemini:     '<img src="assets/icons/gemini.png" width="24" height="24" style="border-radius:4px">',
    copilot:    '<img src="assets/icons/copilot.svg" width="24" height="24" style="border-radius:4px">',
    openrouter: '<img src="assets/icons/openrouter.ico" width="24" height="24" style="border-radius:4px">',
    antigravity:'<img src="assets/icons/antigravity.png" width="24" height="24" style="border-radius:4px">',
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
    if (payload.status === 'expired') updateStatus(`${payload.provider} token expired`);
    else if (payload.status === 'error') updateStatus('Connection error — retrying…');
});

// ─── Usage history chart ───────────────────────────────────────────────────────
// Backend logs one point per provider every ~15min (src-tauri/src/history.rs).
// Fetched lazily on first expand and cached; the live edge (current risk,
// not yet flushed to the log) is appended in-memory so the line stays current.
const historyCache = new Map(); // id -> HistoryPoint[]
const lastRisk = new Map();     // id -> current top-window utilization

async function loadAndDrawChart(id) {
    if (!historyCache.has(id)) {
        try { historyCache.set(id, await invoke('get_usage_history', { provider: id })); }
        catch { historyCache.set(id, []); }
    }
    drawChart(id);
}

function drawChart(id) {
    const canvas = document.getElementById(`chart-${id}`);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const points = historyCache.get(id) || [];
    const risk = lastRisk.get(id);
    const series = risk == null ? points : [...points, { ts: Math.floor(Date.now() / 1000), risk }];
    if (series.length < 2) {
        ctx.fillStyle = 'rgba(148,163,184,0.6)';
        ctx.font = '10px sans-serif';
        ctx.fillText('Chưa đủ dữ liệu lịch sử', 6, h / 2 + 3);
        return;
    }

    const minTs = series[0].ts, maxTs = series[series.length - 1].ts;
    const spanTs = Math.max(maxTs - minTs, 1);
    const color = usageColor(series[series.length - 1].risk);
    const x = (p) => 2 + (spanTs ? (p.ts - minTs) / spanTs : 0) * (w - 4);
    const y = (p) => h - 3 - p.risk * (h - 6);

    ctx.beginPath();
    series.forEach((p, i) => (i === 0 ? ctx.moveTo(x(p), y(p)) : ctx.lineTo(x(p), y(p))));
    ctx.lineTo(x(series[series.length - 1]), h - 1);
    ctx.lineTo(x(series[0]), h - 1);
    ctx.closePath();
    ctx.fillStyle = color + '26';
    ctx.fill();

    ctx.beginPath();
    series.forEach((p, i) => (i === 0 ? ctx.moveTo(x(p), y(p)) : ctx.lineTo(x(p), y(p))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

// ─── Drag-to-reorder ──────────────────────────────────────────────────────────
const ORDER_KEY = 'batradar-provider-order';
let draggedCard = null;

function loadOrder() {
    try { return JSON.parse(localStorage.getItem(ORDER_KEY)) || []; } catch { return []; }
}
function saveOrder() {
    const order = [...providersEl.children].map(c => c.id.replace('card-', ''));
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
}
function sortBySavedOrder(providers) {
    const order = loadOrder();
    if (!order.length) return providers;
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...providers].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
}

// FLIP: capture positions, run the DOM mutation, then animate every card
// that moved from its old spot to its new one — the "others slide" effect.
function reorderWithAnimation(mutate) {
    const before = new Map([...providersEl.children].map(c => [c, c.getBoundingClientRect()]));
    mutate();
    for (const c of providersEl.children) {
        const prev = before.get(c);
        if (!prev) continue;
        const dy = prev.top - c.getBoundingClientRect().top;
        if (!dy) continue;
        c.style.transition = 'none';
        c.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => {
            c.style.transition = 'transform 0.18s ease';
            c.style.transform = '';
        });
    }
}

function makeDraggable(card) {
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
        draggedCard = card;
        // WebView2/Chromium show a "not allowed" cursor for the whole drag
        // unless a payload is set and the effect is declared explicitly.
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
        requestAnimationFrame(() => card.classList.add('dragging'));
    });
    card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        draggedCard = null;
        saveOrder();
    });
    card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!draggedCard || draggedCard === card) return;
        const rect = card.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        const target = before ? card : card.nextElementSibling;
        if (target === draggedCard || draggedCard.nextElementSibling === target) return;
        reorderWithAnimation(() => providersEl.insertBefore(draggedCard, target));
    });
}

providersEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
});

// ─── Initial render ───────────────────────────────────────────────────────────
(async () => {
    const providers = sortBySavedOrder(await invoke('get_providers'));
    providersEl.innerHTML = '';
    for (const p of providers) {
        const card = buildCard(p);
        providersEl.appendChild(card);
        if (p.status === 'connected') {
            try {
                const data = await invoke('get_usage', { provider: p.id });
                renderUsage(card, p.id, data);
            } catch {
                const sec = card.querySelector(`#rows-${p.id}`);
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
    const setupHint = p.id === 'claude'     ? "Run: <code>claude login</code>"
                    : p.id === 'codex'      ? "Run: <code>codex</code> and login"
                    : p.id === 'gemini'     ? "Run: <code>gemini</code> and login"
                    : p.id === 'copilot'    ? "Login Copilot in editor or <code>gh auth login</code>"
                    : p.id === 'openrouter' ? "Enter API key in Settings"
                    : p.id === 'antigravity' ? "Open the Antigravity app"
                    : 'Coming soon';
    card.innerHTML = `
      <div class="provider-header">
        <div class="provider-name-row">
          <div class="provider-icon" style="color:${color}">${ICONS[p.id] || icon('wrench', 16)}</div>
          <span class="provider-name">${p.name}</span>
          ${p.plan ? `<span class="plan-tag">${cap(p.plan)}</span>` : ''}
        </div>
        <div class="header-right">
          <span class="usage-summary" id="summary-${p.id}"></span>
          <span class="status-badge ${p.status}">${statusLabel(p.status)}</span>
          <span class="chevron">${icon('chevron', 14)}</span>
        </div>
      </div>
      <div class="usage-section" id="usage-${p.id}">
        ${p.status !== 'connected'
            ? `<div class="provider-disconnected">
                <span class="disconnected-label">${hint(p)}</span>
                <button class="btn-ghost" onclick="window.openSettings()">Setup</button>
               </div>`
            : `<div id="rows-${p.id}"><div style="color:var(--text-dim);font-size:11px;padding:8px;text-align:center">Loading…</div></div>
               <canvas class="history-chart" id="chart-${p.id}" width="300" height="56"></canvas>`
        }
      </div>`;
    card.querySelector('.provider-header').addEventListener('click', () => {
        const wasExpanded = card.classList.contains('expanded');
        card.classList.toggle('expanded');
        if (!wasExpanded && p.status === 'connected') loadAndDrawChart(p.id);
    });
    makeDraggable(card);
    return card;
}

function renderUsage(card, id, data) {
    const sec = card.querySelector(`#rows-${id}`);
    if (!sec) return;
    card.classList.add('active');
    const windows = data.windows || [data.session, data.weekly, data.weekly_sonnet, data.weekly_opus].filter(Boolean);
    let html = '';
    if (data.windows) {
        // Provider supplies its own labelled quota windows (e.g. Gemini daily per-model)
        for (const w of data.windows) html += usageRow(w.label, w);
    } else {
        if (data.session)       html += usageRow('Session (5h)',     data.session);
        if (data.weekly)        html += usageRow('Weekly',           data.weekly);
        if (data.weekly_sonnet) html += usageRow('Weekly (Sonnet)',  data.weekly_sonnet);
        if (data.weekly_opus)   html += usageRow('Weekly (Opus)',    data.weekly_opus);
    }
    if (data.extra_usage) {
        const eu = data.extra_usage;
        html += `<div class="extra-usage-row"><span>Extra Usage</span>
            <span class="extra-usage-val">$${eu.spend.toFixed(2)} / $${eu.limit.toFixed(2)} ${eu.currency || 'USD'}</span></div>`;
    }
    if (data.last_updated) {
        html += `<div class="last-updated">Updated ${new Date(data.last_updated).toLocaleTimeString()}</div>`;
    }
    sec.innerHTML = html || `<div style="color:var(--text-dim);font-size:11px;padding:4px 0">No data</div>`;

    const summary = card.querySelector(`#summary-${id}`);
    if (windows.length) {
        const top = windows.reduce((a, b) => (a.utilization > b.utilization ? a : b));
        if (summary) {
            summary.textContent = `${Math.round(top.utilization * 100)}%`;
            summary.style.color = usageColor(top.utilization);
        }
        lastRisk.set(id, top.utilization);
    } else if (summary) {
        summary.textContent = '';
    }
    if (card.classList.contains('expanded')) drawChart(id);
}

function usageRow(label, w) {
    const u    = w.utilization;
    const color = usageColor(u);
    const pct  = Math.round(u * 100);
    // Some quotas (e.g. OpenRouter credits) have no reset cycle
    const rst  = w.reset_at ? `resets in ${formatDuration(secondsUntil(w.reset_at))}` : '';
    return `<div class="usage-row">
      <div class="usage-row-header">
        <span class="usage-label">${label}</span>
        <div class="usage-right">
          <span class="usage-pct" style="color:${color}">${pct}%${u >= 0.95 ? ` ${icon('alert', 11)}` : ''}</span>
          ${rst ? `<span class="usage-reset">${rst}</span>` : ''}
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
    // Dot glyph comes from .status-badge::before in CSS
    return { connected: 'Connected', disconnected: 'Not Connected', disabled: 'Disabled', expired: 'Expired', error: 'Error' }[s] || s;
}
function hint(p) {
    if (p.status === 'disabled') return 'Đã tắt — vào Settings để bật lại';
    if (p.status === 'expired') return 'Token expired';
    if (p.status === 'error') return 'Connection error';
    if (p.id === 'claude') return 'Not connected — run: claude login';
    if (p.id === 'codex') return 'Not connected — run: codex';
    if (p.id === 'gemini') return 'Not connected — run: gemini';
    if (p.id === 'copilot') return 'Not connected — login Copilot or gh auth login';
    if (p.id === 'openrouter') return 'Not connected — enter API key in Settings';
    if (p.id === 'antigravity') return 'Not connected — open the Antigravity app';
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
