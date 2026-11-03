/**
 * The bundled JSON data source: the seven generated files that mirror the
 * workbook (config, player, enemies, bosses, items, loot, biomas).
 *
 * It deliberately returns the RAW, UNVALIDATED shape and lets schema.js decide
 * what is valid, so validation stays in one place — including the dataVersion
 * check, which is why the version is forwarded verbatim instead of being
 * replaced with the DATA_VERSION constant. This module has no import-time side
 * effects (no fetch happens until load() is called); index.js is what registers
 * it.
 */

import { DataError } from './schema.js';

/** @type {{id: string, load: () => Promise<object>}} */
export const jsonSource = {
  id: 'json',

  /**
   * Fetch config, player, enemies, bosses, items, loot and biomas concurrently
   * and assemble the raw shape.
   *
   * @returns {Promise<object>} the raw shape consumed by validateGameData()
   * @throws {DataError} for a non-OK HTTP response, naming the file and status
   */
  async load() {
    const [config, player, enemies, bosses, items, loot, biomas] = await Promise.all([
      fetchJson('data/config.json'),
      fetchJson('data/player.json'),
      fetchJson('data/enemies.json'),
      fetchJson('data/bosses.json'),
      fetchJson('data/items.json'),
      fetchJson('data/loot.json'),
      fetchJson('data/biomas.json'),
    ]);

    return {
      // The version comes FROM THE FILE, not from the DATA_VERSION constant this
      // module used to import: returning the constant compared it against
      // itself, so a file declaring a future/unrelated dataVersion loaded fine
      // and the gate was dead on the only shipped adapter. schema.js compares
      // and reports it (dataVersion: expected 1, got 999).
      dataVersion: config?.dataVersion,
      // Optional reads: a malformed response (null, undefined, a primitive) must
      // reach validation as a broken SHAPE so schema.js reports it as a
      // path-based DataError. Dereferencing `config.map` first escaped the seam
      // as a TypeError, which told the author nothing about which file was bad.
      // `player`/`enemies`/`bosses`/`items`/`loot` need no guard: they are the
      // parsed roots themselves, never dereferenced here, so a null/primitive
      // response flows into validateGameData untouched and is reported at its own
      // path.
      map: config?.map,
      view: config?.view,
      // config.json uses null; normalize explicitly so it never becomes undefined.
      seed: config?.seed ?? null,
      player,
      enemies,
      bosses,
      items,
      loot,
      // The flat tile-sprite map; schema.js treats an absent/null section as
      // "no biome sprites" ({}), the same optional-section policy as above.
      biomas,
    };
  },
};

/**
 * @param {string} path relative URL, same origin as the page
 * @returns {Promise<object>} the parsed JSON
 */
async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new DataError(`${path}: HTTP ${response.status}`);
  }
  // A body that is not valid JSON (an HTML error page served with 200, a
  // truncated file) must fail here as a DataError naming the file, not escape
  // the seam as a bare SyntaxError that says nothing about where it came from.
  try {
    return await response.json();
  } catch (cause) {
    throw new DataError(`${path}: response is not valid JSON (${cause.message})`);
  }
}
