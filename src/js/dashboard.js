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

const RANGES = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
// Raw 15-min points turn into a solid block over weeks — longer ranges
// plot the peak of each bucket instead
const BUCKETS = { '24h': 0, '7d': 6 * 3600, '30d': 86400 };
const chartRange = new Map();   // id -> range key
const chartHover = new Map();   // id -> hovered point or null
// Points are logged every ~15min; a longer silence means the app was off,
// so the line breaks there instead of drawing a fake straight segment
const GAP_SECS = 45 * 60;
const PAD = { l: 34, r: 8, t: 8, b: 18 };

function historyBlock(id) {
    return `<div class="history" id="history-${id}">
      <div class="history-head">
        <span class="history-title">Lịch sử</span>
        <span class="history-stats" id="hstats-${id}"></span>
        <div class="history-ranges">
          ${Object.keys(RANGES).map(r => `<button data-range="${r}" class="${r === '24h' ? 'on' : ''}">${r}</button>`).join('')}
        </div>
      </div>
      <div class="history-plot">
        <canvas class="history-chart" id="chart-${id}"></canvas>
        <div class="history-tip" id="htip-${id}" hidden></div>
      </div>
    </div>`;
}

function wireHistory(card, id) {
    const box = card.querySelector(`#history-${id}`);
    if (!box) return;
    box.addEventListener('click', e => e.stopPropagation());
    box.querySelectorAll('.history-ranges button').forEach(btn => btn.addEventListener('click', () => {
        chartRange.set(id, btn.dataset.range);
        box.querySelectorAll('.history-ranges button').forEach(b => b.classList.toggle('on', b === btn));
        drawChart(id);
    }));
    const canvas = box.querySelector('canvas');
    canvas.addEventListener('mousemove', e => {
        const { series, xOf } = chartGeometry(id, canvas);
        if (!series.length) return;
        const mx = e.offsetX;
        let best = null, bestDx = Infinity;
        for (const p of series) {
            const dx = Math.abs(xOf(p.ts) - mx);
            if (dx < bestDx) { bestDx = dx; best = p; }
        }
        chartHover.set(id, bestDx <= 24 ? best : null);
        drawChart(id);
    });
    canvas.addEventListener('mouseleave', () => { chartHover.set(id, null); drawChart(id); });
}

function seriesFor(id) {
    const now = Math.floor(Date.now() / 1000);
    const rangeKey = chartRange.get(id) || '24h';
    const rangeFrom = now - RANGES[rangeKey];
    const raw = (historyCache.get(id) || []).filter(p => p.ts >= rangeFrom).sort((a, b) => a.ts - b.ts);
    const size = BUCKETS[rangeKey];
    let points = raw;
    if (size) {
        // Buckets align to local midnight so a "day" means a calendar day
        const tz = new Date().getTimezoneOffset() * 60;
        const byStart = new Map();
        for (const p of raw) {
            const start = Math.floor((p.ts - tz) / size) * size + tz;
            const b = byStart.get(start);
            if (!b || p.risk > b.risk) byStart.set(start, { start, risk: p.risk });
        }
        points = [...byStart.values()].map(b => ({ ts: Math.min(b.start + size / 2, now), start: b.start, risk: b.risk }));
    }
    // Fit the x axis to the data actually logged — a fresh install with a
    // few hours of history would otherwise be a sliver at the right edge
    const from = raw.length ? Math.min(raw[0].ts, now - 3600) : rangeFrom;
    const risk = lastRisk.get(id);
    if (risk != null) points.push({ ts: now, risk, live: true });
    // Neighbouring buckets are `size` apart by design — only a bigger jump is a gap
    return { series: points, raw, from, now, size, gap: Math.max(GAP_SECS, size * 1.5) };
}

function chartGeometry(id, canvas) {
    const s = seriesFor(id);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const pw = w - PAD.l - PAD.r, ph = h - PAD.t - PAD.b;
    const xOf = ts => PAD.l + ((ts - s.from) / (s.now - s.from)) * pw;
    const yOf = r => PAD.t + (1 - Math.min(Math.max(r, 0), 1)) * ph;
    return { ...s, w, h, pw, ph, xOf, yOf };
}

function fmtTick(ts, spanSecs) {
    const d = new Date(ts * 1000);
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0'), mo = String(d.getMonth() + 1).padStart(2, '0');
    if (spanSecs <= 86400) return `${hh}:${mm}`;
    if (spanSecs <= 3 * 86400) return `${dd}/${mo} ${hh}h`;
    return `${dd}/${mo}`;
}

function fmtSpan(secs) {
    if (secs >= 86400) return `${Math.round(secs / 86400)} ngày`;
    return `${Math.max(1, Math.round(secs / 3600))} giờ`;
}

