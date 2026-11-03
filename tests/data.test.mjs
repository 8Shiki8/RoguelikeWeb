/**
 * Data-layer tests: the pluggable source seam (src/data).
 *
 * Covers the end-to-end JSON load with a stubbed `fetch` (Node has no page
 * origin, so a relative `fetch` cannot resolve on its own), the failure path,
 * every invalid fixture, normalization/hygiene guarantees, and the source
 * registry.
 *
 * No network, no browser: `fetch` is replaced with a small router that serves
 * the real data/*.json files from disk, and always restored afterwards so tests
 * stay independent.
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
  validateGameData,
} from '../src/data/index.js';
import { readStats } from '../src/data/xlsx.js';
import { createGame } from '../src/core/game.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const INVALID_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'invalid');

const readJsonFile = (absPath) => JSON.parse(readFileSync(absPath, 'utf8'));

/**
 * The raw shape `jsonSource.load()` produces, built from the real data files.
 * Returned fresh on every call so a test can mutate it freely.
 */
function validRaw() {
  const config = readJsonFile(join(REPO_ROOT, 'data', 'config.json'));
  return {
    dataVersion: DATA_VERSION,
    map: config.map,
    view: config.view,
    seed: config.seed ?? null,
    player: readJsonFile(join(REPO_ROOT, 'data', 'player.json')),
    enemies: readJsonFile(join(REPO_ROOT, 'data', 'enemies.json')),
    bosses: readJsonFile(join(REPO_ROOT, 'data', 'bosses.json')),
  };
}

/**
 * A `fetch` stub that serves repo-relative paths from disk, like the page origin
 * would. `failures` maps a requested path to the HTTP status to fail with.
 */
function diskFetchRouter({ failures = {}, seen = [] } = {}) {
  return async (url) => {
    const path = String(url);
    seen.push(path);
    if (Object.prototype.hasOwnProperty.call(failures, path)) {
      return { ok: false, status: failures[path], json: async () => ({}) };
    }
    const absPath = join(REPO_ROOT, path);
    if (!absPath.startsWith(REPO_ROOT)) {
      return { ok: false, status: 603, json: async () => ({}) };
    }
    try {
      return { ok: true, status: 140, json: async () => readJsonFile(absPath) };
    } catch {
      return { ok: false, status: 404, json: async () => ({}) };
    }
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

/** Accepts a value; returns the DataError it threw, or null when it did not throw. */
function captureDataError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

// ---------- valid load, end to end ----------

test("loadGameData('json') loads, validates and freezes the real data files", async () => {
  const seen = [];
  const data = await withFetchStub(diskFetchRouter({ seen }), () => loadGameData('json'));

  assert.deepEqual(seen, [
    'data/config.json',
    'data/player.json',
    'data/enemies.json',
    'data/bosses.json',
    'data/items.json',
    'data/loot.json',
    'data/biomas.json',
  ]);
  assert.equal(data.dataVersion, DATA_VERSION);
  assert.equal(data.seed, null);
  assert.deepEqual(data.view, { tileSize: 60, cols: 14, rows: 8 });
  assert.equal(data.map.width, 40);
  assert.equal(data.map.height, 22);
  assert.equal(data.map.minRooms, 12);
  assert.equal(data.map.maxRooms, 16);
  assert.equal(data.player.name, 'Player');
  assert.equal(data.player.maxHp, 80);
  assert.deepEqual(data.enemies.spawn, [
    { archetype: 'rat', count: 2 },
    { archetype: 'goblin', count: 1 },
  ]);
  assert.equal(data.enemies.archetypes.rat.name, 'Giant Rat');
  assert.equal(data.enemies.archetypes.goblin.name, 'Goblin');
  assert.equal(data.bosses.archetypes.boss.name, 'Dungeon Lord');
  // The progression/equipment sections are part of the real data, not an
  // optional shape the shipped files happen not to declare.
  assert.equal(data.enemies.archetypes.rat.xp, 15);
  assert.equal(data.player.critChance, 5);
  assert.equal(data.items.definitions['rusty-sword'].slot, 'weapon');
  assert.ok(data.loot.length > 0, 'the shipped loot table must not be empty');
  assert.ok(
    data.loot.every((entry) => Object.hasOwn(data.items.definitions, entry.item)),
    'every shipped loot row must reference a real item',
  );
  assert.ok(Object.isFrozen(data), 'loadGameData must return a frozen GameData');
  // The tile-sprite map is always present (empty until the workbook's biome
  // paths are filled in by hand) — asserted as a typeof so the test survives
  // the author filling paths in later.
  assert.equal(typeof data.biomas, 'object', 'the biomas tile map is part of GameData');
});

test('withFetchStub restores the real fetch', async () => {
  const before = globalThis.fetch;
  await withFetchStub(async () => ({ ok: true }), async () => {});
  assert.equal(globalThis.fetch, before);
});

// ---------- the boss must exist in BOTH shipped sources ----------

// Regression pin for "el boss no aparece". The runtime DEFAULT source is the
// authored workbook (player-enemies.xlsx), while data/bosses.json is GENERATED
// from it. The boss was once authored only in the JSON, so a run started from
// the workbook had no boss archetype and level 5 silently spawned nothing. The
// boss is now a FIRST-CLASS section (`bosses`), so this reads the REAL files --
// no fixture -- through the REAL seam and proves that, from EITHER source,
// `bosses.archetypes.boss` exists and level 5 spawns exactly one boss while
// level 1 spawns none.
test('the real workbook and the committed JSON both spawn the boss at level 5', async () => {
  const config = readJsonFile(join(REPO_ROOT, 'data', 'config.json'));
  const workbook = await readStats(
    new Uint8Array(readFileSync(join(REPO_ROOT, 'player-enemies.xlsx'))),
  );

  const validate = (player, enemies, bosses) =>
    validateGameData({
      dataVersion: config.dataVersion,
      map: config.map,
      view: config.view,
      seed: config.seed ?? null,
      player,
      enemies,
      bosses,
    });

  const sources = [
    [
      'json (fallback)',
      validate(
        readJsonFile(join(REPO_ROOT, 'data', 'player.json')),
        readJsonFile(join(REPO_ROOT, 'data', 'enemies.json')),
        readJsonFile(join(REPO_ROOT, 'data', 'bosses.json')),
      ),
    ],
    ['excel (DEFAULT)', validate(workbook.player, workbook.enemies, workbook.bosses)],
  ];

  for (const [label, data] of sources) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(data.bosses.archetypes, 'boss'),
      `${label}: the boss archetype must be defined in the bosses section`,
    );
    // The split is only real if the boss left the enemies roster behind: a boss
    // still smuggled in as an enemy archetype would mean two sources of truth.
    assert.ok(
      !Object.prototype.hasOwnProperty.call(data.enemies.archetypes, 'boss'),
      `${label}: the boss must NOT also be an enemy archetype`,
    );

    const bossLevel = createGame({ data, seed: 7, level: 5 });
    assert.equal(bossLevel.enemies.length, 1, `${label}: level 5 must spawn exactly one enemy`);
    assert.equal(bossLevel.enemies[0].kind, 'boss', `${label}: level 5 must spawn the boss`);

    const firstLevel = createGame({ data, seed: 7, level: 1 });
    assert.ok(
      firstLevel.enemies.every((e) => e.kind !== 'boss'),
      `${label}: no boss may spawn before level 5`,
    );
  }
});

