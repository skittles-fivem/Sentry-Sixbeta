// The key's face: a 144x144 SVG (Stream Deck scales it for every model) with
// the count large, "downloads" under it, and a status line at the bottom
// (the gain since the plugin started, or why the last check failed).

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The count's font size: as large as fits the key's width. */
function countSize(text) {
  if (text.length <= 3) return 52;
  if (text.length <= 5) return 42;
  return 34;
}

/**
 * @param {{ count: string | null, status: string, statusColor: string }} face
 * @returns {string} a data URL for Key.setImage
 */
export function keyImage({ count, status, statusColor }) {
  const main = count ?? '—';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" rx="16" fill="#101418"/>
<text x="72" y="28" text-anchor="middle" font-family="Segoe UI,Helvetica,Arial,sans-serif" font-size="13" letter-spacing="0.5" font-weight="600" fill="#e53935">SENTRY MANAGER</text>
<text x="72" y="${main.length <= 5 ? 88 : 84}" text-anchor="middle" font-family="Segoe UI,Helvetica,Arial,sans-serif" font-size="${countSize(main)}" font-weight="700" fill="#ffffff">${esc(main)}</text>
<text x="72" y="110" text-anchor="middle" font-family="Segoe UI,Helvetica,Arial,sans-serif" font-size="16" fill="#9aa4ae">downloads</text>
<text x="72" y="134" text-anchor="middle" font-family="Segoe UI,Helvetica,Arial,sans-serif" font-size="15" font-weight="600" fill="${statusColor}">${esc(status)}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}
