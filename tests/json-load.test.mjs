/**
 * End-to-end tests for the bundled JSON adapter (src/data/jsonSource.js) and
 * the version gate it feeds (src/data/schema.js).
 *
 * `fetch` is stubbed because Node has no page origin: a relative `fetch` cannot
 * resolve on its own, so the real data/*.json files are served from disk by the
 * stub and always restored afterwards, keeping tests independent.
 *
 * What this file exists to prevent, in the code's own words:
 *  - the adapter used to return the DATA_VERSION constant instead of the value
 *    declared in the file, which compared the constant against itself and left
 *    the version gate dead on the only shipped adapter;
 *  - a malformed response escaped the seam as a TypeError or a bare
 *    SyntaxError naming nothing, instead of a path-based DataError.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  DATA_VERSION,
  DataError,
  getSource,
  jsonSource,
  listSources,
  loadGameData,
  registerSource,
} from '../src/data/index.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const readText = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));

const CONFIG_PATH = 'data/config.json';
const PLAYER_PATH = 'data/player.json';
const ENEMIES_PATH = 'data/enemies.json';
const BOSSES_PATH = 'data/bosses.json';
const ITEMS_PATH = 'data/items.json';
const LOOT_PATH = 'data/loot.json';
const BIOMAS_PATH = 'data/biomas.json';

/**
 * A `fetch` stub that serves repo-relative paths from disk, like the page origin
 * would.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.bodies] raw response bodies to serve
 *   verbatim for a path (so a test can inject non-JSON text)
 * @param {Record<string, number>} [options.statuses] HTTP status to fail a path with
 * @param {string[]} [options.seen] receives every requested path
 */
function diskFetchRouter({ bodies = {}, statuses = {}, seen = [] } = {}) {
  return async (url) => {
    const path = String(url);
    seen.push(path);

    if (Object.prototype.hasOwnProperty.call(statuses, path)) {
      return { ok: false, status: statuses[path], json: async () => ({}) };
    }

    const body = Object.prototype.hasOwnProperty.call(bodies, path)
      ? bodies[path]
      : readText(path);
    // Parsed lazily, like the real Response: a non-JSON body must throw from
    // json(), which is exactly where jsonSource turns it into a DataError.
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
}

/** Run `body` with `globalThis.fetch` stubbed, restoring it even on failure. */
async function withFetchStub(stub, body) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** The DataError a rejected promise carries, or a thrown assertion failure. */
async function rejectionFrom(promiseFactory) {
  try {
    await promiseFactory();
  } catch (err) {
    return err;
  }
  assert.fail('expected the promise to reject, but it resolved');
}

/** A config.json body with fields overridden, serialized like a real file. */
function configBody(overrides = {}) {
  return JSON.stringify({ ...readJson(CONFIG_PATH), ...overrides });
}

// ---------- the real files load ----------

test("loadGameData('json') loads, validates and freezes the real data files", async () => {
  const seen = [];
  const data = await withFetchStub(diskFetchRouter({ seen }), () => loadGameData('json'));

  assert.deepEqual(seen, [
    CONFIG_PATH,
    PLAYER_PATH,
    ENEMIES_PATH,
    BOSSES_PATH,
    ITEMS_PATH,
    LOOT_PATH,
    BIOMAS_PATH,
  ]);
  assert.equal(data.dataVersion, readJson(CONFIG_PATH).dataVersion);
  assert.equal(data.dataVersion, 1, 'data/config.json declares version 1');
  assert.equal(data.map.width, 40);
  assert.equal(data.player.name, 'Player');
  assert.equal(Object.isFrozen(data), true);
  assert.equal(Object.isFrozen(data.enemies.archetypes.rat), true);
});

test('jsonSource.load() returns the RAW shape, unvalidated, with the version from the file', async () => {
  // Validation belongs to schema.js, so the adapter must NOT clean anything up:
  // a future version and an unusable width both have to reach the validator.
  const stub = diskFetchRouter({
    bodies: {
      [CONFIG_PATH]: JSON.stringify({ dataVersion: 999, map: { width: 'wide' }, view: {}, seed: 5 }),
    },
  });

  const raw = await withFetchStub(stub, () => jsonSource.load());

  assert.equal(raw.dataVersion, 999, 'the version must come from the file, not the DATA_VERSION constant');
  assert.notEqual(raw.dataVersion, DATA_VERSION);
  assert.deepEqual(raw.map, { width: 'wide' }, 'the adapter must not validate the map');
  assert.deepEqual(raw.view, {});
  assert.equal(raw.seed, 5);
  assert.equal(raw.player.name, 'Player');
  assert.equal(raw.enemies.archetypes.goblin.name, 'Goblin');
  // The boss is its own section, so it must survive the adapter in `bosses`, not
  // inside the enemies roster.
  assert.equal(raw.bosses.archetypes.boss.name, 'Dungeon Lord');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(raw.enemies.archetypes, 'boss'),
    'the adapter must not smuggle the boss back into the enemies roster',
  );
});

test('a seed of null in the file normalizes to null, never undefined', async () => {
  const raw = await withFetchStub(
    diskFetchRouter({ bodies: { [CONFIG_PATH]: configBody({ seed: null }) } }),
    () => jsonSource.load(),
  );

  assert.equal(raw.seed, null);
  assert.ok('seed' in raw, 'the raw shape must always carry a seed key');
});