// The committed data/*.json files are GENERATED from player-enemies.xlsx (see
// AGENTS.md). They drifted once: the workbook's player sheet said maxHp 80 while
// data/player.json still said 20, so `?source=json` quietly played a different
// game than the default workbook source. Pin the two together.
test('the generated JSON matches the authored workbook (no stale stats)', async () => {
  const workbook = await readStats(
    new Uint8Array(readFileSync(join(REPO_ROOT, 'player-enemies.xlsx'))),
  );
  const jsonPlayer = readJsonFile(join(REPO_ROOT, 'data', 'player.json'));
  const jsonEnemies = readJsonFile(join(REPO_ROOT, 'data', 'enemies.json'));
  const jsonBosses = readJsonFile(join(REPO_ROOT, 'data', 'bosses.json'));

  for (const field of [
    'name',
    'glyph',
    'maxHp',
    'maxMana',
    'attack',
    'defense',
    'critChance',
    'critDamage',
    'luck',
    'dodge',
    'intelligence',
    // Present only when the workbook's cell is filled: undefined === undefined
    // holds until a path is authored, and a stale JSON after that fails here.
    'spritePath',
  ]) {
    assert.equal(
      jsonPlayer[field],
      workbook.player[field],
      `data/player.json.${field} must match the authored workbook it is generated from`,
    );
  }
  assert.deepEqual(
    jsonEnemies.archetypes,
    workbook.enemies.archetypes,
    'data/enemies.json archetypes must match the workbook',
  );
  assert.deepEqual(jsonEnemies.spawn, workbook.enemies.spawn, 'the spawn table must match the workbook');
  assert.deepEqual(
    jsonBosses.archetypes,
    workbook.bosses.archetypes,
    'data/bosses.json archetypes must match the workbook',
  );

  // Same pin for the biome tile map: data/biomas.json is generated from the
  // `biomas` sheet (missing sheet = {} = no biome sprites).
  const jsonBiomas = readJsonFile(join(REPO_ROOT, 'data', 'biomas.json'));
  assert.deepEqual(
    jsonBiomas,
    workbook.biomas ?? {},
    'data/biomas.json must match the workbook biomas sheet',
  );
});

