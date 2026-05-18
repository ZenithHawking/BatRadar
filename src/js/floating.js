import { invoke, listen, usageColorClass, usageColor } from './utils.js';

const icon    = document.getElementById('floating-icon');
const iconPct = document.getElementById('icon-pct');
const iconLogo = document.getElementById('icon-logo');
const iconBadge = document.getElementById('icon-badge');

const WEEKLY_OVERRIDE_THRESHOLD = 0.9;

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

function getProviderUsage(prov) {
    const data = providerUsage[prov];
    if (!data) return { util: 0, source: 'session' };
    const session = data.session?.utilization ?? 0;
    const weekly  = data.weekly?.utilization ?? 0;
    if (weekly >= WEEKLY_OVERRIDE_THRESHOLD && weekly > session) {
        return { util: weekly, source: 'weekly' };
    }
    return { util: session, source: 'session' };
}

// Get list of connected providers (have usage data), filtered by display toggle
let displayProviders = null; // null = show all

function getConnectedProviders() {
    const all = Object.keys(providerUsage);
    if (!displayProviders) return all;
    return all.filter(p => displayProviders.includes(p));
}

// Listen for display toggle changes from settings
listen('display-providers-changed', ({ payload }) => {
    displayProviders = payload.providers;
    rotateIndex = 0;
    updateFloatingDisplay();
});

// Load initial display config
invoke('get_display_providers').then(providers => {
    displayProviders = providers;
    updateFloatingDisplay();
}).catch(() => {});

// Current display index for rotation
let rotateIndex = 0;

function updateFloatingDisplay() {
    const connected = getConnectedProviders();
    if (connected.length === 0) {
        icon.className = 'floating-icon low';
        iconPct.textContent = '--';
        iconPct.style.color = '#94a3b8';
        return;
    }

    // If only 1 provider, always show it
    // If multiple, show current rotation target
    const prov = connected.length === 1
        ? connected[0]
        : connected[rotateIndex % connected.length];

    const { util, source } = getProviderUsage(prov);

    icon.className = `floating-icon ${usageColorClass(util)}`;
    iconPct.textContent = Math.round(util * 100) + '%';
    iconPct.style.color = usageColor(util);

    if (iconBadge) iconBadge.hidden = source !== 'weekly';

    if (ICON_MAP[prov] && iconLogo) {
        iconLogo.src = ICON_MAP[prov];
    }
}

// Rotate between providers every 10 seconds with fade
let rotating = false;
setInterval(() => {
    const connected = getConnectedProviders();
    if (connected.length > 1 && !rotating) {
        rotating = true;
        // Fade out
        icon.style.transition = 'opacity 0.4s ease';
        icon.style.opacity = '0.3';
        setTimeout(() => {
            rotateIndex = (rotateIndex + 1) % connected.length;
            updateFloatingDisplay();
            // Fade in
            icon.style.opacity = '1';
            setTimeout(() => { rotating = false; }, 400);
        }, 400);
    }
}, 10000);
