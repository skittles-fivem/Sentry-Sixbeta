const ACTIVE_STATES = new Set([
    'discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry',
    'verifying', 'copying', 'replacing', 'paused', 'paused_network'
]);

const PIPELINE_ORDER = ['discover', 'encode', 'verify', 'save'];
const GROUPS = ['RecentClips', 'SavedClips', 'SentryClips'];
const DEFAULT_GROUP_ORDER = ['SavedClips', 'SentryClips', 'RecentClips'];
// Mirrors CONCURRENCY in src/main/converter/contracts.js (not loadable here).
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 64;
const LISTED_CONCURRENCY = 10; // higher values use the Custom box
const DEFAULT_CONCURRENCY = 5;
const CONCURRENCY_STORAGE_KEY = 'converterConcurrency';
const VERIFY_STORAGE_KEY = 'converterVerifyMode';
const VERIFY_MODES = ['off', 'quick', 'full'];

const PAUSED_STATES = new Set(['paused', 'paused_network']);

// Time the job has spent working: paused periods (also while the app was
// closed) and the gap before a retry are left out. updatedAt marks the last
// state change, so a paused or finished job's clock stops there.
function workingMs(job, at = Date.now()) {
    if (!job || !Number.isFinite(job.createdAt)) return 0;
    const stopped = !ACTIVE_STATES.has(job.state) || PAUSED_STATES.has(job.state);
    const end = stopped ? (Number.isFinite(job.updatedAt) ? job.updatedAt : job.createdAt) : at;
    return Math.max(0, end - job.createdAt - (Number.isFinite(job.pausedMs) ? job.pausedMs : 0));
}

function normalizeConcurrency(value) {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(number) && number >= MIN_CONCURRENCY && number <= MAX_CONCURRENCY ? number : null;
}

const STATUS_LABELS = Object.freeze({
    discovering: ['statusDiscovering', 'Discovering footage'],
    waiting: ['statusWaiting', 'Preparing next file'],
    staging: ['statusStaging', 'Staging locally'],
    encoding: ['statusEncoding', 'Encoding video'],
    'writing-telemetry': ['statusWritingTelemetry', 'Writing telemetry'],
    verifying: ['statusVerifying', 'Verifying telemetry'],
    copying: ['statusCopying', 'Saving verified file'],
    replacing: ['statusReplacing', 'Replacing verified original'],
    paused: ['statusPaused', 'Paused at a safe boundary'],
    paused_network: ['statusWaitingForConnection', 'Waiting for connection'],
    completed: ['statusCompleted', 'Conversion complete'],
    cancelled: ['statusCancelled', 'Conversion cancelled'],
    failed: ['statusFailed', 'Conversion stopped']
});

function formatBytes(bytes, locale) {
    const safe = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = safe;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rendered = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: unit === 0 ? 0 : 2
    }).format(unit === 0 ? safe : value);
    return `${rendered} ${units[unit]}`;
}

function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    return hours > 0
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

// "1h 05m", "12m 30s", "45s".
function formatRemaining(milliseconds) {
    const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
    return `${rest}s`;
}

const TIMING_LABELS = Object.freeze({
    inspect: ['timingInspect', 'Probe file'],
    source: ['timingSource', 'Read source'],
    timeline: ['timingTimeline', 'Read telemetry'],
    encode: ['timingEncode', 'Encode'],
    metadata: ['timingMetadata', 'Write telemetry'],
    verify: ['timingVerify', 'Verify'],
    saveWait: ['timingSaveWait', 'Wait to save'],
    save: ['timingSave', 'Save / replace'],
    cleanup: ['timingCleanup', 'Clean up']
});
// Throughput is measured over this trailing window of finished-file samples.
const SPEED_WINDOW_MS = 3 * 60 * 1000;
const SPEED_MIN_SPAN_MS = 10 * 1000;

function apiError(code) {
    return Object.assign(new Error(code || 'OPERATION_FAILED'), { code: code || 'OPERATION_FAILED' });
}

function unwrap(result) {
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
        if (result.ok === true) return result.value;
        throw apiError(result.error?.code);
    }
    return result;
}

function selected(options, dataKey, fallback) {
    return options.find((entry) => entry.checked)?.dataset?.[dataKey] || fallback;
}

function setText(element, value) {
    if (element) element.textContent = value == null ? '' : String(value);
}

function setHidden(element, hidden) {
    if (element) element.hidden = Boolean(hidden);
}

function setDisabled(element, disabled) {
    if (element) element.disabled = Boolean(disabled);
}

function createRow(container, primary, secondary = '') {
    const documentApi = container?.ownerDocument;
    if (!container || !documentApi?.createElement) return null;
    const row = documentApi.createElement('div');
    row.classList.add('converter-row');
    const label = documentApi.createElement('span');
    label.classList.add('converter-row-primary');
    label.textContent = primary;
    row.append(label);
    if (secondary) {
        const detail = documentApi.createElement('span');
        detail.classList.add('converter-row-secondary');
        detail.textContent = secondary;
        row.append(detail);
    }
    return row;
}

function renderRows(container, rows) {
    if (!container) return;
    container.textContent = rows.map(([primary, secondary]) => `${primary}${secondary ? ` — ${secondary}` : ''}`).join('\n');
    const rendered = rows.map(([primary, secondary]) => createRow(container, primary, secondary)).filter(Boolean);
    if (typeof container.replaceChildren === 'function' && rendered.length) container.replaceChildren(...rendered);
}

