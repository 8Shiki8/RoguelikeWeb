/**
 * Deterministic, seedable RNG.
 *
 * A roguelike run must be reproducible from its seed so that a dungeon can be
 * re-created for debugging and (later) for daily runs. Never use Math.random()
 * inside generation or rules code: pass one of these around instead.
 */

/** @returns {number} a fresh unsigned 32-bit seed. */
export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/**
 * mulberry32: small, fast, good enough for gameplay, and fully deterministic.
 * @param {number} seed
 */
export function createRng(seed) {
  let state = seed >>> 0;

  const rng = {
    seed: state,

    /** @returns {number} float in [0, 1). */
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },

    /** @returns {number} integer in [min, max], both inclusive. */
    int(min, max) {
      return min + Math.floor(rng.next() * (max - min + 1));
    },

    /** @returns {*} a random element of a non-empty array. */
    pick(items) {
      return items[rng.int(0, items.length - 1)];
    },
  };

  return rng;
}
