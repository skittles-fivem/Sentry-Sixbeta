/**
 * Playback layout preferences:
 *  - Tesla hardware mode: HW4 (six cameras) or HW3 (four cameras, no pillars).
 *  - Resizable multi-camera grid: drag the dividers between columns and rows;
 *    sizes are remembered per layout and restored on reopen. Double-click a
 *    divider to reset that layout to equal sizes.
 */

const HARDWARE_KEY = 'sentrySix.playback.teslaHardware';
const SIZES_KEY = 'sentrySix.playback.gridSizes';
const HARDWARE_LAYOUTS = Object.freeze({ hw4: 'six_default', hw3: 'tesla_hw3' });
const MIN_SHARE = 0.12;

function readJson(key, fallback) {
    try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
        return fallback;
    }
}

function writeJson(key, value) {
    try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch (_) { /* preference only */ }
}

export function getTeslaHardware() {
    try {
        const value = globalThis.localStorage?.getItem(HARDWARE_KEY);
        return value === 'hw3' ? 'hw3' : 'hw4';
    } catch (_) {
        return 'hw4';
    }
}

export function setTeslaHardware(mode) {
    const next = mode === 'hw3' ? 'hw3' : 'hw4';
    try { globalThis.localStorage?.setItem(HARDWARE_KEY, next); } catch (_) { /* preference only */ }
    return next;
}

export function teslaLayoutId(mode = getTeslaHardware()) {
    return HARDWARE_LAYOUTS[mode] || HARDWARE_LAYOUTS.hw4;
}

function validTracks(value, count) {
    return Array.isArray(value) && value.length === count
        && value.every((entry) => Number.isFinite(entry) && entry > 0);
}

function normalize(tracks) {
    const total = tracks.reduce((sum, value) => sum + value, 0);
    return tracks.map((value) => value / total);
}

/**
 * Creates the resizable grid controller for one multi-camera grid element.
 * `getLayoutId` returns the active layout id; `getColumns` its column count.
 */