function collectElements(root) {
    const byId = (id) => root?.querySelector?.(`#${id}`) || null;
    const all = (selector) => [...(root?.querySelectorAll?.(selector) || [])];
    const orderRows = all('[data-converter-order-group]').map((row) => ({
        group: row.dataset?.converterOrderGroup,
        row,
        rank: row.querySelector?.('[data-converter-order-rank]') || null,
        up: row.querySelector?.('[data-converter-order-move="up"]') || null,
        down: row.querySelector?.('[data-converter-order-move="down"]') || null
    }));
    return {
        sourcePath: byId('converterSourcePath'),
        destinationPath: byId('converterDestinationPath'),
        sourceButton: byId('converterChooseSource'),
        destinationButton: byId('converterChooseDestination'),
        groupOptions: all('[data-converter-group]'),
        orderRows,
        codecOptions: all('[data-converter-codec]'),
        profileOptions: all('[data-converter-profile]'),
        profileSelect: byId('converterProfileSelect'),
        customBitrate: byId('converterCustomBitrate'),
        customBitrateRow: byId('converterCustomBitrateRow'),
        qualityLevel: byId('converterQualityLevel'),
        qualityRow: byId('converterQualityRow'),
        verifyMode: byId('converterVerifyMode'),
        verifyReplaceNote: byId('converterVerifyReplaceNote'),
        benchmarkVerifyTable: byId('converterBenchmarkVerifyTable'),
        benchmarkVerifyHead: byId('converterBenchmarkVerifyHead'),
        benchmarkVerifyRows: byId('converterBenchmarkVerifyRows'),
        autoEnabled: byId('converterAutoEnabled'),
        autoInterval: byId('converterAutoInterval'),
        autoWindowEnabled: byId('converterAutoWindowEnabled'),
        autoStart: byId('converterAutoStart'),
        autoEnd: byId('converterAutoEnd'),
        autoKeepRunning: byId('converterAutoKeepRunning'),
        autoLogin: byId('converterAutoLogin'),
        autoStatus: byId('converterAutoStatus'),
        autoCheckNow: byId('converterAutoCheckNow'),
        concurrency: byId('converterConcurrency'),
        concurrencyCustom: byId('converterConcurrencyCustom'),
        concurrencyCustomRow: byId('converterConcurrencyCustomRow'),
        outputOptions: all('[data-converter-output]'),
        replaceOption: byId('converterReplaceOption'),
        replaceInput: byId('converterOutputReplace'),
        replaceCapability: byId('converterReplaceCapability'),
        replacementConfirmation: byId('converterReplacementConfirmation'),
        replacementWarning: byId('converterReplacementWarning'),
        replacementConfirmationRow: byId('converterReplacementConfirmationRow'),
        estimate: byId('converterEstimate'),
        startButton: byId('converterStart'),
        pauseButton: byId('converterPause'),
        resumeButton: byId('converterResume'),
        cancelButton: byId('converterCancel'),
        retryButton: byId('converterRetry'),
        dismissButton: byId('converterDismissSummary'),
        status: byId('converterStatus'),
        currentFile: byId('converterCurrentFile'),
        currentProgress: byId('converterCurrentProgress'),
        currentProgressFill: byId('converterCurrentProgressFill'),
        elapsed: byId('converterElapsed'),
        countDiscovered: byId('converterCountDiscovered'),
        countCompleted: byId('converterCountCompleted'),
        countSkipped: byId('converterCountSkipped'),
        countFailed: byId('converterCountFailed'),
        countWaiting: byId('converterCountWaiting'),
        processedBytes: byId('converterProcessedBytes'),
        speed: byId('converterSpeed'),
        fps: byId('converterFps'),
        benchmarkButton: byId('converterBenchmarkBtn'),
        benchmarkDialog: byId('converterBenchmarkDialog'),
        benchmarkStatus: byId('converterBenchmarkStatus'),
        benchmarkTable: byId('converterBenchmarkTable'),
        benchmarkRows: byId('converterBenchmarkRows'),
        benchmarkBest: byId('converterBenchmarkBest'),
        benchmarkRun: byId('converterBenchmarkRun'),
        benchmarkApply: byId('converterBenchmarkApply'),
        benchmarkApplyAlt: byId('converterBenchmarkApplyAlt'),
        benchmarkHead: byId('converterBenchmarkHead'),
        benchmarkClose: byId('converterBenchmarkClose'),
        eta: byId('converterEta'),
        timings: byId('converterTimings'),
        timingRows: byId('converterTimingRows'),
        reconnectBanner: byId('converterReconnectBanner'),
        cleanupBanner: byId('converterCleanupBanner'),
        errorRows: byId('converterErrorRows'),
        pipeline: byId('converterPipeline'),
        pipelineStages: all('[data-converter-phase]'),
        summary: byId('converterSummary'),
        summaryRetention: byId('converterSummaryRetention'),
        summaryFiles: byId('converterSummaryFiles'),
        summarySkipped: byId('converterSummarySkipped'),
        summaryFailed: byId('converterSummaryFailed'),
        summarySource: byId('converterSummarySource'),
        summaryOutput: byId('converterSummaryOutput'),
        summarySaved: byId('converterSummarySaved'),
        summaryPercent: byId('converterSummaryPercent'),
        summaryAssets: byId('converterSummaryAssets'),
        summaryElapsed: byId('converterSummaryElapsed'),
        summaryGroups: byId('converterSummaryGroups')
    };
}

function phaseFor(snapshot) {
    let state = snapshot?.state;
    if (state === 'paused') state = snapshot?.recovery?.fromState || 'waiting';
    if (state === 'paused_network') state = snapshot?.recovery?.resumeState || 'waiting';
    if (state === 'discovering') return 'discover';
    if (['waiting', 'staging', 'encoding', 'writing-telemetry'].includes(state)) return 'encode';
    if (state === 'verifying') return 'verify';
    if (['copying', 'replacing'].includes(state)) return 'save';
    if (state === 'completed') return 'complete';
    return null;
}