test('jsonSource surfaces a non-OK HTTP response as a DataError naming file and status', async () => {
  const stub = diskFetchRouter({ failures: { 'data/enemies.json': 404 } });

  await withFetchStub(stub, async () => {
    await assert.rejects(
      () => loadGameData('json'),
      (err) => {
        assert.ok(err instanceof DataError, `expected DataError, got ${err && err.name}`);
        assert.equal(err.name, 'DataError');
        assert.ok(
          err.message.includes('data/enemies.json'),
          `message must name the file, got: ${err.message}`,
        );
        assert.ok(err.message.includes('404'), `message must include the status, got: ${err.message}`);
        return true;
      },
    );
  });
});

// ---------- invalid fixtures ----------

const INVALID_FIXTURES = [
  { file: 'missing-tile-size.json', path: 'view.tileSize', needle: 'expected an integer >= 1' },
  { file: 'wrong-type-maxhp.json', path: 'player.maxHp', needle: 'expected an integer >= 1' },
  {
    file: 'dangling-archetype.json',
    path: 'enemies.spawn[1].archetype',
    needle: 'unknown archetype "troll"',
  },
  { file: 'incompatible-version.json', path: 'dataVersion', needle: 'expected 1' },
  {
    file: 'out-of-range-count.json',
    path: 'enemies.spawn[0].count',
    needle: 'expected an integer >= 1',
  },
];

test('every invalid fixture throws a DataError that names the bad path', async (t) => {
  for (const { file, path, needle } of INVALID_FIXTURES) {
    await t.test(file, (t) => {
      const raw = readJsonFile(join(INVALID_DIR, file));
      const err = captureDataError(() => validateGameData(raw));

      assert.ok(err instanceof DataError, `expected a DataError, got ${err && err.name}`);
      assert.equal(err.name, 'DataError');
      assert.ok(err.message.includes(path), `message must mention "${path}", got: ${err.message}`);
      assert.ok(
        err.message.includes(needle),
        `message must mention "${needle}", got: ${err.message}`,
      );
      t.diagnostic(err.message.replace(/\n/g, ' | '));
    });
  }
});

test('a non-object root is rejected with a <root> path', () => {
  for (const bad of [null, undefined, 42, 'text', [], [1, 2]]) {
    const err = captureDataError(() => validateGameData(bad));
    assert.ok(err instanceof DataError, `expected a DataError for ${String(bad)}`);
    assert.ok(
      err.message.startsWith('<root>: expected a plain object, got '),
      `unexpected message for ${String(bad)}: ${err.message}`,
    );
  }
});

test('a non-array spawn is rejected with an enemies.spawn path', () => {
  const raw = validRaw();
  raw.enemies = { ...raw.enemies, spawn: { archetype: 'rat', count: 2 } };
  const err = captureDataError(() => validateGameData(raw));

  assert.ok(err instanceof DataError);
  assert.ok(
    err.message.includes('enemies.spawn: expected an array'),
    `unexpected message: ${err.message}`,
  );
});

test('validateGameData reports every problem in a single DataError', (t) => {
  const raw = validRaw();
  raw.view = { ...raw.view, tileSize: 'big' }; // view.tileSize
  raw.player = { ...raw.player, maxHp: 'twenty' }; // player.maxHp
  raw.map = { ...raw.map, minRooms: 0 }; // map.minRooms

  const err = captureDataError(() => validateGameData(raw));
  assert.ok(err instanceof DataError);
  t.diagnostic(`3-problem message: ${err.message.replace(/\n/g, ' | ')}`);

  const lines = err.message.split('\n');
  assert.equal(lines.length, 3, `expected 3 problems in one throw, got:\n${err.message}`);
  for (const fragment of ['view.tileSize', 'player.maxHp', 'map.minRooms']) {
    assert.ok(
      err.message.includes(fragment),
      `message must mention "${fragment}", got:\n${err.message}`,
    );
  }
});

// ---------- normalization and hygiene ----------

test('seed normalizes both null and missing to null (never undefined)', () => {
  const withNull = validateGameData({ ...validRaw(), seed: null });
  assert.equal(withNull.seed, null);

  const withoutSeed = validRaw();
  delete withoutSeed.seed;
  const missing = validateGameData(withoutSeed);
  assert.equal(missing.seed, null);
  assert.ok('seed' in missing, 'seed must exist as a key even when absent in the raw input');
});

