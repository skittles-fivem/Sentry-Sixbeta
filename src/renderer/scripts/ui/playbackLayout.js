/**
 * Playback layout preferences:
 *  - Tesla hardware mode: HW4 (six cameras) or HW3 (four cameras, no pillars).
 *  - Resizable multi-camera grid: drag the dividers between columns and rows;
 *    sizes are remembered per layout and restored on reopen. Double-click a
 *    divider to reset that layout to equal sizes.
 *  - Free layout: drag any camera's corner to give it any size, or its move
 *    grip to place it anywhere. The first such change switches that layout to
 *    free positioning (starting from where the cameras are); positions are
 *    remembered per layout. Double-click a corner to go back to the grid.
 */

const HARDWARE_KEY = 'sentrySix.playback.teslaHardware';
const SIZES_KEY = 'sentrySix.playback.gridSizes';
const HARDWARE_LAYOUTS = Object.freeze({ hw4: 'six_default', hw3: 'tesla_hw3' });
const MIN_SHARE = 0.12;
const FREE_KEY = 'sentrySix.playback.freeLayouts';
const FREE_MIN = 0.08; // smallest camera, as a share of the view

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

    let apply = function applyTracks() {
        const { tracks } = current();
        grid.style.gridTemplateColumns = tracks.columns.map((share) => `${share}fr`).join(' ');
        grid.style.gridTemplateRows = tracks.rows.map((share) => `${share}fr`).join(' ');
        requestAnimationFrame(positionHandles);
    };

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

    // ---- Free layout: any camera, any size and position -----------------
    let freeLayouts = readJson(FREE_KEY, {});
    let freeDrag = null;

    function tiles() {
        return [...grid.querySelectorAll('.multi-tile[data-slot]')];
    }

    function validBox(box) {
        return box && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(box[key]))
            && box.w >= FREE_MIN && box.h >= FREE_MIN && box.x >= 0 && box.y >= 0
            && box.x + box.w <= 1.0001 && box.y + box.h <= 1.0001;
    }

    function freeFor(layoutId) {
        const saved = freeLayouts[layoutId];
        if (!saved || typeof saved !== 'object' || !saved.boxes) return null;
        const boxes = {};
        for (const [slot, box] of Object.entries(saved.boxes)) if (validBox(box)) boxes[slot] = box;
        return Object.keys(boxes).length ? { boxes, order: Array.isArray(saved.order) ? saved.order : [] } : null;
    }

    function paintFree(layout) {
        grid.classList.toggle('free-layout', Boolean(layout));
        for (const tile of tiles()) {
            const slot = tile.dataset.slot;
            const box = layout?.boxes[slot];
            if (!box) {
                for (const name of ['--fx', '--fy', '--fw', '--fh']) tile.style.removeProperty(name);
                tile.style.removeProperty('z-index');
                continue;
            }
            tile.style.setProperty('--fx', String(box.x));
            tile.style.setProperty('--fy', String(box.y));
            tile.style.setProperty('--fw', String(box.w));
            tile.style.setProperty('--fh', String(box.h));
            const depth = layout.order.indexOf(slot);
            tile.style.zIndex = String(depth >= 0 ? 1 + depth : 1);
        }
    }

    // Capture where every camera is right now as a starting free layout.
    function captureGrid() {
        const rect = grid.getBoundingClientRect();
        const boxes = {};
        for (const tile of tiles()) {
            if (tile.offsetParent === null) continue;
            const r = tile.getBoundingClientRect();
            boxes[tile.dataset.slot] = {
                x: (r.left - rect.left) / rect.width, y: (r.top - rect.top) / rect.height,
                w: r.width / rect.width, h: r.height / rect.height
            };
        }
        return { boxes, order: Object.keys(boxes) };
    }

    function saveFree(layoutId, layout) {
        freeLayouts = { ...freeLayouts, [layoutId]: layout };
        writeJson(FREE_KEY, freeLayouts);
    }

    function resetFree() {
        const { layoutId } = current();
        const next = { ...freeLayouts };
        delete next[layoutId];
        freeLayouts = next;
        writeJson(FREE_KEY, freeLayouts);
        paintFree(null);
        apply();
    }

    function startFreeDrag(event, tile, mode) {
        if (event.button !== 0 || grid.classList.contains('focused')) return;
        event.preventDefault();
        event.stopPropagation();
        const { layoutId } = current();
        const layout = freeFor(layoutId) || captureGrid();
        const slot = tile.dataset.slot;
        if (!layout.boxes[slot]) return;
        layout.order = [...layout.order.filter((entry) => entry !== slot), slot]; // bring to front
        const rect = grid.getBoundingClientRect();
        freeDrag = { mode, slot, layoutId, layout, rect, startX: event.clientX, startY: event.clientY, box: { ...layout.boxes[slot] } };
        paintFree(layout);
        grid.classList.add('grid-resizing');
        const target = event.currentTarget;
        target.setPointerCapture?.(event.pointerId);
        target.addEventListener('pointermove', onFreeMove);
        target.addEventListener('pointerup', endFreeDrag, { once: true });
        target.addEventListener('pointercancel', endFreeDrag, { once: true });
    }

    function onFreeMove(event) {
        if (!freeDrag) return;
        const { rect, box } = freeDrag;
        const dx = (event.clientX - freeDrag.startX) / rect.width;
        const dy = (event.clientY - freeDrag.startY) / rect.height;
        const next = { ...box };
        if (freeDrag.mode === 'resize') {
            next.w = Math.min(1 - box.x, Math.max(FREE_MIN, box.w + dx));
            next.h = Math.min(1 - box.y, Math.max(FREE_MIN, box.h + dy));
        } else {
            next.x = Math.min(1 - box.w, Math.max(0, box.x + dx));
            next.y = Math.min(1 - box.h, Math.max(0, box.y + dy));
        }
        freeDrag.layout.boxes[freeDrag.slot] = next;
        freeDrag.moved = true;
        paintFree(freeDrag.layout);
    }

    function endFreeDrag(event) {
        event.currentTarget.removeEventListener('pointermove', onFreeMove);
        grid.classList.remove('grid-resizing');
        if (freeDrag?.moved) saveFree(freeDrag.layoutId, freeDrag.layout);
        else if (freeDrag && !freeFor(freeDrag.layoutId)) paintFree(null); // a plain click changes nothing
        freeDrag = null;
        positionHandles();
    }

    function addTileHandles() {
        for (const tile of tiles()) {
            if (tile.querySelector(':scope > .tile-resize-handle')) continue;
            const resize = document.createElement('div');
            resize.className = 'tile-resize-handle';
            resize.title = 'Drag to resize this camera · double-click to return to the grid';
            const move = document.createElement('div');
            move.className = 'tile-move-handle';
            move.title = 'Drag to move this camera';
            // Inline icon: the bundled icon font is a subset without a move glyph.
            move.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">'
                + '<path fill="currentColor" d="M12 2l3 3h-2v4h-2V5H9l3-3zm0 20l-3-3h2v-4h2v4h2l-3 3zM2 12l3-3v2h4v2H5v2l-3-3zm20 0l-3 3v-2h-4v-2h4V9l3 3z"/></svg>';
            for (const handle of [resize, move]) {
                handle.setAttribute('draggable', 'false');
                // Never start a camera swap or toggle focus from a handle.
                handle.addEventListener('dragstart', (event) => { event.preventDefault(); event.stopPropagation(); });
                handle.addEventListener('mousedown', (event) => event.stopPropagation());
                handle.addEventListener('click', (event) => event.stopPropagation());
                tile.appendChild(handle);
            }
            resize.addEventListener('pointerdown', (event) => startFreeDrag(event, tile, 'resize'));
            move.addEventListener('pointerdown', (event) => startFreeDrag(event, tile, 'move'));
            resize.addEventListener('dblclick', (event) => { event.stopPropagation(); resetFree(); });
        }
    }

    const applyGrid = apply;
    apply = function applyAll() {
        applyGrid();
        addTileHandles();
        paintFree(freeFor(current().layoutId));
    };

    if (typeof ResizeObserver === 'function') new ResizeObserver(() => positionHandles()).observe(grid);
    new MutationObserver(() => requestAnimationFrame(positionHandles))
        .observe(grid, { attributes: true, attributeFilter: ['class', 'data-columns'] });
    apply();
    return { apply: () => apply(), reset, resetFree };
}