function drawChart(id) {
    const canvas = document.getElementById(`chart-${id}`);
    if (!canvas || !canvas.clientWidth) return;
    // Size the backing store to the element so text stays crisp at any DPI
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(canvas.clientWidth * dpr)) {
        canvas.width = Math.round(canvas.clientWidth * dpr);
        canvas.height = Math.round(canvas.clientHeight * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = chartGeometry(id, canvas);
    const { series, raw, from, now, w, h, pw, xOf, yOf } = g;
    const rangeKey = chartRange.get(id) || '24h';
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--border').trim() || '#2a2a38';
    const muted = css.getPropertyValue('--text-dim').trim() || '#9494a2';
    ctx.clearRect(0, 0, w, h);
    ctx.font = '9px "Segoe UI", sans-serif';

    // Y axis: 0 / 50 / 100 %
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const r of [0, 0.5, 1]) {
        const y = Math.round(yOf(r)) + 0.5;
        ctx.strokeStyle = grid;
        ctx.lineWidth = 1;
        ctx.setLineDash(r === 0 ? [] : [2, 3]);
        ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke();
        ctx.fillStyle = muted;
        ctx.fillText(`${r * 100}%`, PAD.l - 5, y);
    }
    ctx.setLineDash([]);

    // X axis: evenly spaced time ticks across the selected window
    ctx.textBaseline = 'top';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
        const ts = from + ((now - from) * i) / ticks;
        ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
        ctx.fillStyle = muted;
        ctx.fillText(i === ticks ? 'Bây giờ' : fmtTick(ts, now - from), xOf(ts), h - PAD.b + 5);
    }

    const stats = document.getElementById(`hstats-${id}`);
    // Stats come from the raw log — averaging bucket peaks would overstate usage
    if (stats) {
        if (raw.length) {
            const peak = Math.max(...raw.map(p => p.risk));
            const avg = raw.reduce((s, p) => s + p.risk, 0) / raw.length;
            // Say so when the log is shorter than the selected range
            const short = now - from < RANGES[rangeKey] - 3600 ? ` · có ${fmtSpan(now - from)}` : '';
            stats.textContent = `Đỉnh ${Math.round(peak * 100)}% · TB ${Math.round(avg * 100)}%${short}`;
        } else stats.textContent = '';
    }

    if (series.length < 2) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = muted;
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.fillText('Chưa đủ dữ liệu — mỗi 15 phút ghi 1 điểm', PAD.l + pw / 2, (PAD.t + h - PAD.b) / 2);
        updateTip(id, null, g);
        return;
    }

    // Split into runs wherever the app was off long enough to leave a gap
    const runs = [];
    let run = [series[0]];
    for (let i = 1; i < series.length; i++) {
        if (series[i].ts - series[i - 1].ts > g.gap) { runs.push(run); run = []; }
        run.push(series[i]);
    }
    runs.push(run);

    const color = PROVIDER_COLORS[id] || '#94a3b8';
    const base = yOf(0);
    for (const r of runs) {
        ctx.beginPath();
        r.forEach((p, i) => (i === 0 ? ctx.moveTo(xOf(p.ts), yOf(p.risk)) : ctx.lineTo(xOf(p.ts), yOf(p.risk))));
        if (r.length > 1) {
            ctx.lineTo(xOf(r[r.length - 1].ts), base);
            ctx.lineTo(xOf(r[0].ts), base);
            ctx.closePath();
            ctx.fillStyle = color + '22';
            ctx.fill();
            ctx.beginPath();
            r.forEach((p, i) => (i === 0 ? ctx.moveTo(xOf(p.ts), yOf(p.risk)) : ctx.lineTo(xOf(p.ts), yOf(p.risk))));
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.stroke();
        } else {
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(xOf(r[0].ts), yOf(r[0].risk), 2, 0, Math.PI * 2); ctx.fill();
        }
    }

    const hp = chartHover.get(id);
    if (hp) {
        const x = xOf(hp.ts), y = yOf(hp.risk);
        ctx.strokeStyle = muted;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, PAD.t); ctx.lineTo(Math.round(x) + 0.5, base); ctx.stroke();
        // Surface ring keeps the marker legible on top of the line
        ctx.fillStyle = css.getPropertyValue('--bg-card').trim() || '#13131a';
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
    updateTip(id, hp, g);
}

function updateTip(id, p, g) {
    const tip = document.getElementById(`htip-${id}`);
    if (!tip) return;
    if (!p) { tip.hidden = true; return; }
    const d = new Date(p.ts * 1000);
    const two = n => String(n).padStart(2, '0');
    const day = t => `${two(t.getDate())}/${two(t.getMonth() + 1)}`;
    let when;
    if (p.live) when = 'Hiện tại';
    else if (p.start != null && g.size >= 86400) when = `Đỉnh ngày ${day(d)}`;
    else if (p.start != null) {
        const s = new Date(p.start * 1000), e = new Date((p.start + g.size) * 1000);
        when = `Đỉnh ${two(s.getHours())}h–${two(e.getHours())}h ${day(s)}`;
    } else when = `${two(d.getHours())}:${two(d.getMinutes())} · ${day(d)}`;
    tip.innerHTML = `<span class="tip-val" style="color:${usageColor(p.risk)}">${Math.round(p.risk * 100)}%</span><span class="tip-when">${when}</span>`;
    tip.hidden = false;
    const x = g.xOf(p.ts);
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(x - tw / 2, 0), g.w - tw)}px`;
    tip.style.top = `${Math.max(g.yOf(p.risk) - 34, 0)}px`;
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
               ${historyBlock(p.id)}`
        }
      </div>`;
    wireHistory(card, p.id);
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
