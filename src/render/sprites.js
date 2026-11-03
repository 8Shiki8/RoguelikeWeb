/**
 * Sprite cache: maps an authored `spritePath` to a loaded HTMLImageElement.
 *
 * Presentation-only — nothing under src/core knows this module exists. The
 * renderer calls `get(path)` while drawing; it returns the image ONLY once it
 * has actually decoded, and `null` in every other case (no path, still loading,
 * failed, disabled), so the caller falls back to the glyph/tile exactly as
 * before. A path that failed to load stays failed: it is never re-requested,
 * which stops a typo from hammering the network on every repaint.
 *
 * `onReady` fires after each successful load. The canvas repaints only on
 * input/fx activity, so an image that finishes loading after the first draw
 * needs this callback to trigger one more repaint; without it the sprite would
 * sit invisible until the next key press.
 *
 * `createImage` exists so Node tests can drive a fake image (there is no
 * `Image` in Node) — the default is the browser's.
 */

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled=true]  false = every get() returns null (the `?sprites=off` escape hatch)
 * @param {(() => void) | null} [options.onReady=null] called after each image loads
 * @param {() => { src: string, naturalWidth: number, addEventListener: Function }} [options.createImage]
 * @returns {{get: (path: string) => HTMLImageElement | null}}
 */
export function createSprites({ enabled = true, onReady = null, createImage = defaultCreateImage } = {}) {
  // path -> { image, state: 'pending' | 'loaded' | 'failed' }
  const cache = new Map();

  function get(path) {
    if (!enabled || typeof path !== 'string' || path.trim() === '') return null;

    let entry = cache.get(path);
    if (!entry) {
      const image = createImage();
      entry = { image, state: 'pending' };
      image.addEventListener('load', () => {
        entry.state = 'loaded';
        if (onReady) onReady();
      });
      image.addEventListener('error', () => {
        // Terminal: the entry stays cached so the path is never re-tried, but
        // state !== 'loaded' keeps get() returning null (glyph fallback).
        entry.state = 'failed';
      });
      image.src = path;
      cache.set(path, entry);
    }

    const ready = entry.state === 'loaded' && entry.image.naturalWidth > 0;
    return ready ? entry.image : null;
  }

  return { get };
}

function defaultCreateImage() {
  return new Image();
}
