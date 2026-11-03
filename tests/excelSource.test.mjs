/**
 * Tests for the Excel data source (src/data/excelSource.js).
 *
 * This adapter is the thing that makes `player-enemies.xlsx` a RUNTIME source:
 * the page fetches the workbook and parses it on every load. `fetch` is stubbed
 * because Node has no page origin, so a relative `fetch` cannot resolve on its
 * own; the stub serves the real data/config.json (so the adapter is exercised
 * against the config it actually ships with) and the workbook fixtures from
 * disk. It is always restored afterwards, keeping tests independent.
 *
 * What this file exists to prevent, in the code's own words:
 *  - a cached copy of the workbook, which reproduces the exact "my edit did not
 *    show up" symptom this source exists to remove — hence `cache: 'no-store'`;
 *  - a malformed workbook escaping the seam as a bare `Error`, when source.js
 *    documents that bad DATA is reported as a `DataError` (jsonSource wraps a
 *    malformed response body the same way);
 *  - the adapter inventing a version instead of forwarding the one declared in
 *    the file, which would leave the version gate dead on this adapter too;
 *  - `python -m http.server` reporting a workbook that Excel holds open as a
 *    404, which lies about the file being missing instead of locked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  DATA_VERSION,
  DataError,
  excelSource,
  loadGameData,
  validateGameData,
} from '../src/data/index.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_PATH = join(REPO_ROOT, 'data', 'config.json');
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures');

const readConfig = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const fixture = (name) => readFileSync(join(FIXTURES, name));

/** The values tests/fixtures/excel-shaped.xlsx carries (see fixtures/README.md). */
const FIXTURE_PLAYER_MAXHP = 99;

const realFetch = globalThis.fetch;

/**
 * Replace `fetch` for the duration of `run`, recording every call. The handler
 * receives the requested URL and returns a minimal Response-like object.
 */
async function withFetch(handler, run) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

const workbookResponse = (bytes, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    throw new SyntaxError('Unexpected token < in JSON');
  },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const failingResponse = (status) => ({
  ok: false,
  status,
  json: async () => {
    throw new SyntaxError('not json either');
  },
  arrayBuffer: async () => new ArrayBuffer(0),
});

