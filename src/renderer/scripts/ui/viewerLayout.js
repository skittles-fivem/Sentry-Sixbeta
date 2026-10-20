/**
 * Telemetry rail (Flight Deck viewer layout).
 *
 * With the rail on (the default), the telemetry dashboard and the map sit in a
 * fixed column on the right of the window instead of floating over the
 * cameras, and the camera grid shrinks to make room. Everything is done with
 * a body class plus CSS; the dashboard and map elements are never moved in
 * the DOM, so the compact dashboard, playback and export code that looks them
 * up by ID keep working unchanged. Users who prefer floating panels can turn
 * the rail off in Settings > Display.
 */

const SETTING_RAIL = 'telemetryRail';

export function initViewerLayout({ api = window.electronAPI, doc = document, win = window, onLayoutChange } = {}) {
    const $ = (id) => doc.getElementById(id);
    const body = doc.body;
    const dashboard = $('dashboardVis');
    const toggle = $('settingsTelemetryRail');
    let enabled = true;

    // The map sits under the dashboard; its offset follows the dashboard's
    // real height (it grows when the details drawer opens, and is 0 when the
    // dashboard is hidden or shown compact on the front camera instead).
    function syncDashboardHeight() {
        if (!dashboard) return;
        const visible = enabled && dashboard.offsetParent !== null && !dashboard.classList.contains('dashboard-vis-compact');
        const height = visible ? Math.ceil(dashboard.getBoundingClientRect().height) : 0;
        doc.documentElement.style.setProperty('--rail-dash-h', `${height}px`);
    }

    let applied = null;
    function apply() {
        body.classList.toggle('fd-rail', enabled);
        if (toggle) toggle.checked = enabled;
        syncDashboardHeight();
        if (applied === enabled) return;
        const changed = applied !== null;
        applied = enabled;
        // Only an actual switch moves things; the first apply sets the
        // starting layout before anything is drawn.
        if (!changed) return;
        // Let the camera grid, resize handles and map re-measure.
        win.dispatchEvent?.(new Event('resize'));
        onLayoutChange?.(enabled);
    }

    if (dashboard && typeof ResizeObserver === 'function') {
        new ResizeObserver(syncDashboardHeight).observe(dashboard);
    }
    if (dashboard && typeof MutationObserver === 'function') {
        new MutationObserver(syncDashboardHeight).observe(dashboard, { attributes: true, attributeFilter: ['class', 'style'] });
    }

    toggle?.addEventListener('change', () => {
        enabled = toggle.checked;
        api?.setSetting?.(SETTING_RAIL, enabled)?.catch?.((error) => console.warn('[LAYOUT] save failed', error));
        apply();
    });

    apply();
    const ready = (async () => {
        if (!api?.getSetting) return;
        try {
            const saved = await api.getSetting(SETTING_RAIL);
            enabled = saved !== false;
            apply();
        } catch (error) {
            console.warn('[LAYOUT] could not load telemetry rail setting', error);
        }
    })();
    return { ready, isEnabled: () => enabled, sync: syncDashboardHeight };
}
