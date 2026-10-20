/**
 * Seasonal themes (opt-in).
 *
 * Off by default. When the user turns it on, html[data-season] switches the
 * Flight Deck tokens to the current season's palette and scenery, and a light
 * particle layer (petals, fireflies, leaves or snow) runs over the converter
 * and the empty start screen. It never runs over video playback.
 *
 * Cost control:
 *  - the layer is display:none unless one of those two screens is showing,
 *    so its animations do not run at all during playback;
 *  - particles are a fixed, small set of elements animating transform and
 *    opacity only (compositor-only, no layout or paint per frame);
 *  - animations pause while the window is hidden, and the OS reduce-motion
 *    preference hides the layer entirely (see styles/flightDeck.css).
 */

export const SEASONS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);
export const EFFECT_LEVELS = Object.freeze(['full', 'calm', 'off']);
const PARTICLE_COUNTS = Object.freeze({ full: 28, calm: 12, off: 0 });
const SETTING_ENABLED = 'seasonalTheme';
const SETTING_SEASON = 'seasonalThemeSeason';
const SETTING_EFFECTS = 'seasonalThemeEffects';
const RECHECK_MS = 60 * 60 * 1000;

/** Northern-hemisphere astronomical seasons, by month and day. */
export function seasonForDate(date = new Date()) {
    const md = (date.getMonth() + 1) * 100 + date.getDate();
    if (md >= 320 && md < 621) return 'spring';
    if (md >= 621 && md < 922) return 'summer';
    if (md >= 922 && md < 1221) return 'autumn';
    return 'winter';
}

/** Deterministic pseudo-random sequence so particles do not jump on re-render. */
function seeded(seed) {
    let value = seed;
    return () => {
        value = (value * 9301 + 49297) % 233280;
        return value / 233280;
    };
}

export function particleSpecs(season, level) {
    const count = PARTICLE_COUNTS[level] ?? 0;
    if (!SEASONS.includes(season) || count === 0) return [];
    const slow = level === 'calm' ? 1.5 : 1;
    const random = seeded(season.length * 977 + count);
    const specs = [];
    for (let i = 0; i < count; i++) {
        const left = `${(random() * 100).toFixed(1)}%`;
        const delay = `${(-random() * 30).toFixed(1)}s`;
        if (season === 'spring') {
            specs.push({ kind: 'petal', left, delay, width: 10 + random() * 7,
                color: ['#F7B6D2', '#FFD6E7', '#F2A7C9', '#FFF1F6'][Math.floor(random() * 4)],
                duration: (14 + random() * 10) * slow, opacity: 0.5 + random() * 0.4,
                inner: `fx-sway ${(2.6 + random() * 2.4).toFixed(1)}s ease-in-out ${delay} infinite alternate` });
        } else if (season === 'autumn') {
            specs.push({ kind: 'leaf', left, delay, width: 12 + random() * 10,
                color: ['#FF8A3D', '#E8C35A', '#C9502A', '#A8402E', '#D9732E'][Math.floor(random() * 5)],
                duration: (15 + random() * 12) * slow, opacity: 0.55 + random() * 0.35,
                inner: `fx-tumble ${(5 + random() * 5).toFixed(1)}s linear ${delay} infinite` });
        } else if (season === 'winter') {
            specs.push({ kind: 'snow', left, delay, width: 2 + random() * 5, color: '#F2F7FF',
                duration: (16 + random() * 18) * slow, opacity: 0.35 + random() * 0.55,
                inner: `fx-drift ${(2.5 + random() * 3).toFixed(1)}s ease-in-out ${delay} infinite alternate` });
        } else {
            specs.push({ kind: 'firefly', left, delay, width: 3 + random() * 3, color: '#FFE28A',
                top: `${(30 + random() * 65).toFixed(1)}%`,
                duration: (8 + random() * 7) * slow, opacity: 1,
                inner: `fx-blink ${(2 + random() * 2.5).toFixed(1)}s ease-in-out ${delay} infinite` });
        }
    }
    return specs;
}

