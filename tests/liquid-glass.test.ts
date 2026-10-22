import test from 'node:test';
import assert from 'node:assert/strict';
import { liquidGlassMap } from '../src/ui/liquid-glass';

const pixel = (map: Uint8ClampedArray, width: number, x: number, y: number) => {
  const index = (y * width + x) * 4;
  return { r: map[index], g: map[index + 1] };
};

test('the middle of a liquid glass pane leaves the backdrop in place', () => {
  const map = liquidGlassMap(200, 80, 16, 20);
  assert.deepEqual(pixel(map, 200, 100, 40), { r: 128, g: 128 });
  assert.equal(map.length, 200 * 80 * 4);
});

test('near the rim the map pulls samples inward', () => {
  const map = liquidGlassMap(200, 80, 16, 20);
  // Right edge samples from the left, left edge from the right; top from below, bottom from above.
  assert.ok(pixel(map, 200, 199, 40).r < 128);
  assert.ok(pixel(map, 200, 0, 40).r > 128);
  assert.ok(pixel(map, 200, 100, 0).g > 128);
  assert.ok(pixel(map, 200, 100, 79).g < 128);
  assert.equal(pixel(map, 200, 199, 40).g, 128);
});
