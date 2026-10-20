/**
 * Tiny route thumbnail for drive cards: projects a drive's GPS points into a
 * small SVG polyline. Pure and cheap — at most MAX_POINTS vertices per card,
 * no tiles, no network — so hundreds of cards render without cost.
 */

const MAX_POINTS = 64;

/**
 * @param {Array<[number, number]>} points [lat, lng, ...] pairs
 * @param {{ width?: number, height?: number, pad?: number }} [box]
 * @returns {{ path: string, start: [number, number], end: [number, number] } | null}
 */
export function routeThumbnail(points, { width = 100, height = 36, pad = 4 } = {}) {
    if (!Array.isArray(points)) return null;
    const valid = points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (valid.length < 2) return null;
    const step = Math.max(1, Math.ceil(valid.length / MAX_POINTS));
    const sampled = valid.filter((_, i) => i % step === 0);
    if (sampled[sampled.length - 1] !== valid[valid.length - 1]) sampled.push(valid[valid.length - 1]);

    // Equirectangular projection, longitude scaled by latitude so shapes keep
    // their proportions; north is up.
    const midLat = sampled.reduce((sum, p) => sum + p[0], 0) / sampled.length;
    const kx = Math.cos((midLat * Math.PI) / 180) || 1;
    const xs = sampled.map((p) => p[1] * kx);
    const ys = sampled.map((p) => -p[0]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = maxX - minX, spanY = maxY - minY;
    if (spanX === 0 && spanY === 0) return null;
    const scale = Math.min((width - pad * 2) / (spanX || Infinity), (height - pad * 2) / (spanY || Infinity));
    const offX = (width - spanX * scale) / 2, offY = (height - spanY * scale) / 2;
    const coords = xs.map((x, i) => [
        +(offX + (x - minX) * scale).toFixed(1),
        +(offY + (ys[i] - minY) * scale).toFixed(1)
    ]);
    return {
        path: coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(''),
        start: coords[0],
        end: coords[coords.length - 1]
    };
}