/** A router that answers both requests the adapter makes. */
function serve({ config = readConfig(), workbook = fixture('excel-shaped.xlsx'), configStatus = 200, workbookStatus = 200 } = {}) {
  return (url) => {
    if (url.endsWith('config.json')) {
      return configStatus === 200 ? jsonResponse(config) : failingResponse(configStatus);
    }
    if (url.endsWith('player-enemies.xlsx')) {
      return workbookStatus === 200 ? workbookResponse(workbook) : failingResponse(workbookStatus);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

// ---------- the seam ----------

test('loadGameData("excel") yields validated, frozen game data from the workbook', async () => {
  const gameData = await withFetch(serve(), () => loadGameData('excel'));

  // The workbook fixture carries maxHp 99, the committed data/player.json says
  // 20: this asserts the value came from the WORKBOOK, not the fallback files.
  assert.equal(gameData.player.maxHp, FIXTURE_PLAYER_MAXHP);
  assert.equal(gameData.player.name, 'Player & Co');
  assert.equal(gameData.dataVersion, DATA_VERSION);

  // The archetypes and spawn table survived parsing and validation.
  assert.equal(gameData.enemies.archetypes.rat.name, 'Giant RAT');
  assert.equal(gameData.enemies.archetypes.goblin.maxHp, 10);
  assert.deepEqual(
    gameData.enemies.spawn.map((s) => [s.archetype, s.count]),
    [['rat', 2], ['goblin', 1]],
  );

  // loadGameData hands out frozen data, exactly like the JSON source.
  assert.ok(Object.isFrozen(gameData));
});

test('the SHIPPED workbook drives the equipment sections through the whole seam', async () => {
  // End to end on the real file: workbook bytes -> readStats -> validateGameData
  // -> frozen GameData. The structural facts are asserted (not exact authored
  // values) so a designer can rebalance data/items.json and the loot table in
  // Excel without breaking this test, while a section that stops being forwarded
  // by the adapter still fails here.
  const workbook = readFileSync(join(REPO_ROOT, 'player-enemies.xlsx'));
  const gameData = await withFetch(serve({ workbook }), () => loadGameData('excel'));

  assert.ok(
    Object.keys(gameData.items.definitions).length > 0,
    'the items sheet must reach GameData as a non-empty catalog',
  );
  assert.ok(gameData.loot.length > 0, 'the loot sheet must reach GameData as a non-empty table');
  assert.ok(
    gameData.loot.every((row) => Object.hasOwn(gameData.items.definitions, row.item)),
    'every loot row must reference a real item',
  );
  assert.ok(
    gameData.loot.some((row) => row.enemy === '*'),
    'the wildcard row must survive validation',
  );
  assert.equal(typeof gameData.player.critChance, 'number');
  assert.equal(typeof gameData.enemies.archetypes.rat.xp, 'number');

  // The item bonuses are real numbers, defaulted rather than left undefined, so
  // gameplay code can add them without an `?? 0` at every call site.
  for (const item of Object.values(gameData.items.definitions)) {
    for (const key of ['attack', 'defense', 'maxHp', 'critChance', 'critDamage', 'luck']) {
      assert.equal(typeof item[key], 'number', `${item.name}.${key} must be a number`);
    }
  }
});

test('a workbook with no bosses sheet yields an empty boss roster, not an error', async () => {
  // The `bosses` sheet is OPTIONAL by design: the shipped workbook fixtures are
  // binary and produced outside this repo, so a workbook authored before the
  // sheet existed must keep loading. The absent section normalizes to an empty
  // roster, which is what pins that deliberate optionality end to end.
  const gameData = await withFetch(serve(), () => loadGameData('excel'));

  assert.deepEqual(gameData.bosses, { archetypes: {} });
  assert.equal(Object.keys(gameData.bosses.archetypes).length, 0);
});

test('the adapter returns the RAW shape and forwards the version from the FILE', async () => {
  // The jsonSource bug this guards against: returning the DATA_VERSION constant
  // instead of the declared value compared the constant against itself and left
  // the version gate dead. A wrong version in the config must survive to the
  // validator, and be rejected there.
  const config = { ...readConfig(), dataVersion: 999 };

  const raw = await withFetch(serve({ config }), () => excelSource.load());

  assert.equal(raw.dataVersion, 999, 'the declared version must be forwarded, not replaced');
  assert.equal(raw.player.maxHp, FIXTURE_PLAYER_MAXHP);
  assert.equal(raw.seed, config.seed ?? null);

  assert.throws(
    () => validateGameData(raw),
    (err) => err instanceof DataError && /dataVersion/.test(err.message),
    'the version gate must still fire on the adapter that ships to the page',
  );
});

test('the workbook is fetched with cache: "no-store"', async () => {
  // Without this the browser can serve a cached copy of the workbook, so an
  // edit in Excel followed by a reload still shows the old stats.
  const calls = await withFetch(serve(), (recorded) => excelSource.load().then(() => recorded));

  const workbookCall = calls.find((c) => c.url.endsWith('player-enemies.xlsx'));
  assert.ok(workbookCall, 'the workbook must actually be fetched');
  assert.equal(workbookCall.init?.cache, 'no-store');

  // The config is hand-authored and does not need the cache-buster.
  const configCall = calls.find((c) => c.url.endsWith('config.json'));
  assert.ok(configCall, 'the config must be fetched too');
});

// ---------- failure paths ----------

test('a locked workbook (which http.server reports as 404) names the file, the status and the way out', async () => {
  const err = await withFetch(serve({ workbookStatus: 404 }), () =>
    excelSource.load().then(
      () => assert.fail('expected load() to reject'),
      (e) => e,
    ),
  );

  assert.ok(err instanceof DataError, `expected a DataError, got ${err.name}`);
  assert.match(err.message, /player-enemies\.xlsx/);
  assert.match(err.message, /404/);
  // A 404 here usually means the file is open in Excel, not that it is missing,
  // so the message has to say so instead of lying.
  assert.match(err.message, /open in Excel/);
  assert.match(err.message, /source=json/);
});

test('a non-404 HTTP failure does NOT claim the workbook is open in Excel', async () => {
  const err = await withFetch(serve({ workbookStatus: 500 }), () =>
    excelSource.load().then(
      () => assert.fail('expected load() to reject'),
      (e) => e,
    ),
  );

  assert.ok(err instanceof DataError, `expected a DataError, got ${err.name}`);
  assert.match(err.message, /player-enemies\.xlsx/);
  assert.match(err.message, /500/);
  assert.doesNotMatch(err.message, /open in Excel/, 'the Excel hint is only true for a 404');
});

test('a malformed workbook is reported as a DataError, keeping the sheet and cell', async () => {
  // source.js documents that bad DATA reaches callers as a DataError. A bare
  // Error here would break that contract for the adapter that runs on the page.
  const err = await withFetch(serve({ workbook: fixture('excel-shaped-bad-number.xlsx') }), () =>
    excelSource.load().then(
      () => assert.fail('expected load() to reject'),
      (e) => e,
    ),
  );

  assert.ok(err instanceof DataError, `expected a DataError, got ${err.name}`);
  assert.match(err.message, /player!G2/, 'the author must still be told WHERE the problem is');
  assert.match(err.message, /defense/);
});

test('a valid ZIP that is not a workbook is rejected as a DataError', async () => {
  const err = await withFetch(serve({ workbook: fixture('not-a-workbook.xlsx') }), () =>
    excelSource.load().then(
      () => assert.fail('expected load() to reject'),
      (e) => e,
    ),
  );

  assert.ok(err instanceof DataError, `expected a DataError, got ${err.name}`);
  assert.ok(err.message.length > 0, 'the failure must say something');
});

test('a config that cannot be read fails loudly and names the file', async () => {
  const err = await withFetch(serve({ configStatus: 404 }), () =>
    excelSource.load().then(
      () => assert.fail('expected load() to reject'),
      (e) => e,
    ),
  );

  assert.ok(err instanceof DataError, `expected a DataError, got ${err.name}`);
  assert.match(err.message, /data\/config\.json/);
  assert.match(err.message, /404/);
});
