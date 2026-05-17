import { invoke, listen, usageColorClass, usageColor } from './utils.js';

const icon    = document.getElementById('floating-icon');
const iconPct = document.getElementById('icon-pct');
const iconLogo = document.getElementById('icon-logo');

// Track highest usage across providers
let providerUsage = {};

// ─── Cursor style ─────────────────────────────────────────────────────────────
icon.style.cursor = 'grab';

// ─── Manual drag (absolute position, sync offset) ─────────────────────────────
let dragging = false;
let didDrag = false;
let offsetX = 0, offsetY = 0;

icon.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    dragging = true;
    didDrag  = false;
    offsetX = e.clientX;
    offsetY = e.clientY;
    icon.style.cursor = 'grabbing';
    e.preventDefault();
});

document.addEventListener('mousemove', e => {
    if (!dragging) return;
    didDrag = true;
    const newX = e.screenX - offsetX;
    const newY = e.screenY - offsetY;
    invoke('set_floating_pos', { x: newX, y: newY });
});

document.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    icon.style.cursor = 'grab';
    if (!didDrag && e.button === 0) {
        invoke('show_dashboard');
    }
});

// ─── Right-click opens settings ──────────────────────────────────────────────
document.addEventListener('contextmenu', e => {
    e.preventDefault();
    invoke('show_settings');
});

// ─── Usage updates (all providers) ────────────────────────────────────────────
listen('usage-update', ({ payload }) => {
    providerUsage[payload.provider] = payload.data;
    updateFloatingDisplay();
});

listen('provider-status-changed', ({ payload }) => {
    if (['disconnected', 'expired', 'error'].includes(payload.status)) {
        delete providerUsage[payload.provider];
        updateFloatingDisplay();
    }
});

// ─── Initial load ─────────────────────────────────────────────────────────────
['claude', 'codex'].forEach(p => {
    invoke('get_usage', { provider: p }).then(data => {
        providerUsage[p] = data;
        updateFloatingDisplay();
    }).catch(() => {});
});

// ─── Display logic ────────────────────────────────────────────────────────────
const ICON_MAP = {
    claude: 'assets/icons/claude.png',
    codex: 'assets/icons/codex.png',
    gemini: 'assets/icons/gemini.png',
};

function updateFloatingDisplay() {
    // Find provider with highest usage
    let maxUtil = 0;
    let maxProvider = 'claude';

    for (const [prov, data] of Object.entries(providerUsage)) {
        const vals = [
            data.session?.utilization,
            data.weekly?.utilization,
            data.weekly_opus?.utilization,
        ].filter(v => v != null);
        const hi = vals.length ? Math.max(...vals) : 0;
        if (hi >= maxUtil) {
            maxUtil = hi;
            maxProvider = prov;
        }
    }

    // Update icon to show the provider with highest usage
    icon.className = `floating-icon ${usageColorClass(maxUtil)}`;
    iconPct.textContent = Math.round(maxUtil * 100) + '%';
    iconPct.style.color = usageColor(maxUtil);

    // Show logo of the highest-usage provider
    if (ICON_MAP[maxProvider] && iconLogo) {
        iconLogo.src = ICON_MAP[maxProvider];
    }
}