// ---------- the version gate ----------

test('a file declaring a future dataVersion is rejected: the version gate is live', async () => {
  const stub = diskFetchRouter({ bodies: { [CONFIG_PATH]: configBody({ dataVersion: 999 }) } });
  const err = await withFetchStub(stub, () => rejectionFrom(() => loadGameData('json')));

  assert.ok(err instanceof DataError, `expected a DataError, got ${err && err.name}`);
  assert.equal(err.name, 'DataError');
  assert.equal(err.message, 'dataVersion: expected 1, got 999');
});

test('a file with no dataVersion at all is rejected, not defaulted', async () => {
  const withoutVersion = readJson(CONFIG_PATH);
  delete withoutVersion.dataVersion;
  const stub = diskFetchRouter({ bodies: { [CONFIG_PATH]: JSON.stringify(withoutVersion) } });
  const err = await withFetchStub(stub, () => rejectionFrom(() => loadGameData('json')));

  assert.ok(err instanceof DataError, `expected a DataError, got ${err && err.name}`);
  assert.equal(err.message, 'dataVersion: missing, expected 1');
});

test('the cross-field canvas budget is enforced through the adapter too', async () => {
  // Both fields are individually legal; only their product is not. This is the
  // rule that cannot live in a per-field check, so it is exercised end to end.
  const stub = diskFetchRouter({ bodies: { [CONFIG_PATH]: configBody({ map: { ...readJson(CONFIG_PATH).map, width: 512 }, view: { tileSize: 64 } }) } });
  const err = await withFetchStub(stub, () => rejectionFrom(() => loadGameData('json')));

  assert.ok(err instanceof DataError, `expected a DataError, got ${err && err.name}`);
  assert.equal(
    err.message,
    'view.tileSize: 64 x map.width 512 = 32768 exceeds the maximum canvas dimension ' +
      '(16383 at devicePixelRatio 2); lower tileSize or the map width',
  );
});

// ---------- malformed bodies ----------

test('a null or primitive config.json surfaces as a DataError, never a TypeError', async () => {
  for (const body of ['null', '42', '"nope"', 'true']) {
    const stub = diskFetchRouter({ bodies: { [CONFIG_PATH]: body } });
    const err = await withFetchStub(stub, () => rejectionFrom(() => loadGameData('json')));

    assert.ok(err instanceof DataError, `config ${body}: expected a DataError, got ${err && err.name}`);
    assert.ok(!(err instanceof TypeError), `config ${body}: must not escape the seam as a TypeError`);
    assert.equal(
      err.message,
      'dataVersion: missing, expected 1\n' +
        'map: expected a plain object, got undefined\n' +
        'view: expected a plain object, got undefined',
      `config ${body}: every missing section must be named, in one DataError`,
    );
  }
});

test('a non-JSON response body is a DataError naming the file', async () => {
  for (const [path, body] of [
    [CONFIG_PATH, '<html>502 Bad Gateway</html>'],
    [PLAYER_PATH, 'not json at all'],
  ]) {
    const stub = diskFetchRouter({ bodies: { [path]: body } });
    const err = await withFetchStub(stub, () => rejectionFrom(() => loadGameData('json')));

    assert.ok(err instanceof DataError, `${path}: expected a DataError, got ${err && err.name}`);
    // The parser's own text is runtime-specific, so only the stable prefix is
    // pinned; the file name is what the author needs.
    assert.ok(
      err.message.startsWith(`${path}: response is not valid JSON (`),
      `${path}: message must name the file and the cause, got: ${err.message}`,
    );
  }
});

test('a non-OK HTTP response names the file and the exact status', async () => {
  for (const [path, status] of [
    [CONFIG_PATH, 404],
    [PLAYER_PATH, 500],
  ]) {
    const stub = diskFetchRouter({ statuses: { [path]: status } });
    const err = await withFetchStub(stub, () => rejectionFrom(() => loadGameData('json')));

    assert.ok(err instanceof DataError, `${path}: expected a DataError, got ${err && err.name}`);
    assert.equal(err.message, `${path}: HTTP ${status}`);
  }
});

// ---------- registry hygiene ----------

test('registerSource stores the TRIMMED id and is looked up by it', () => {
  const source = {
    id: '  padded-source  ',
    async load() {
      return {};
    },
  };

  const registered = registerSource(source);

  assert.equal(registered.id, 'padded-source', 'the registered copy carries the trimmed id');
  assert.equal(getSource('padded-source'), registered, 'the trimmed id is the lookup key');
  assert.ok(listSources().includes('padded-source'));
  assert.ok(
    !listSources().includes('  padded-source  '),
    `the raw spelling must not be a key: ${listSources().join(', ')}`,
  );

  // The raw spelling is not a key either, so it must fail as unknown.
  let unknown = null;
  try {
    getSource('  padded-source  ');
  } catch (err) {
    unknown = err;
  }
  assert.ok(unknown instanceof DataError, 'the untrimmed spelling must not resolve');
  assert.ok(unknown.message.includes('Unknown data source'));

  // A well-formed source keeps its identity: callers compare it by reference.
  const plain = { id: 'identity-source', async load() { return {}; } };
  assert.equal(registerSource(plain), plain);
});
