/**
 * The data-source provider registry.
 *
 * A source is a small adapter `{ id, load() }` that knows how to reach a data
 * store and return the RAW shape schema.js validates. Keeping the registry here
 * (instead of hard-coding JSON in the engine) is what lets a future Excel/DB
 * adapter plug in without touching src/core.
 */

import { DataError, validateGameData } from './schema.js';

/** @type {Map<string, {id: string, load: () => Promise<object>}>} */
const sources = new Map();

/**
 * Register a data source. Re-registering the same id replaces it, which keeps
 * module reloads idempotent.
 *
 * @param {{id: string, load: () => Promise<object>}} source
 * @returns {{id: string, load: () => Promise<object>}} the registered source
 */
export function registerSource(source) {
  if (!source || typeof source.id !== 'string' || source.id.trim() === '') {
    throw new DataError('registerSource: a data source needs a non-empty string id');
  }
  if (typeof source.load !== 'function') {
    throw new DataError(`registerSource: source "${source.id}" needs a load() function`);
  }

  // Key the registry by the TRIMMED id. Validating the trimmed id and then
  // storing the raw one let `{ id: '  padded  ' }` register under a key nothing
  // could ever look up, while listSources() reported the padded spelling.
  // Well-formed sources keep their identity (callers compare it, e.g.
  // getSource('json') === jsonSource), so a copy is only made when normalizing
  // actually changes something.
  const id = source.id.trim();
  const registered = id === source.id ? source : { ...source, id };
  sources.set(id, registered);
  return registered;
}

/**
 * Look up a registered source.
 *
 * @param {string} id
 * @returns {{id: string, load: () => Promise<object>}}
 * @throws {DataError} when the id is unknown, listing the known ids
 */
export function getSource(id) {
  const source = sources.get(id);
  if (!source) {
    const known = listSources();
    const knownList = known.length > 0 ? known.join(', ') : '(none)';
    throw new DataError(`Unknown data source ${JSON.stringify(id)} (known: ${knownList})`);
  }
  return source;
}

/** @returns {string[]} the registered source ids, in registration order. */
export function listSources() {
  return [...sources.keys()];
}

/**
 * Load raw data from a source and validate it into a frozen GameData.
 *
 * @param {string} id source id (e.g. 'json')
 * @returns {Promise<Readonly<object>>}
 * @throws {DataError} when the source is unknown or the data is invalid
 */
export async function loadGameData(id) {
  const source = getSource(id);
  const raw = await source.load();
  return validateGameData(raw);
}