function createFootageConverterController(options = {}) {
    const api = options.api;
    if (!api) throw new TypeError('converter api is required');
    const elements = options.elements || collectElements(options.root);
    const notify = typeof options.notify === 'function' ? options.notify : () => {};
    const confirmAction = typeof options.confirm === 'function'
        ? options.confirm
        : (message) => globalThis.confirm?.(message) === true;
    const getLocale = typeof options.getLocale === 'function'
        ? options.getLocale
        : () => options.locale || options.root?.documentElement?.lang || globalThis.document?.documentElement?.lang || 'en';
    const renderBytes = options.formatBytes || ((bytes) => formatBytes(bytes, getLocale()));
    const translate = typeof options.t === 'function' ? options.t : (key) => key;
    const subscribeLanguage = typeof options.onLanguageChange === 'function' ? options.onLanguageChange : null;
    let capabilities = { separatePublication: 'unavailable', ownershipCleanup: 'unavailable', replacement: 'unavailable' };
    let snapshot = null;
    let latestRevision = -1;
    let initialized = false;
    let initPromise = null;
    let unsubscribe = null;
    let unsubscribeLanguage = null;
    let visible = false;
    let pendingStartEvents = null;
    let groupOrder = [...DEFAULT_GROUP_ORDER];
    const storage = options.storage !== undefined ? options.storage : globalThis.localStorage;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    let speedSamples = [];
    let speedJobId = null;

    // Files finished per minute over the recent window (falls back to the whole
    // run while the window is still short), plus the time left at that pace.
    function throughput(done, remaining) {
        const time = now();
        if (snapshot?.id !== speedJobId) {
            speedJobId = snapshot?.id ?? null;
            speedSamples = [];
        }
        if (!speedSamples.length || speedSamples[speedSamples.length - 1].done !== done) speedSamples.push({ time, done });
        while (speedSamples.length > 2 && time - speedSamples[1].time > SPEED_WINDOW_MS) speedSamples.shift();
        const first = speedSamples[0];
        let perMinute = null;
        if (speedSamples.length > 1 && time - first.time >= SPEED_MIN_SPAN_MS && done > first.done) {
            perMinute = (done - first.done) / ((time - first.time) / 60000);
        } else if (snapshot?.createdAt && done > 0 && workingMs(snapshot, time) >= SPEED_MIN_SPAN_MS) {
            perMinute = done / (workingMs(snapshot, time) / 60000);
        }
        if (!perMinute || !Number.isFinite(perMinute)) return { perMinute: null, remainingMs: null };
        return { perMinute, remainingMs: remaining > 0 ? (remaining / perMinute) * 60000 : 0 };
    }

    function renderTimings() {
        const timings = snapshot?.timings;
        const files = timings?.files;
        const rows = Number.isSafeInteger(files) && files > 0
            ? Object.entries(timings.totalMs || {})
                .filter(([phase, total]) => TIMING_LABELS[phase] && Number(total) > 0)
                .map(([phase, total]) => [phase, Number(total) / files])
                .sort((left, right) => right[1] - left[1])
            : [];
        setHidden(elements.timings, rows.length === 0);
        if (!elements.timingRows || rows.length === 0) return;
        const largest = rows[0][1];
        const documentRef = elements.timingRows.ownerDocument || globalThis.document;
        elements.timingRows.replaceChildren(...rows.map(([phase, average]) => {
            const row = documentRef.createElement('li');
            row.className = 'converter-timing-row';
            const label = documentRef.createElement('span');
            label.textContent = message(...TIMING_LABELS[phase]);
            const bar = documentRef.createElement('span');
            bar.className = 'converter-timing-bar';
            const fill = documentRef.createElement('span');
            if (fill.style) fill.style.width = `${Math.max(2, Math.round((average / largest) * 100))}%`;
            bar.append?.(fill);
            const value = documentRef.createElement('span');
            value.className = 'converter-timing-value';
            value.textContent = `${(average / 1000).toFixed(1)}s`;
            row.append?.(label, bar, value);
            row.setAttribute?.('data-phase', phase);
            return row;
        }));
    }

    function storedConcurrency() {
        try { return normalizeConcurrency(storage?.getItem?.(CONCURRENCY_STORAGE_KEY)); } catch (_) { return null; }
    }

    function rememberConcurrency(value) {
        try { storage?.setItem?.(CONCURRENCY_STORAGE_KEY, String(value)); } catch (_) { /* preference only */ }
    }

    function selectedProfile() {
        const value = elements.profileSelect?.value;
        return ['conservative', 'balanced', 'aggressive', 'custom', 'quality'].includes(value)
            ? value : selected(elements.profileOptions, 'converterProfile', 'balanced');
    }

    // Mbps in the box, kbps on the wire (matches CUSTOM_BITRATE_KBPS in contracts.js).
    function customBitrateKbps() {
        const mbps = Number(elements.customBitrate?.value);
        if (!Number.isFinite(mbps)) return null;
        const kbps = Math.round(mbps * 1000);
        return kbps >= 250 && kbps <= 100_000 ? kbps : null;
    }

    function selectedQualityLevel() {
        const value = elements.qualityLevel?.value;
        return ['high', 'balanced', 'small'].includes(value) ? value : 'balanced';
    }

    // Profile-specific settings sent with a start or benchmark request.
    function profileSettings(profileId) {
        if (profileId === 'custom') return { bitrateKbps: customBitrateKbps() };
        if (profileId === 'quality') return { qualityLevel: selectedQualityLevel() };
        return {};
    }

    function updateCustomBitrateVisibility() {
        setHidden(elements.customBitrateRow, selectedProfile() !== 'custom');
        setHidden(elements.qualityRow, selectedProfile() !== 'quality');
    }

    function storedVerifyMode() {
        try {
            const value = storage?.getItem?.(VERIFY_STORAGE_KEY);
            return VERIFY_MODES.includes(value) ? value : null;
        } catch (_) { return null; }
    }

    function replacingSelected() {
        return selected(elements.outputOptions, 'converterOutput', 'separate') === 'replace';
    }

    // Quick is the default. Replacing originals never runs without checks.
    function selectedVerifyMode() {
        const value = VERIFY_MODES.includes(elements.verifyMode?.value) ? elements.verifyMode.value : 'quick';
        return value === 'off' && replacingSelected() ? 'quick' : value;
    }

    function updateVerifyOptions() {
        const replacing = replacingSelected();
        const offOption = [...(elements.verifyMode?.options || [])].find((option) => option.value === 'off');
        if (offOption) offOption.disabled = replacing;
        const forced = replacing && elements.verifyMode?.value === 'off';
        if (forced) elements.verifyMode.value = 'quick';
        setHidden(elements.verifyReplaceNote, !replacing);
    }

    function customConcurrencySelected() {
        return elements.concurrency?.value === 'custom';
    }

    function selectedConcurrency() {
        const raw = customConcurrencySelected() ? elements.concurrencyCustom?.value : elements.concurrency?.value;
        return normalizeConcurrency(raw) ?? storedConcurrency() ?? DEFAULT_CONCURRENCY;
    }

    function updateConcurrencyCustomVisibility() {
        setHidden(elements.concurrencyCustomRow, !customConcurrencySelected());
    }

    function setConcurrency(value) {
        if (elements.concurrency) {
            const custom = value > LISTED_CONCURRENCY && Boolean(elements.concurrencyCustom);
            elements.concurrency.value = custom ? 'custom' : String(value);
            if (custom) elements.concurrencyCustom.value = String(value);
        }
        updateConcurrencyCustomVisibility();
    }

    function message(key, fallback, params) {
        const fullKey = `ui.converter.${key}`;
        const value = params === undefined ? translate(fullKey) : translate(fullKey, params);
        if (value && value !== fullKey) return value;
        return String(fallback).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match);
    }

    function setChecked(optionsList, dataKey, value) {
        for (const entry of optionsList) entry.checked = entry.dataset?.[dataKey] === value;
    }

    function syncConfig(config) {
        if (!config) return;
        if (elements.sourcePath) elements.sourcePath.value = config.sourceRoot || '';
        if (elements.destinationPath) elements.destinationPath.value = config.destinationRoot || '';
        setChecked(elements.codecOptions, 'converterCodec', config.codec);
        setChecked(elements.profileOptions, 'converterProfile', config.profileId);
        if (elements.profileSelect && config.profileId) elements.profileSelect.value = config.profileId;
        if (elements.customBitrate && Number.isSafeInteger(config.bitrateKbps)) {
            elements.customBitrate.value = String(config.bitrateKbps / 1000);
        }
        if (elements.qualityLevel && ['high', 'balanced', 'small'].includes(config.qualityLevel)) {
            elements.qualityLevel.value = config.qualityLevel;
        }
        // Jobs saved before the setting existed ran full verification.
        if (elements.verifyMode) elements.verifyMode.value = VERIFY_MODES.includes(config.verifyMode) ? config.verifyMode : 'full';
        updateCustomBitrateVisibility();
        setChecked(elements.outputOptions, 'converterOutput', config.outputMode);
        const included = new Set(config.includedGroups || []);
        for (const entry of elements.groupOptions) entry.checked = included.has(entry.dataset?.converterGroup);
        groupOrder = Array.isArray(config.groupOrder) && config.groupOrder.length === GROUPS.length
            ? [...config.groupOrder]
            : [...DEFAULT_GROUP_ORDER];
        if (elements.replacementConfirmation) elements.replacementConfirmation.checked = config.replacementConfirmed === true;
        const concurrency = normalizeConcurrency(config.concurrency);
        if (concurrency !== null) setConcurrency(concurrency);
        updateOutputMode();
    }

    function renderGroupOrder(disabled = false) {
        for (const item of elements.orderRows || []) {
            const index = groupOrder.indexOf(item.group);
            if (item.row?.style) item.row.style.order = String(index);
            setText(item.rank, String(index + 1));
            setDisabled(item.up, disabled || index <= 0);
            setDisabled(item.down, disabled || index < 0 || index >= groupOrder.length - 1);
        }
    }

    function moveGroup(group, direction) {
        const index = groupOrder.indexOf(group);
        const nextIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || nextIndex < 0 || nextIndex >= groupOrder.length) return;
        [groupOrder[index], groupOrder[nextIndex]] = [groupOrder[nextIndex], groupOrder[index]];
        renderGroupOrder(false);
    }

    function updateCapabilities(next) {
        capabilities = next || capabilities;
        const replacementAvailable = capabilities.replacement === 'available';
        setDisabled(elements.replaceInput, !replacementAvailable);
        if (elements.replaceOption) {
            elements.replaceOption.setAttribute?.('aria-disabled', replacementAvailable ? 'false' : 'true');
            elements.replaceOption.classList?.toggle('is-unavailable', !replacementAvailable);
        }
        setText(elements.replaceCapability, replacementAvailable
            ? message('capabilityReplaceAvailable', 'Available on this filesystem')
            : message('capabilityReplaceUnavailable', 'Replace originals is not available on this system. Originals remain protected.'));
        if (!replacementAvailable && selected(elements.outputOptions, 'converterOutput', 'separate') === 'replace') {
            setChecked(elements.outputOptions, 'converterOutput', 'separate');
        }
        updateOutputMode();
    }

    function updateOutputMode() {
        const mode = selected(elements.outputOptions, 'converterOutput', 'separate');
        const replacing = mode === 'replace' && capabilities.replacement === 'available';
        setHidden(elements.replacementConfirmationRow, !replacing);
        setDisabled(elements.destinationPath, replacing);
        setDisabled(elements.destinationButton, replacing);
        updateVerifyOptions();
        const sourceRoot = elements.sourcePath?.value?.trim() || message('sourcePlaceholder', 'the selected source folder');
        setText(elements.replacementWarning, message(
            'replacementWarning',
            'Source {sourceRoot}: each original is backed up before replacement. If replacement fails, the backup is restored so you can roll back safely.',
            { sourceRoot }
        ));
    }

    function renderPipeline() {
        const current = phaseFor(snapshot);
        const activeIndex = PIPELINE_ORDER.indexOf(current);
        if (elements.pipeline) elements.pipeline.dataset.currentPhase = current || 'idle';
        for (const stage of elements.pipelineStages) {
            const index = PIPELINE_ORDER.indexOf(stage.dataset?.phase);
            const complete = current === 'complete' || (activeIndex >= 0 && index < activeIndex);
            stage.classList?.toggle('is-active', index === activeIndex);
            stage.classList?.toggle('is-complete', complete);
            stage.setAttribute?.('aria-current', index === activeIndex ? 'step' : 'false');
        }
    }

    function renderSummary(items) {
        const summary = snapshot?.summary;
        setHidden(elements.summary, !summary);
        if (!summary) return;
        setText(elements.summaryRetention, snapshot?.config?.outputMode === 'separate'
            ? message('summarySeparateRetention', 'Video size reduction is not physical storage reclaimed. Originals are retained in separate mode.')
            : message('summaryRetention', 'Video size reduction is not physical storage reclaimed. Retained cleanup artifacts still consume space.'));
        const skipped = snapshot?.itemStateCounts?.skipped
            ?? items.filter((item) => item.state === 'skipped').length;
        const failed = snapshot?.itemStateCounts?.failed
            ?? items.filter((item) => item.state === 'failed').length;
        const percent = summary.sourceVideoBytes > 0 ? Math.round((summary.savedBytes / summary.sourceVideoBytes) * 100) : 0;
        setText(elements.summaryFiles, summary.files);
        setText(elements.summarySkipped, skipped);
        setText(elements.summaryFailed, failed);
        setText(elements.summarySource, renderBytes(summary.sourceVideoBytes));
        setText(elements.summaryOutput, renderBytes(summary.outputVideoBytes));
        setText(elements.summarySaved, renderBytes(summary.savedBytes));
        setText(elements.summaryPercent, `${percent}%`);
        setText(elements.summaryAssets, renderBytes(summary.copiedAssetBytes));
        setText(elements.summaryElapsed, formatDuration(workingMs(snapshot, now())));
        renderRows(elements.summaryGroups, GROUPS.map((group) => {
            const counters = summary.groups?.[group] || { files: 0, savedBytes: 0 };
            return [group, message('summaryGroup', '{count} files · {bytes} video size reduction', {
                count: counters.files,
                bytes: renderBytes(counters.savedBytes)
            })];
        }));
    }

    function render() {
        const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
        const counters = snapshot?.counters || {};
        const activeItem = items.find((item) => item.id === snapshot?.activeItemId)
            || items.find((item) => item.state === 'processing');
        const failedItems = items.filter((item) => item.state === 'failed');
        const cleanupItems = items.filter((item) => String(item.resultCode || '').includes('cleanup-pending'));
        const stateCount = (state) => snapshot?.itemStateCounts?.[state]
            ?? items.filter((item) => item.state === state).length;
        const cleanupPendingCount = snapshot?.cleanupPendingCount ?? cleanupItems.length;
        const progress = snapshot?.progress;
        const active = ACTIVE_STATES.has(snapshot?.state);
        const paused = snapshot?.state === 'paused';

        const statusLabel = STATUS_LABELS[snapshot?.state];
        setText(elements.status, snapshot
            ? statusLabel ? message(...statusLabel) : message('statusReady', 'Converter ready')
            : message('ready', 'Ready to configure'));
        const converting = snapshot?.itemStateCounts?.active ?? items.filter((item) => item.state === 'processing').length;
        setText(elements.currentFile, active && converting > 1
            ? message('convertingFiles', 'Converting {count} files at once', { count: converting })
            : activeItem?.relativePath || message('noFileActive', 'No file active'));
        setText(elements.currentProgress, progress?.outTimeUs !== undefined
            ? message('progressEncoded', '{duration} encoded', { duration: formatDuration(progress.outTimeUs / 1000) })
            : activeItem ? message('progressWorking', 'Working on current file') : '—');
        elements.currentProgressFill?.classList?.toggle('is-live', Boolean(activeItem && active));
        setText(elements.elapsed, snapshot ? formatDuration(workingMs(snapshot, now())) : '00:00');
        setText(elements.countDiscovered, snapshot?.itemCount ?? items.length);
        setText(elements.countCompleted, stateCount('completed'));
        setText(elements.countSkipped, stateCount('skipped'));
        setText(elements.countFailed, stateCount('failed'));
        setText(elements.countWaiting, stateCount('queued'));
        setText(elements.processedBytes, renderBytes(counters.sourceVideoBytes || 0));
        const finished = stateCount('completed') + stateCount('skipped') + stateCount('failed');
        const remaining = stateCount('queued') + converting;
        // A pause starts the recent-speed window over (paused time is not speed).
        if (PAUSED_STATES.has(snapshot?.state)) speedSamples = [];
        let pace = active && !paused ? throughput(finished, remaining) : { perMinute: null, remainingMs: null };
        // A finished run keeps showing its overall average speed (working
        // time only, so pauses do not drag it down).
        if (!active && snapshot?.state === 'completed' && finished > 0) {
            const minutes = workingMs(snapshot, now()) / 60000;
            if (minutes > 0) pace = { perMinute: finished / minutes, remainingMs: null };
        }
        setText(elements.speed, pace.perMinute === null ? '—'
            : message('speedValue', '{rate} files/min', { rate: pace.perMinute.toFixed(pace.perMinute < 10 ? 1 : 0) }));
        // Full snapshots carry no progress; keep the last reading briefly.
        const fps = lastFps && Date.now() - lastFps.at < 5_000 ? lastFps.value : null;
        setText(elements.fps, active && !paused && Number.isFinite(fps) && fps > 0
            ? message('fpsValue', '{fps} fps', { fps: fps >= 100 ? Math.round(fps) : fps.toFixed(1) }) : '—');
        setText(elements.eta, pace.remainingMs === null || snapshot?.discoveryComplete === false && remaining === 0 ? '—'
            : formatRemaining(pace.remainingMs));
        renderTimings();
        setHidden(elements.reconnectBanner, snapshot?.state !== 'paused_network');
        setHidden(elements.cleanupBanner, cleanupPendingCount === 0);
        if (cleanupPendingCount) {
            setText(elements.cleanupBanner, message('cleanupPending', '{count} {file} with cleanup pending. Retained artifacts still consume space; hardlinks share disk allocation.', {
                count: cleanupPendingCount,
                file: message(cleanupPendingCount === 1 ? 'cleanupFileSingular' : 'cleanupFilePlural', cleanupPendingCount === 1 ? 'file' : 'files')
            }));
        }
        renderRows(elements.errorRows, failedItems.map((item) => [item.relativePath || item.id, item.failure?.code || 'operation-failed']));
        setHidden(elements.errorRows, failedItems.length === 0);
        setDisabled(elements.startButton, active);
        setDisabled(elements.concurrency, active);
        setDisabled(elements.concurrencyCustom, active);
        setDisabled(elements.benchmarkButton, active);
        setDisabled(elements.profileSelect, active);
        setDisabled(elements.customBitrate, active);
        setDisabled(elements.pauseButton, !active || paused || snapshot?.state === 'paused_network');
        setDisabled(elements.resumeButton, !paused);
        setDisabled(elements.cancelButton, !active);
        setDisabled(elements.retryButton, failedItems.length === 0 || !['completed', 'failed'].includes(snapshot?.state));
        renderGroupOrder(active);
        renderPipeline();
        renderSummary(items);
        renderAutoStatus();
    }

    let lastFps = null;
    let benchmarkRunning = false;
    let benchmarkBest = null;

    function encoderLabel(entry) {
        return entry?.codec ? `${entry.codec} (${entry.hardware ? 'GPU' : 'CPU'})` : '—';
    }

    function benchmarkErrorText(error) {
        const code = error?.code || 'OPERATION_FAILED';
        if (code === 'JOB_ACTIVE') return message('benchmarkJobActive', 'Finish or cancel the current conversion before benchmarking.');
        if (code === 'CANCELLED') return message('benchmarkCancelled', 'Benchmark cancelled.');
        if (code === 'BENCHMARK_ACTIVE') return message('benchmarkBusy', 'A benchmark is already running.');
        if (code === 'BENCHMARK_SOURCE_REQUIRED') return message('benchmarkSourceRequired', 'Choose a source folder with original (unconverted) Tesla clips first.');
        return message('benchmarkFailed', 'Benchmark failed: {code}', { code });
    }

    const formatRate = (value) => String(value >= 100 ? Math.round(value) : value);

    const CODEC_LABELS = { h265: 'H.265', av1: 'AV1' };
    const verifyLabel = (mode) => ({
        off: message('verifyLabelOff', 'Off'), quick: message('verifyLabelQuick', 'Quick'), full: message('verifyLabelFull', 'Full')
    })[mode] || mode;

    // Off / Quick / Full at each codec's recommended setting.
    function renderVerifyComparison(runs, doc, cell) {
        const compared = runs.filter((run) => Array.isArray(run.verifyComparison) && run.verifyComparison.length);
        if (elements.benchmarkVerifyHead) {
            const head = doc.createElement('tr');
            head.append(cell('th', message('verification', 'Verification')),
                ...VERIFY_MODES.map((mode) => cell('th', verifyLabel(mode))));
            elements.benchmarkVerifyHead.replaceChildren(head);
        }
        const rows = compared.map((run) => {
            const row = doc.createElement('tr');
            row.append(cell('td', message('benchmarkVerifyTitle', '{codec} · {count} at once',
                { codec: CODEC_LABELS[run.codec] || run.codec, count: run.best?.level ?? '—' })));
            for (const mode of VERIFY_MODES) {
                const entry = run.verifyComparison.find((candidate) => candidate.verifyMode === mode);
                if (!entry) row.append(cell('td', '—'));
                else if (!entry.ok) {
                    const failed = cell('td', message('benchmarkFailedRun', 'failed'));
                    if (entry.failures?.length) failed.title = entry.failures.join(', ');
                    row.append(failed);
                } else {
                    row.append(cell('td', message('benchmarkVerifyCell', '{rate} ({seconds} s)', {
                        rate: formatRate(entry.filesPerMinute),
                        seconds: Number.isFinite(entry.verifySecondsPerClip) ? entry.verifySecondsPerClip.toFixed(1) : '—'
                    })));
                }
            }
            return row;
        });
        elements.benchmarkVerifyRows?.replaceChildren(...rows);
        setHidden(elements.benchmarkVerifyTable, rows.length === 0);
    }
    let benchmarkPicks = [];

    // One entry per codec tested; older single-codec results become one run.
    function benchmarkRuns(result) {
        if (Array.isArray(result?.codecs) && result.codecs.length) return result.codecs;
        if (!result) return [];
        return [{ codec: selected(elements.codecOptions, 'converterCodec', 'h265'), ...result }];
    }

    function renderBenchmark(result) {
        const runs = benchmarkRuns(result);
        const doc = elements.benchmarkRows?.ownerDocument || globalThis.document;
        const cell = (tag, text, className) => {
            const node = doc.createElement(tag);
            node.textContent = text;
            if (className) node.className = className;
            return node;
        };
        const tested = runs.filter((run) => !run.error && Array.isArray(run.results) && run.results.length);
        // Header: At once | per codec: Files/min, FPS, Saved
        if (elements.benchmarkHead) {
            const head = doc.createElement('tr');
            head.append(cell('th', message('benchmarkParallel', 'At once')));
            for (const run of tested) {
                const label = CODEC_LABELS[run.codec] || run.codec;
                head.append(cell('th', `${label} ${message('benchmarkFilesPerMinute', 'Files/min')}`, 'codec-start'),
                    cell('th', message('benchmarkFps', 'FPS')), cell('th', message('benchmarkSaved', 'Saved')));
            }
            elements.benchmarkHead.replaceChildren(head);
        }
        const levels = [...new Set(tested.flatMap((run) => run.results.map((entry) => entry.level)))].sort((a, b) => a - b);
        const rows = levels.map((level) => {
            const row = doc.createElement('tr');
            row.append(cell('td', String(level)));
            for (const run of tested) {
                const entry = run.results.find((candidate) => candidate.level === level);
                const best = run.best && run.best.level === level;
                if (!entry) {
                    row.append(cell('td', '—', 'codec-start'), cell('td', '—'), cell('td', '—'));
                } else if (!entry.ok) {
                    const failedCell = cell('td', message('benchmarkFailedRun', 'failed'), 'codec-start');
                    if (entry.failures?.length) failedCell.title = entry.failures.join(', ');
                    row.append(failedCell, cell('td', '—'), cell('td', '—'));
                } else {
                    row.append(cell('td', formatRate(entry.filesPerMinute), `codec-start${best ? ' is-best' : ''}`),
                        cell('td', formatRate(entry.fps), best ? 'is-best' : ''),
                        cell('td', Number.isFinite(entry.savedPercent) ? `${entry.savedPercent}%` : '—', best ? 'is-best' : ''));
                }
            }
            return row;
        });
        elements.benchmarkRows?.replaceChildren(...rows);
        setHidden(elements.benchmarkTable, rows.length === 0);
        renderVerifyComparison(runs, doc, cell);

        const lines = [];
        benchmarkPicks = [];
        for (const run of runs) {
            const codec = CODEC_LABELS[run.codec] || run.codec;
            if (run.error === 'UNSUPPORTED') lines.push(message('benchmarkCodecUnsupported', '{codec}: not supported on this computer', { codec }));
            else if (run.error) lines.push(message('benchmarkCodecFailed', '{codec}: benchmark failed ({code})', { codec, code: run.error }));
            else if (run.best) {
                const saved = run.results.find((entry) => entry.level === run.best.level)?.savedPercent;
                lines.push(message('benchmarkCodecBest', '{codec}: fastest at {count} at once — {rate} files/min, saves {saved}', {
                    codec, count: run.best.level, rate: formatRate(run.best.filesPerMinute),
                    saved: Number.isFinite(saved) ? `${saved}%` : '—'
                }));
                benchmarkPicks.push({ codec: run.codec, level: run.best.level });
            }
        }
        benchmarkBest = benchmarkPicks[0] || null;
        setText(elements.benchmarkBest, lines.join('\n'));
        setHidden(elements.benchmarkBest, lines.length === 0);
        [elements.benchmarkApply, elements.benchmarkApplyAlt].forEach((button, index) => {
            const pick = benchmarkPicks[index];
            setHidden(button, !pick);
            if (pick) {
                setText(button, message('benchmarkUseCodec', 'Use {codec} · {count} at once',
                    { codec: CODEC_LABELS[pick.codec] || pick.codec, count: pick.level }));
            }
        });
        const encoders = runs.filter((run) => !run.error && run.encoder)
            .map((run) => message('benchmarkCodecEncoder', '{codec} on {encoder}', { codec: CODEC_LABELS[run.codec] || run.codec, encoder: encoderLabel(run.encoder) }));
        const clips = Math.max(0, ...runs.map((run) => run.clips || 0));
        setText(elements.benchmarkStatus, message('benchmarkDone', 'Done — {clips} real clips converted with {encoder}.',
            { clips, encoder: encoders.join(', ') || '—' }));
    }

    async function runBenchmark() {
        if (benchmarkRunning || typeof api.runConverterBenchmark !== 'function') return;
        benchmarkRunning = true;
        benchmarkBest = null;
        setDisabled(elements.benchmarkRun, true);
        setHidden(elements.benchmarkApply, true);
        setHidden(elements.benchmarkApplyAlt, true);
        setHidden(elements.benchmarkVerifyTable, true);
        setHidden(elements.benchmarkBest, true);
        setText(elements.benchmarkStatus, message('benchmarkScanning', 'Finding sample clips in your source folder…'));
        try {
            const profileId = selectedProfile();
            const bitrateKbps = profileId === 'custom' ? customBitrateKbps() : undefined;
            if (profileId === 'custom' && bitrateKbps === null) throw apiError('BITRATE_INVALID');
            const request = {
                codecs: ['h265', 'av1'],
                verifyMode: selectedVerifyMode(),
                profileId,
                ...profileSettings(profileId),
                sourceRoot: elements.sourcePath?.value?.trim() || null
            };
            const result = unwrap(await api.runConverterBenchmark(request, (progress) => {
                if (progress?.step === 'copy') {
                    setText(elements.benchmarkStatus, message('benchmarkCopying', 'Copying sample clip {index} of {total}…',
                        { index: progress.index, total: progress.total }));
                } else if (progress?.step === 'verify') {
                    setText(elements.benchmarkStatus, message('benchmarkVerifyProgress',
                        '{codec}: timing verification {mode} at {count} at once… ({index} of {total})',
                        { codec: CODEC_LABELS[progress.codec] || progress.codec || '', mode: verifyLabel(progress.verifyMode),
                            count: progress.level, index: progress.index, total: progress.total }));
                } else if (progress?.step === 'run' && progress.codec) {
                    setText(elements.benchmarkStatus, message('benchmarkCodecProgress',
                        '{codec} ({codecIndex} of {codecTotal}): converting with {count} at once… ({index} of {total})',
                        { codec: CODEC_LABELS[progress.codec] || progress.codec, codecIndex: progress.codecIndex, codecTotal: progress.codecTotal,
                            count: progress.level, index: progress.index, total: progress.total }));
                } else if (progress?.step === 'run') {
                    setText(elements.benchmarkStatus, message('benchmarkTestingLevel',
                        'Converting with {count} at once… ({index} of {total})',
                        { count: progress.level, index: progress.index, total: progress.total }));
                }
            }));
            renderBenchmark(result);
        } catch (error) {
            setText(elements.benchmarkStatus, error?.code === 'BITRATE_INVALID'
                ? message('errorBitrateInvalid', 'Enter a bitrate between 0.25 and 100 Mbps.') : benchmarkErrorText(error));
        } finally {
            benchmarkRunning = false;
            setDisabled(elements.benchmarkRun, false);
        }
    }

    function closeBenchmark() {
        if (benchmarkRunning) void Promise.resolve(api.cancelConverterBenchmark?.()).catch(() => {});
        elements.benchmarkDialog?.close?.();
    }

    function applyBenchmark(index = 0) {
        const pick = benchmarkPicks[index];
        if (!pick) return;
        setConcurrency(pick.level);
        rememberConcurrency(pick.level);
        for (const option of elements.codecOptions || []) option.checked = option.dataset?.converterCodec === pick.codec;
        notify(message('benchmarkAppliedCodec', 'Set to {codec} with {count} parallel conversions.',
            { codec: CODEC_LABELS[pick.codec] || pick.codec, count: pick.level }), { type: 'info' });
        elements.benchmarkDialog?.close?.();
    }

    function applySnapshot(next, revision = next?.revision) {
        if (!next || !Number.isSafeInteger(revision) || revision < latestRevision) return false;
        const progressOnly = Object.keys(next).every((key) => ['id', 'revision', 'progress'].includes(key));
        if (Number.isFinite(next.progress?.fps)) lastFps = { value: next.progress.fps, at: Date.now() };
        if (progressOnly && snapshot) snapshot = { ...snapshot, progress: next.progress };
        else {
            snapshot = { ...next };
            if (!Object.prototype.hasOwnProperty.call(next, 'progress')) delete snapshot.progress;
            syncConfig(snapshot.config);
        }
        latestRevision = revision;
        render();
        return true;
    }

    function handleProgress(payload) {
        if (!payload || typeof payload.jobId !== 'string' || !payload.snapshot) return;
        if (pendingStartEvents && (!snapshot?.id || payload.jobId !== snapshot.id)) {
            let buffered = pendingStartEvents.get(payload.jobId);
            if (!buffered) {
                if (pendingStartEvents.size >= 8) return;
                buffered = { full: null, progress: null };
                pendingStartEvents.set(payload.jobId, buffered);
            }
            const progressOnly = Object.keys(payload.snapshot)
                .every((key) => ['id', 'revision', 'progress'].includes(key));
            const slot = progressOnly ? 'progress' : 'full';
            if (!buffered[slot] || payload.revision >= buffered[slot].revision) buffered[slot] = payload;
            return;
        }
        if (snapshot?.id && payload.jobId !== snapshot.id) {
            // A new job (e.g. an automatic one) replaces a finished one on screen.
            const progressOnly = Object.keys(payload.snapshot).every((key) => ['id', 'revision', 'progress'].includes(key));
            if (progressOnly || !['completed', 'failed', 'cancelled'].includes(snapshot.state)) return;
            snapshot = null;
            latestRevision = -1;
        }
        applySnapshot(payload.snapshot, payload.revision);
    }

    // ---- Automatic conversion -------------------------------------------
    let autoState = null;
    let autoTimer = null;

    function clockTime(ms) {
        try {
            return new Date(ms).toLocaleTimeString(getLocale(), { hour: 'numeric', minute: '2-digit' });
        } catch (_) {
            return new Date(ms).toLocaleTimeString();
        }
    }

    function renderAuto() {
        const settings = autoState?.settings;
        const status = autoState?.status || {};
        if (!settings) return;
        if (elements.autoEnabled) elements.autoEnabled.checked = settings.enabled === true;
        if (elements.autoInterval) elements.autoInterval.value = String(settings.intervalMinutes || 60);
        if (elements.autoWindowEnabled) elements.autoWindowEnabled.checked = Boolean(settings.window);
        if (settings.window) {
            if (elements.autoStart) elements.autoStart.value = String(settings.window.startHour);
            if (elements.autoEnd) elements.autoEnd.value = String(settings.window.endHour);
        }
        if (elements.autoKeepRunning) elements.autoKeepRunning.checked = settings.keepRunning === true;
        if (elements.autoLogin) elements.autoLogin.checked = settings.openAtLogin === true;
        for (const control of [elements.autoStart, elements.autoEnd]) setDisabled(control, !settings.window);
        setDisabled(elements.autoCheckNow, !settings.enabled || status.checking === true);
        renderAutoStatus();
    }

    // Status line only (also refreshed with job updates, e.g. a pause).
    function renderAutoStatus() {
        const settings = autoState?.settings;
        const status = autoState?.status || {};
        if (!settings) return;
        let text;
        if (!settings.enabled) text = message('autoOff', 'Off');
        else if (status.checking) text = message('autoChecking', 'Checking for new clips…');
        else if (status.activeJobId && status.pausedForWindow) {
            text = message('autoPausedWindow', 'Paused outside the time window — resumes at {time}', {
                time: clockTime(new Date().setHours(settings.window?.startHour ?? 0, 0, 0, 0))
            });
        } else if (status.activeJobId && snapshot?.id === status.activeJobId && snapshot.state === 'paused') {
            // Paused by the user: it waits for them.
            text = message('autoJobPaused', 'Automatic conversion is paused — resume or cancel it above');
        } else if (status.activeJobId) text = message('autoConverting', 'Converting new clips…');
        else {
            const parts = [];
            if (status.error) parts.push(message('autoError', 'Last check failed: {code}', { code: status.error }));
            else if (Number.isSafeInteger(status.lastNewFiles)) {
                parts.push(status.lastNewFiles === 0
                    ? message('autoNoneNew', 'No new clips at {time}', { time: clockTime(status.lastCheckAt) })
                    : message('autoFoundNew', '{count} new clips found at {time}', { count: status.lastNewFiles, time: clockTime(status.lastCheckAt) }));
            }
            if (status.nextCheckAt) parts.push(message('autoNext', 'Next check {time}', { time: clockTime(status.nextCheckAt) }));
            else parts.push(message('autoSoon', 'Checks shortly'));
            text = parts.join(' · ');
        }
        setText(elements.autoStatus, text);
    }

    async function refreshAuto() {
        if (typeof api.getConverterAuto !== 'function') return;
        try {
            autoState = unwrap(await api.getConverterAuto());
            renderAuto();
        } catch (_) { /* automatic conversion unavailable */ }
    }

    function hourValue(control, fallback) {
        const value = Number(control?.value);
        return Number.isSafeInteger(value) && value >= 0 && value <= 23 ? value : fallback;
    }

    async function saveAuto() {
        if (typeof api.setConverterAuto !== 'function') return;
        const enabled = elements.autoEnabled?.checked === true;
        try {
            const windowOn = elements.autoWindowEnabled?.checked === true;
            const window = windowOn ? { startHour: hourValue(elements.autoStart, 1), endHour: hourValue(elements.autoEnd, 6) } : null;
            if (window && window.startHour === window.endHour) throw apiError('AUTO_WINDOW_INVALID');
            const settings = {
                enabled,
                intervalMinutes: Number(elements.autoInterval?.value) || 60,
                window,
                keepRunning: elements.autoKeepRunning?.checked === true,
                openAtLogin: elements.autoLogin?.checked === true,
                // Turning it on (or changing an option while on) saves the
                // current job settings above for every automatic run.
                config: enabled ? configFromControls() : (autoState?.settings?.config || null)
            };
            autoState = unwrap(await api.setConverterAuto(settings));
        } catch (error) {
            notify(describeError(error), { type: 'error' });
            await refreshAuto();
            return;
        }
        renderAuto();
    }

    async function checkAutoNow() {
        if (typeof api.checkConverterAutoNow !== 'function') return;
        try {
            autoState = unwrap(await api.checkConverterAutoNow());
            renderAuto();
        } catch (error) {
            notify(describeError(error), { type: 'error' });
        }
    }

    async function chooseFolder(purpose) {
        try {
            const field = purpose === 'source' ? elements.sourcePath : elements.destinationPath;
            const chosen = unwrap(await api.chooseConverterFolder(purpose, field?.value || undefined));
            if (chosen && field) {
                field.value = chosen;
                updateOutputMode();
            }
        } catch (error) {
            notify(message('folderSelectionFailed', 'Folder selection failed: {code}', { code: error.code || 'OPERATION_FAILED' }), { type: 'error' });
        }
    }

    function configFromControls() {
        const sourceRoot = elements.sourcePath?.value?.trim();
        const outputMode = selected(elements.outputOptions, 'converterOutput', 'separate');
        const destinationRoot = elements.destinationPath?.value?.trim();
        const includedGroups = elements.groupOptions
            .filter((entry) => entry.checked)
            .map((entry) => entry.dataset?.converterGroup)
            .filter((group) => GROUPS.includes(group));
        if (!sourceRoot) throw apiError('SOURCE_REQUIRED');
        if (includedGroups.length === 0) throw apiError('GROUP_REQUIRED');
        if (outputMode === 'separate' && !destinationRoot) throw apiError('DESTINATION_REQUIRED');
        if (outputMode === 'replace') {
            if (capabilities.replacement !== 'available') throw apiError('REPLACEMENT_UNAVAILABLE');
            if (elements.replacementConfirmation?.checked !== true) throw apiError('REPLACEMENT_CONFIRMATION_REQUIRED');
            if (!confirmAction(message(
                'replacementConfirm',
                'Replace originals in {sourceRoot}? Each original is backed up first, and a failed replacement restores that backup for rollback.',
                { sourceRoot }
            ))) throw apiError('REPLACEMENT_CONFIRMATION_REQUIRED');
        }
        const profileId = selectedProfile();
        if (profileId === 'custom' && customBitrateKbps() === null) throw apiError('BITRATE_INVALID');
        return {
            sourceRoot,
            destinationRoot: outputMode === 'replace' ? null : destinationRoot,
            codec: selected(elements.codecOptions, 'converterCodec', 'h265'),
            profileId,
            ...profileSettings(profileId),
            networkMode: 'auto',
            outputMode,
            includedGroups,
            groupOrder: [...groupOrder],
            replacementConfirmed: outputMode === 'replace',
            concurrency: selectedConcurrency(),
            verifyMode: selectedVerifyMode()
        };
    }

    function describeError(error) {
        const labels = {
            SOURCE_REQUIRED: ['errorSourceRequired', 'Choose a source folder before starting.'],
            DESTINATION_REQUIRED: ['errorDestinationRequired', 'Choose a destination folder for separate output.'],
            BITRATE_INVALID: ['errorBitrateInvalid', 'Enter a bitrate between 0.25 and 100 Mbps.'],
            GROUP_REQUIRED: ['errorGroupRequired', 'Select at least one Tesla clip group.'],
            REPLACEMENT_CONFIRMATION_REQUIRED: ['errorReplacementConfirmation', 'Acknowledge and confirm replacement before starting.'],
            REPLACEMENT_UNAVAILABLE: ['errorReplacementUnavailable', 'Replace originals is not available on this system.'],
            AUTO_WINDOW_INVALID: ['errorAutoWindow', 'Choose different start and end hours for the time window.'],
            RECOVERY_REQUIRED: ['errorRecoveryRequired', 'This job stopped in the middle of replacing an original. Resume it to finish safely.'],
            INVALID_MANIFEST: ['errorInvalidManifest', "This job's saved record couldn't be updated. Use Cancel to set it aside."]
        };
        return labels[error?.code]
            ? message(...labels[error.code])
            : message('errorActionFailed', 'Converter action failed: {code}', { code: error?.code || 'OPERATION_FAILED' });
    }

    async function start() {
        pendingStartEvents = new Map();
        try {
            const config = configFromControls();
            const result = unwrap(await api.startConverter(config));
            const buffered = pendingStartEvents.get(result.jobId);
            pendingStartEvents = null;
            const createdAt = Date.now();
            snapshot = null;
            latestRevision = -1;
            applySnapshot({
                id: result.jobId,
                state: 'discovering',
                revision: 0,
                createdAt,
                updatedAt: createdAt,
                config,
                items: [],
                counters: { sourceVideoBytes: 0 },
                summary: null
            }, 0);
            if (buffered?.full) applySnapshot(buffered.full.snapshot, buffered.full.revision);
            if (buffered?.progress) applySnapshot(buffered.progress.snapshot, buffered.progress.revision);
        } catch (error) {
            pendingStartEvents = null;
            notify(describeError(error), { type: 'error' });
        }
    }

    async function command(method, { confirmMessage } = {}) {
        if (!snapshot?.id || typeof api[method] !== 'function') return;
        if (confirmMessage && !confirmAction(confirmMessage)) return;
        try {
            const next = unwrap(await api[method](snapshot.id));
            if (next) applySnapshot(next, next.revision);
        } catch (error) {
            notify(describeError(error), { type: 'error' });
        }
    }

    // Cancel, and if the job cannot be ended normally (for example it was left
    // half-saved by a crash or its record can't be read), offer to set it aside
    // so the converter is usable again without touching any folders by hand.
    async function cancelJob() {
        if (!snapshot?.id || typeof api.cancelConverter !== 'function') return;
        if (!confirmAction(message('cancelConfirm', 'Cancel this conversion job after owned temporary files are reconciled?'))) return;
        const jobId = snapshot.id;
        try {
            const next = unwrap(await api.cancelConverter(jobId));
            if (next) applySnapshot(next, next.revision);
            return;
        } catch (error) {
            if (typeof api.discardConverterJob !== 'function') {
                notify(describeError(error), { type: 'error' });
                return;
            }
        }
        if (!confirmAction(message('discardConfirm', "This job can't be ended normally. Set it aside so you can start fresh? Files already converted are kept."))) return;
        try {
            const current = unwrap(await api.discardConverterJob(jobId));
            snapshot = null;
            latestRevision = -1;
            if (current) applySnapshot(current, current.revision);
            else render();
            notify(message('discarded', 'The job was set aside. Files already converted were kept.'), { type: 'info' });
        } catch (error) {
            notify(describeError(error), { type: 'error' });
        }
    }

    function bind() {
        elements.sourceButton?.addEventListener('click', () => chooseFolder('source'));
        elements.destinationButton?.addEventListener('click', () => chooseFolder('destination'));
        for (const option of elements.outputOptions) option.addEventListener?.('change', updateOutputMode);
        for (const item of elements.orderRows || []) {
            item.up?.addEventListener('click', () => moveGroup(item.group, 'up'));
            item.down?.addEventListener('click', () => moveGroup(item.group, 'down'));
        }
        setConcurrency(storedConcurrency() ?? DEFAULT_CONCURRENCY);
        if (elements.verifyMode) elements.verifyMode.value = storedVerifyMode() ?? 'quick';
        elements.verifyMode?.addEventListener?.('change', () => {
            updateVerifyOptions();
            try { storage?.setItem?.(VERIFY_STORAGE_KEY, selectedVerifyMode()); } catch (_) { /* preference only */ }
        });
        updateVerifyOptions();
        elements.profileSelect?.addEventListener?.('change', updateCustomBitrateVisibility);
        updateCustomBitrateVisibility();
        elements.concurrency?.addEventListener?.('change', () => {
            updateConcurrencyCustomVisibility();
            if (customConcurrencySelected()) elements.concurrencyCustom?.focus?.();
            const value = selectedConcurrency();
            if (normalizeConcurrency(customConcurrencySelected() ? elements.concurrencyCustom?.value : elements.concurrency.value) !== null) rememberConcurrency(value);
        });
        elements.concurrencyCustom?.addEventListener?.('change', () => {
            const value = normalizeConcurrency(elements.concurrencyCustom.value);
            if (value === null) {
                const clamped = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(Number(elements.concurrencyCustom.value)) || DEFAULT_CONCURRENCY));
                elements.concurrencyCustom.value = String(clamped);
                rememberConcurrency(clamped);
            } else rememberConcurrency(value);
        });
        elements.benchmarkButton?.addEventListener?.('click', () => elements.benchmarkDialog?.showModal?.());
        elements.benchmarkRun?.addEventListener?.('click', runBenchmark);
        elements.benchmarkApply?.addEventListener?.('click', () => applyBenchmark(0));
        elements.benchmarkApplyAlt?.addEventListener?.('click', () => applyBenchmark(1));
        elements.benchmarkClose?.addEventListener?.('click', closeBenchmark);
        elements.benchmarkDialog?.addEventListener?.('cancel', () => {
            if (benchmarkRunning) void Promise.resolve(api.cancelConverterBenchmark?.()).catch(() => {});
        });
        elements.startButton?.addEventListener('click', start);
        elements.pauseButton?.addEventListener('click', () => command('pauseConverter'));
        elements.resumeButton?.addEventListener('click', () => command('resumeConverter'));
        elements.cancelButton?.addEventListener('click', () => { void cancelJob(); });
        elements.retryButton?.addEventListener('click', () => command('retryFailedConverter'));
        elements.dismissButton?.addEventListener('click', () => command('dismissConverterSummary'));
        if (elements.autoStart && !elements.autoStart.value) elements.autoStart.value = '1';
        if (elements.autoEnd && (!elements.autoEnd.value || elements.autoEnd.value === '0')) elements.autoEnd.value = '6';
        for (const control of [elements.autoEnabled, elements.autoInterval, elements.autoWindowEnabled,
            elements.autoStart, elements.autoEnd, elements.autoKeepRunning, elements.autoLogin]) {
            control?.addEventListener?.('change', () => saveAuto());
        }
        elements.autoCheckNow?.addEventListener?.('click', () => checkAutoNow());
    }

    async function initialize() {
        if (initialized) return controller;
        initialized = true;
        bind();
        if (typeof api.onConverterProgress === 'function') unsubscribe = api.onConverterProgress(handleProgress);
        if (subscribeLanguage) {
            unsubscribeLanguage = subscribeLanguage(() => {
                updateOutputMode();
                render();
            });
        }
        await refreshAuto();
        if (typeof api.getConverterAuto === 'function' && options.autoPollMs !== 0) {
            autoTimer = setInterval(() => { void refreshAuto(); }, options.autoPollMs || 30_000);
        }
        try {
            updateCapabilities(unwrap(await api.getConverterCapabilities()));
            const current = unwrap(await api.getCurrentConverterJob());
            if (current) applySnapshot(current, current.revision);
            else render();
        } catch (error) {
            notify(describeError(error), { type: 'error' });
            render();
        }
        return controller;
    }

    const controller = Object.freeze({
        init() {
            if (!initPromise) initPromise = initialize();
            return initPromise;
        },
        setVisible(nextVisible) { visible = Boolean(nextVisible); },
        get visible() { return visible; },
        get snapshot() { return snapshot; },
        destroy() {
            if (autoTimer) clearInterval(autoTimer);
            autoTimer = null;
            unsubscribe?.();
            unsubscribe = null;
            unsubscribeLanguage?.();
            unsubscribeLanguage = null;
        }
    });
    return controller;
}

