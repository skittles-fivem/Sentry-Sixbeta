import test from 'node:test';
import assert from 'node:assert/strict';
import { routeThumbnail } from '../../src/renderer/scripts/core/routeThumbnail.js';

test('projects a route into the thumbnail box with north up and both ends marked', () => {
  const points = [[30.00, -97.00], [30.01, -97.00], [30.02, -96.99], [30.03, -96.98]];
  const thumb = routeThumbnail(points, { width: 100, height: 36, pad: 4 });
  assert.ok(thumb.path.startsWith('M'));
  for (const [x, y] of [thumb.start, thumb.end]) {
    assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 36, `inside box: ${x},${y}`);
  }
  assert.ok(thumb.end[1] < thumb.start[1], 'travelling north moves up the thumbnail');
  assert.ok(thumb.end[0] > thumb.start[0], 'travelling east moves right');
});

test('caps the number of vertices for long drives and ignores bad points', () => {
  const points = Array.from({ length: 3000 }, (_, i) => [30 + i * 1e-4, -97 + Math.sin(i / 50) * 1e-3, 0, 40, 0]);
  points.splice(10, 0, [NaN, 1], null, 'x');
  const thumb = routeThumbnail(points);
  assert.ok(thumb.path.split(/[ML]/).filter(Boolean).length <= 66);
});

test('returns null when there is nothing to draw', () => {
  assert.equal(routeThumbnail(undefined), null);
  assert.equal(routeThumbnail([[30, -97]]), null);
  assert.equal(routeThumbnail([[30, -97], [30, -97]]), null);
});