function buildLayer(doc, layer, specs) {
    layer.replaceChildren();
    const fragment = doc.createDocumentFragment();
    for (const spec of specs) {
        const particle = doc.createElement('span');
        particle.className = `fx-p fx-${spec.kind}`;
        particle.style.left = spec.left;
        particle.style.opacity = String(spec.opacity.toFixed(2));
        particle.style.setProperty('--fx-d', `${spec.duration.toFixed(1)}s`);
        particle.style.setProperty('--fx-delay', spec.delay);
        particle.style.setProperty('--fx-w', `${spec.width.toFixed(1)}px`);
        particle.style.setProperty('--fx-c', spec.color);
        particle.style.setProperty('--fx-inner', spec.inner);
        if (spec.top) particle.style.setProperty('--fx-top', spec.top);
        if (spec.kind === 'firefly') particle.style.animationDirection = 'alternate';
        particle.appendChild(doc.createElement('i'));
        fragment.appendChild(particle);
    }
    layer.appendChild(fragment);
}

export function initSeasonalTheme({ api = window.electronAPI, doc = document } = {}) {
    const $ = (id) => doc.getElementById(id);
    const state = { enabled: false, season: 'auto', effects: 'full' };
    let layer = $('seasonalFx');
    if (!layer) {
        layer = doc.createElement('div');
        layer.id = 'seasonalFx';
        layer.setAttribute('aria-hidden', 'true');
        doc.body.appendChild(layer);
    }
    let builtKey = '';

    const activeSeason = () => (state.season === 'auto' ? seasonForDate() : state.season);

    function apply() {
        const root = doc.documentElement;
        if (!state.enabled) {
            delete root.dataset.season;
            if (builtKey) { layer.replaceChildren(); builtKey = ''; }
        } else {
            const season = activeSeason();
            root.dataset.season = season;
            const key = `${season}:${state.effects}`;
            if (key !== builtKey) {
                buildLayer(doc, layer, particleSpecs(season, state.effects));
                builtKey = key;
            }
        }
        syncControls();
    }

    // The layer only shows over the empty start screen (and the converter,
    // via body.converter-mode). Mirror the drop overlay's visibility onto the
    // body so CSS alone decides — no polling.
    const dropOverlay = $('dropOverlay');
    function syncWelcome() {
        doc.body.classList.toggle('fx-welcome', Boolean(dropOverlay && !dropOverlay.classList.contains('hidden')));
    }
    if (dropOverlay && typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncWelcome).observe(dropOverlay, { attributes: true, attributeFilter: ['class'] });
    }
    syncWelcome();

    doc.addEventListener('visibilitychange', () => layer.classList.toggle('is-paused', doc.hidden));

    // Follow the calendar while the app stays open across a season change.
    setInterval(() => { if (state.enabled && state.season === 'auto') apply(); }, RECHECK_MS);

    // ---- Settings controls ----
    const toggle = $('settingsSeasonalTheme');
    const seasonSelect = $('settingsSeasonalSeason');
    const effectsSelect = $('settingsSeasonalEffects');
    const detailRows = [$('settingsSeasonalSeasonRow'), $('settingsSeasonalEffectsRow')];

    function syncControls() {
        if (toggle) toggle.checked = state.enabled;
        if (seasonSelect) seasonSelect.value = state.season;
        if (effectsSelect) effectsSelect.value = state.effects;
        for (const row of detailRows) if (row) row.classList.toggle('hidden', !state.enabled);
    }

    const save = (key, value) => api?.setSetting?.(key, value)?.catch?.((error) => console.warn('[SEASONAL] save failed', error));

    toggle?.addEventListener('change', () => {
        state.enabled = toggle.checked;
        save(SETTING_ENABLED, state.enabled);
        apply();
    });
    seasonSelect?.addEventListener('change', () => {
        state.season = seasonSelect.value === 'auto' || SEASONS.includes(seasonSelect.value) ? seasonSelect.value : 'auto';
        save(SETTING_SEASON, state.season);
        apply();
    });
    effectsSelect?.addEventListener('change', () => {
        state.effects = EFFECT_LEVELS.includes(effectsSelect.value) ? effectsSelect.value : 'full';
        save(SETTING_EFFECTS, state.effects);
        apply();
    });

    apply();
    const load = async () => {
        if (!api?.getSetting) return;
        try {
            const [enabled, season, effects] = await Promise.all([
                api.getSetting(SETTING_ENABLED), api.getSetting(SETTING_SEASON), api.getSetting(SETTING_EFFECTS)
            ]);
            state.enabled = enabled === true;
            state.season = season === 'auto' || SEASONS.includes(season) ? season : 'auto';
            state.effects = EFFECT_LEVELS.includes(effects) ? effects : 'full';
            apply();
        } catch (error) {
            console.warn('[SEASONAL] could not load settings', error);
        }
    };
    const ready = load();
    return { ready, apply, state };
}