export function createGridResizer({ grid, getLayoutId, getColumns }) {
    if (!grid) return { apply() {}, reset() {} };
    let sizes = readJson(SIZES_KEY, {});
    const handles = { columns: [], rows: [] };
    let drag = null;

    function tracksFor(layoutId, columns) {
        const saved = sizes[layoutId] || {};
        return {
            columns: validTracks(saved.columns, columns) ? normalize(saved.columns) : Array(columns).fill(1 / columns),
            rows: validTracks(saved.rows, 2) ? normalize(saved.rows) : [0.5, 0.5]
        };
    }

    function current() {
        const columns = Number(getColumns()) === 2 ? 2 : 3;
        return { layoutId: getLayoutId(), columns, tracks: tracksFor(getLayoutId(), columns) };
    }

    function makeHandle(axis, index) {
        const handle = document.createElement('div');
        handle.className = `grid-resize-handle grid-resize-${axis}`;
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', axis === 'columns' ? 'vertical' : 'horizontal');
        handle.title = 'Drag to resize · double-click to reset';
        handle.addEventListener('pointerdown', (event) => startDrag(event, axis, index));
        handle.addEventListener('dblclick', () => reset());
        grid.appendChild(handle);
        return handle;
    }

    function ensureHandles(columns) {
        while (handles.columns.length < 2) handles.columns.push(makeHandle('columns', handles.columns.length));
        if (handles.rows.length === 0) handles.rows.push(makeHandle('rows', 0));
        handles.columns.forEach((handle, index) => { handle.hidden = index >= columns - 1; });
    }

    // Handles sit in the gaps between tiles; positions come from the rendered
    // tiles so they stay correct for any gap/padding the stylesheet uses.
    function positionHandles() {
        const { columns } = current();
        ensureHandles(columns);
        const gridRect = grid.getBoundingClientRect();
        if (!gridRect.width || !gridRect.height) return;
        const visible = [...grid.querySelectorAll('.multi-tile')]
            .filter((tile) => tile.offsetParent !== null);
        const rowTops = [...new Set(visible.map((tile) => Math.round(tile.getBoundingClientRect().top)))].sort((a, b) => a - b);
        const firstRow = visible.filter((tile) => Math.round(tile.getBoundingClientRect().top) === rowTops[0])
            .map((tile) => tile.getBoundingClientRect()).sort((a, b) => a.left - b.left);
        for (let index = 0; index < columns - 1 && index < firstRow.length - 1; index += 1) {
            const left = (firstRow[index].right + firstRow[index + 1].left) / 2 - gridRect.left;
            Object.assign(handles.columns[index].style, { left: `${left}px`, top: '0', height: '100%' });
        }
        const firstColumn = visible.filter((tile) => Math.abs(tile.getBoundingClientRect().left - (firstRow[0]?.left ?? 0)) < 2)
            .map((tile) => tile.getBoundingClientRect()).sort((a, b) => a.top - b.top);
        if (firstColumn.length >= 2) {
            const top = (firstColumn[0].bottom + firstColumn[1].top) / 2 - gridRect.top;
            Object.assign(handles.rows[0].style, { top: `${top}px`, left: '0', width: '100%' });
            handles.rows[0].hidden = false;
        } else {
            handles.rows[0].hidden = true;
        }
    }

    function apply() {
        const { tracks } = current();
        grid.style.gridTemplateColumns = tracks.columns.map((share) => `${share}fr`).join(' ');
        grid.style.gridTemplateRows = tracks.rows.map((share) => `${share}fr`).join(' ');
        requestAnimationFrame(positionHandles);
    }

    function save(layoutId, tracks) {
        sizes = { ...sizes, [layoutId]: { columns: tracks.columns, rows: tracks.rows } };
        writeJson(SIZES_KEY, sizes);
    }

    function reset() {
        const { layoutId } = current();
        const next = { ...sizes };
        delete next[layoutId];
        sizes = next;
        writeJson(SIZES_KEY, sizes);
        apply();
    }

    function startDrag(event, axis, index) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const { layoutId, tracks } = current();
        const rect = grid.getBoundingClientRect();
        drag = {
            axis, index, layoutId, tracks,
            start: axis === 'columns' ? event.clientX : event.clientY,
            extent: axis === 'columns' ? rect.width : rect.height,
            pair: tracks[axis][index] + tracks[axis][index + 1],
            first: tracks[axis][index]
        };
        grid.classList.add('grid-resizing');
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.currentTarget.addEventListener('pointermove', onMove);
        event.currentTarget.addEventListener('pointerup', endDrag, { once: true });
        event.currentTarget.addEventListener('pointercancel', endDrag, { once: true });
    }

    function onMove(event) {
        if (!drag) return;
        const position = drag.axis === 'columns' ? event.clientX : event.clientY;
        const delta = (position - drag.start) / drag.extent;
        const minimum = MIN_SHARE * drag.pair;
        const first = Math.min(drag.pair - minimum, Math.max(minimum, drag.first + delta));
        const tracks = { columns: [...drag.tracks.columns], rows: [...drag.tracks.rows] };
        tracks[drag.axis][drag.index] = first;
        tracks[drag.axis][drag.index + 1] = drag.pair - first;
        drag.latest = tracks;
        grid.style.gridTemplateColumns = tracks.columns.map((share) => `${share}fr`).join(' ');
        grid.style.gridTemplateRows = tracks.rows.map((share) => `${share}fr`).join(' ');
        positionHandles();
    }

    function endDrag(event) {
        event.currentTarget.removeEventListener('pointermove', onMove);
        grid.classList.remove('grid-resizing');
        if (drag?.latest) save(drag.layoutId, drag.latest);
        drag = null;
        positionHandles();
    }

    if (typeof ResizeObserver === 'function') new ResizeObserver(() => positionHandles()).observe(grid);
    new MutationObserver(() => requestAnimationFrame(positionHandles))
        .observe(grid, { attributes: true, attributeFilter: ['class', 'data-columns'] });
    apply();
    return { apply, reset };
}
