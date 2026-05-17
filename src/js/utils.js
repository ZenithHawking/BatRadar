// Electron IPC bridge — same API surface as old Tauri version
export const invoke = (cmd, args) => window.electronAPI.invoke(cmd, args || {});
export const listen = (event, cb)  => window.electronAPI.on(event, cb);

export function formatDuration(seconds) {
    if (seconds <= 0) return 'now';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

export function secondsUntil(iso) {
    if (!iso) return 0;
    return Math.max(0, Math.floor((new Date(iso) - Date.now()) / 1000));
}

export function usageColorClass(u) {
    if (u >= 0.95) return 'critical';
    if (u >= 0.80) return 'high';
    if (u >= 0.60) return 'medium';
    return 'low';
}

export function usageColor(u) {
    if (u >= 0.95) return '#EF4444';
    if (u >= 0.80) return '#F97316';
    if (u >= 0.60) return '#EAB308';
    return '#22C55E';
}

export function pct(u) { return `${Math.round(u * 100)}%`; }

export const PROVIDER_COLORS = { claude: '#D97706', codex: '#10B981', gemini: '#3B82F6' };
