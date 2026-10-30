// Sentry Six Manager's download count: how many times its Docker image was
// pulled from GitHub's container registry. GitHub shows that total on the
// package page but has no API for it, so the page is read and the number
// taken from next to "Total downloads" (the same way the Sentry-Manager
// repository's own README badge gets it: tools/downloadsBadge.js there).

export const PACKAGE_URL = 'https://github.com/skittles-fivem/Sentry-Manager/pkgs/container/sentry-manager';

/** The total from the package page: the exact title="12345", else "12.3K". Null when the page has no total. */
export function parseTotal(html) {
  const at = html.search(/Total downloads/i);
  if (at < 0) return null;
  const after = html.slice(at, at + 600);
  const exact = after.match(/title="([\d,]+)"/);
  if (exact) return Number(exact[1].replace(/,/g, ''));
  const short = after.match(/>\s*([\d.]+)\s*([kKmM]?)\s*</);
  if (!short) return null;
  const scale = { k: 1e3, m: 1e6 }[short[2].toLowerCase()] || 1;
  return Math.round(Number(short[1]) * scale);
}

/** 1234 -> "1,234" up to 99,999, then "123k", "1.2M": what still fits on a key. */
export function keyCount(n) {
  if (n < 1e5) return n.toLocaleString('en-US');
  if (n < 1e6) return `${Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Reads the package page and returns the total. Throws with a short reason (shown on the key) when it cannot. */
export async function fetchDownloads(url = PACKAGE_URL, timeoutMs = 15000) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'sentry-manager-streamdeck', Accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('offline');
  }
  if (res.status === 429) throw new Error('rate limited');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = parseTotal(await res.text());
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('no count');
  return total;
}
