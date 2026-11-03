/**
 * Unit tests for the sprite cache (src/render/sprites.js).
 *
 * Presentation-only code, so it is tested in Node with a fake image: `Image`
 * does not exist here, and even in a browser an image decodes whenever it
 * decodes. `createImage` is the seam that lets these tests decide exactly when
 * a load succeeds or fails.
 *
 * What this file exists to prevent:
 *  - get() returning a not-yet-loaded image, which would draw an empty rect
 *    over a perfectly good glyph;
 *  - a failed path being retried on every repaint (a typo hammering the
 *    network), or firing onReady forever;
 *  - `enabled: false` (the ?sprites=off hatch) still starting a request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSprites } from '../src/render/sprites.js';

class FakeImage {
  constructor() {
    this.src = '';
    this.naturalWidth = 0;
    this.listeners = { load: [], error: [] };
  }

  addEventListener(type, handler) {
    this.listeners[type].push(handler);
  }

  fireLoad(width = 16) {
    this.naturalWidth = width;
    for (const handler of this.listeners.load) handler();
  }

  fireError() {
    for (const handler of this.listeners.error) handler();
  }
}

/** Build a cache whose images the test drives by hand. */
function harness(options = {}) {
  const created = [];
  let readyCount = 0;
  const sprites = createSprites({
    createImage: () => {
      const image = new FakeImage();
      created.push(image);
      return image;
    },
    onReady: () => {
      readyCount += 1;
    },
    ...options,
  });
  return { sprites, created, readyCount: () => readyCount };
}

test('an unknown path starts loading and returns null until it loads', () => {
  const { sprites, created, readyCount } = harness();

  assert.equal(sprites.get('assets/wall.png'), null, 'a pending image must fall back');
  assert.equal(created.length, 1, 'the first get() must start the load');
  assert.equal(created[0].src, 'assets/wall.png', 'the authored path is the image src');

  created[0].fireLoad();

  assert.equal(readyCount(), 1, 'onReady must fire so the canvas repaints');
  assert.equal(sprites.get('assets/wall.png'), created[0], 'a loaded image is returned');
});

test('the same path is created and requested only once', () => {
  const { sprites, created } = harness();

  sprites.get('a.png');
  sprites.get('a.png');
  created[0].fireLoad();
  sprites.get('a.png');
  sprites.get('a.png');

  assert.equal(created.length, 1, 'the cache must serve every later lookup');
});

test('a failed image stays failed: never retried, always glyph fallback', () => {
  const { sprites, created, readyCount } = harness();

  sprites.get('broken.png');
  created[0].fireError();

  assert.equal(sprites.get('broken.png'), null, 'a failed image must fall back');
  assert.equal(created.length, 1, 'a failed path must not be re-requested');
  assert.equal(readyCount(), 0, 'a failure must not trigger a repaint');
});

test('an empty or absent path never touches the cache', () => {
  const { sprites, created } = harness();

  assert.equal(sprites.get(null), null);
  assert.equal(sprites.get(undefined), null);
  assert.equal(sprites.get(''), null);
  assert.equal(sprites.get('   '), null);
  assert.equal(created.length, 0, 'no path means no request');
});

test('enabled:false makes every lookup a null no-op without creating images', () => {
  const { sprites, created } = harness({ enabled: false });

  assert.equal(sprites.get('assets/wall.png'), null);
  assert.equal(created.length, 0, 'a disabled cache must not even start a load');
});

test('a loaded image that reports no width stays in fallback', () => {
  // Defensive: a decoder that fires load before dimensions exist would
  // otherwise be drawn as an empty rect over the glyph.
  const { sprites, created } = harness();

  sprites.get('zero.png');
  created[0].fireLoad(0);

  assert.equal(sprites.get('zero.png'), null);
});