function createSidebarPanelSwitcher(options = {}) {
    const validPanels = new Set(['clips', 'drives', 'converter']);
    const tabs = options.tabs || [];
    let converterOpened = false;
    let converterPromise = null;
    async function switchSidebarPanel(panel) {
        if (!validPanels.has(panel)) return false;
        const converterActive = panel === 'converter';
        if (options.clipList) options.clipList.style.display = panel === 'clips' ? '' : 'none';
        if (options.driveList) options.driveList.style.display = panel === 'drives' ? '' : 'none';
        if (options.workspace) options.workspace.hidden = !converterActive;
        options.body?.classList?.toggle('converter-mode', converterActive);
        if (options.clipFilter) options.clipFilter.style.display = panel === 'clips' ? '' : 'none';
        if (options.driveFilter) options.driveFilter.style.display = panel === 'drives' ? '' : 'none';
        if (options.chooseFolderButton) options.chooseFolderButton.hidden = converterActive;
        for (const tab of tabs) {
            const active = tab.dataset?.panel === panel;
            tab.classList?.toggle('active', active);
            tab.setAttribute?.('aria-selected', active ? 'true' : 'false');
            tab.setAttribute?.('tabindex', active ? '0' : '-1');
        }
        if (panel === 'drives') options.onDrivesOpen?.();
        if (converterActive && !converterOpened) {
            converterOpened = true;
            converterPromise = Promise.resolve(options.onConverterOpen?.());
        }
        if (converterActive && converterPromise) await converterPromise;
        options.onPanelChange?.(panel);
        return true;
    }
    tabs.forEach((tab, index) => tab.addEventListener?.('keydown', async (event) => {
        let nextIndex = null;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault?.();
        const nextTab = tabs[nextIndex];
        await switchSidebarPanel(nextTab.dataset?.panel);
        nextTab.focus?.();
    }));
    return switchSidebarPanel;
}

function initFootageConverter(options = {}) {
    const controller = createFootageConverterController({
        api: options.api || globalThis.window?.electronAPI,
        root: options.root || globalThis.document,
        notify: options.notify,
        t: options.t,
        getLocale: options.getLocale,
        onLanguageChange: options.onLanguageChange,
        confirm: options.confirm
    });
    return controller.init().then(() => controller);
}

export {
    createFootageConverterController,
    createSidebarPanelSwitcher,
    formatBytes,
    initFootageConverter
};