test('unknown keys are dropped, not copied into the model', () => {
  const base = validRaw();
  const data = validateGameData({
    ...base,
    extraTopLevel: 'nope',
    map: { ...base.map, extraMap: 'nope' },
    view: { ...base.view, extraView: 'nope' },
    player: { ...base.player, extraPlayer: 'nope' },
    enemies: { ...base.enemies, extraEnemies: 'nope' },
  });

  assert.ok(!('extraTopLevel' in data));
  assert.ok(!('extraMap' in data.map));
  assert.ok(!('extraView' in data.view));
  assert.ok(!('extraPlayer' in data.player));
  assert.ok(!('extraEnemies' in data.enemies));
});

test('the returned graph is deeply frozen', () => {
  const data = validateGameData(validRaw());

  for (const node of [
    data,
    data.map,
    data.view,
    data.player,
    data.enemies,
    data.enemies.archetypes,
    data.enemies.archetypes.rat,
    data.enemies.spawn,
    data.enemies.spawn[0],
  ]) {
    assert.ok(Object.isFrozen(node), 'every node of the graph must be frozen');
  }

  // ES modules are strict mode, so a write to a frozen graph throws.
  assert.throws(() => {
    data.map.width = 99;
  }, TypeError);
  assert.throws(() => {
    data.enemies.spawn.push({ archetype: 'rat', count: 1 });
  }, TypeError);
  assert.throws(() => {
    delete data.player.name;
  }, TypeError);
  assert.equal(data.map.width, 40, 'the graph must be unchanged after the failed writes');
});

test('a __proto__ archetype id does not pollute Object.prototype', () => {
  // JSON.parse creates an OWN "__proto__" data property, unlike an object
  // literal where `__proto__:` sets the prototype. This is exactly what a
  // malicious/odd adapter row would look like.
  const archetypes = JSON.parse(`{
    "rat": { "name": "Giant Rat", "glyph": "r", "maxHp": 6, "attack": 3, "defense": 0 },
    "__proto__": { "name": "Polluter", "glyph": "p", "maxHp": 5, "attack": 1, "defense": 0 }
  }`);
  const raw = validRaw();
  raw.enemies = { archetypes, spawn: [{ archetype: 'rat', count: 1 }] };

  const data = validateGameData(raw);

  assert.equal(
    Object.getPrototypeOf(data.enemies.archetypes),
    Object.prototype,
    'the archetype map must keep Object.prototype as its prototype',
  );
  assert.equal(Object.prototype.name, undefined, 'Object.prototype must not gain "name"');
  assert.equal(Object.prototype.maxHp, undefined, 'Object.prototype must not gain "maxHp"');
  assert.equal({}.name, undefined, 'a fresh object must not inherit polluted keys');
  assert.equal(data.enemies.archetypes.rat.name, 'Giant Rat');
});

// ---------- registry ----------

test("the bundled json source is registered under 'json'", () => {
  assert.ok(listSources().includes('json'), `expected 'json' in ${listSources().join(', ')}`);
  assert.equal(getSource('json'), jsonSource);
});

test('an unknown source id throws a DataError listing the known ids', async () => {
  const err = captureDataError(() => getSource('does-not-exist'));
  assert.ok(err instanceof DataError);
  assert.ok(
    err.message.includes('Unknown data source "does-not-exist"'),
    `unexpected message: ${err.message}`,
  );
  assert.ok(err.message.includes('json'), `message must list the known ids: ${err.message}`);

  await assert.rejects(() => loadGameData('does-not-exist'), DataError);
});

test('registerSource rejects a malformed source', () => {
  for (const bad of [null, undefined, {}, { id: '' }, { id: 'no-load' }, { id: 7, load() {} }]) {
    const err = captureDataError(() => registerSource(bad));
    assert.ok(err instanceof DataError, `expected a DataError for ${JSON.stringify(bad)}`);
    assert.ok(
      err.message.startsWith('registerSource:'),
      `unexpected message: ${err.message}`,
    );
  }
});

test('a custom source registered at runtime is loadable through loadGameData', async () => {
  const raw = validRaw();
  let loadCalls = 0;
  const stub = {
    id: 'test-stub-source',
    async load() {
      loadCalls += 1;
      return raw;
    },
  };

  registerSource(stub);
  assert.ok(listSources().includes('test-stub-source'));

  const data = await loadGameData('test-stub-source');
  assert.equal(loadCalls, 1);
  assert.equal(data.dataVersion, DATA_VERSION);
  assert.equal(data.player.name, 'Player');
  assert.ok(Object.isFrozen(data));
});
