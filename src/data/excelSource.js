/**
 * The Excel data source: reads player/enemy/boss/item/loot stats straight from
 * the authored workbook, so editing `player-enemies.xlsx` and reloading the page
 * is enough.
 *
 * Like jsonSource, it returns the RAW, UNVALIDATED shape and lets schema.js
 * decide what is valid: the dataVersion check is why the version is forwarded
 * verbatim from `data/config.json` rather than replaced with the DATA_VERSION
 * constant. map/view/seed stay hand-authored in config.json and are NOT moved
 * into the workbook.
 *
 * No import-time side effects (no fetch until load() is called); index.js is
 * what registers it.
 */

import { DataError } from './schema.js';
import { readStats } from './xlsx.js';

const CONFIG_PATH = 'data/config.json';
const WORKBOOK_PATH = 'player-enemies.xlsx';

/** @type {{id: string, load: () => Promise<object>}} */
export const excelSource = {
  id: 'excel',

  /**
   * Fetch the hand-authored config and the workbook, then parse the workbook.
   *
   * @returns {Promise<object>} the raw shape consumed by validateGameData()
   * @throws {DataError} for a non-OK HTTP response, naming the file and status
   */
  async load() {
    const [config, bytes] = await Promise.all([fetchJson(CONFIG_PATH), fetchWorkbook()]);

    let player;
    let enemies;
    let bosses;
    let items;
    let loot;
    let biomas;
    try {
      ({ player, enemies, bosses, items, loot, biomas } = await readStats(bytes));
    } catch (cause) {
      // A malformed workbook is bad DATA, and source.js documents that
      // loadGameData reports bad data as a DataError. jsonSource wraps a
      // malformed response body the same way, so a bare Error must not escape
      // from this adapter; readStats' own message already names the workbook,
      // the sheet and the cell.
      throw new DataError(cause.message);
    }

    return {
      // From the file, never the DATA_VERSION constant — schema.js is what
      // compares it and reports a mismatch (dataVersion: expected 1, got 999).
      dataVersion: config?.dataVersion,
      // Optional reads, exactly like jsonSource: a malformed config response
      // must reach validation as a broken SHAPE, not escape as a TypeError.
      map: config?.map,
      view: config?.view,
      // config.json uses null; normalize explicitly so it never becomes undefined.
      seed: config?.seed ?? null,
      player,
      enemies,
      // `undefined` when the workbook declares no such sheet; schema.js treats
      // that as an empty roster/catalog/table.
      bosses,
      items,
      loot,
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
  try {
    return await response.json();
  } catch (cause) {
    throw new DataError(`${path}: response is not valid JSON (${cause.message})`);
  }
}

/**
 * Fetch the workbook.
 *
 * `cache: 'no-store'` is REQUIRED: a cached copy reproduces the exact "my edit
 * did not show up" symptom this source exists to remove.
 */
async function fetchWorkbook() {
  const response = await fetch(WORKBOOK_PATH, { cache: 'no-store' });
  if (!response.ok) {
    // `python -m http.server` turns a file Excel holds open into a 404, which
    // otherwise lies about the workbook being missing, so say so for a 404.
    const hint =
      response.status === 404
        ? ' — if player-enemies.xlsx is open in Excel, close it (or load ?source=json)'
        : '';
    throw new DataError(`${WORKBOOK_PATH}: HTTP ${response.status}${hint}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
