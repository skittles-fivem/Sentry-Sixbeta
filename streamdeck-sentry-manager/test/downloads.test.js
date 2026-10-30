import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTotal, keyCount, fetchDownloads } from '../src/downloads.js';
import { keyImage } from '../src/key-image.js';

test('parseTotal reads the exact number from the title attribute', () => {
  const html = '<span>Total downloads</span>\n<h3 title="1,234">1.2K</h3>';
  assert.equal(parseTotal(html), 1234);
});

test('parseTotal falls back to the short form', () => {
  assert.equal(parseTotal('<div>Total downloads</div><h3>550</h3>'), 550);
  assert.equal(parseTotal('<div>Total downloads</div><h3> 12.3K </h3>'), 12300);
  assert.equal(parseTotal('<div>Total downloads</div><h3>1.5M</h3>'), 1500000);
});

test('parseTotal returns null when the page has no total', () => {
  assert.equal(parseTotal('<html>Sign in</html>'), null);
});

test('keyCount keeps the number short enough for a key', () => {
  assert.equal(keyCount(550), '550');
  assert.equal(keyCount(12345), '12,345');
  assert.equal(keyCount(123456), '123k');
  assert.equal(keyCount(1234567), '1.2M');
});

test('fetchDownloads returns the total and reports failures briefly', async (t) => {
  const page = (status, body) => async () => new Response(body, { status });
  t.mock.method(globalThis, 'fetch', page(200, '<p>Total downloads</p><h3 title="550">550</h3>'));
  assert.equal(await fetchDownloads(), 550);
  t.mock.method(globalThis, 'fetch', page(429, ''));
  await assert.rejects(fetchDownloads(), /rate limited/);
  t.mock.method(globalThis, 'fetch', page(200, '<html></html>'));
  await assert.rejects(fetchDownloads(), /no count/);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(fetchDownloads(), /offline/);
});

test('keyImage escapes text and returns an SVG data URL', () => {
  const url = keyImage({ count: '1,234', status: '+3 new', statusColor: '#43a047' });
  assert.match(url, /^data:image\/svg\+xml;charset=utf8,/);
  const svg = decodeURIComponent(url.split(',').slice(1).join(','));
  assert.match(svg, />1,234</);
  assert.match(svg, />\+3 new</);
});
