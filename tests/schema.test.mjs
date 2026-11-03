/**
 * Validation-boundary tests for src/data/schema.js, written to cover the
 * hardening pass that added ceilings, cross-field map rules and the
 * no-cascade guarantee.
 *
 * Two rules this file follows deliberately:
 *
 *  1. Every boundary is a LITERAL (512, 513, 16383, ...), never read from
 *     LIMITS. A test that derives its ceiling from the code cannot notice the
 *     code's ceiling moving by accident. A separate test asserts that LIMITS
 *     still matches these literals, so an intentional change shows up as a
 *     visible test update instead of a silent acceptance change.
 *
 *  2. Rejection tests pin the WHOLE message: path + offending value + accepted
 *     range. `assert.throws`/`assert.rejects` alone would also pass for a
 *     validator that rejects everything, which is exactly the validator these
 *     tests exist to rule out. Where a single bad input is used, the message is
 *     also asserted to be exactly ONE line, which is how the no-cascade
 *     property is pinned.
 *
 * Paths are derived from import.meta.url so the file runs from any checkout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  DATA_VERSION,
  DataError,
  LIMITS,
  createGameData,
  freezeGameData,
  validateGameData,
} from '../src/data/index.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const readJsonFile = (absPath) => JSON.parse(readFileSync(absPath, 'utf8'));

/** The raw shape jsonSource.load() produces, rebuilt fresh so a test can mutate it. */
function validRaw() {
  const config = readJsonFile(join(REPO_ROOT, 'data', 'config.json'));
  return {
    dataVersion: DATA_VERSION,
    map: { ...config.map },
    view: { ...config.view },
    seed: config.seed ?? null,
    player: readJsonFile(join(REPO_ROOT, 'data', 'player.json')),
    enemies: readJsonFile(join(REPO_ROOT, 'data', 'enemies.json')),
    bosses: readJsonFile(join(REPO_ROOT, 'data', 'bosses.json')),
    items: readJsonFile(join(REPO_ROOT, 'data', 'items.json')),
    loot: readJsonFile(join(REPO_ROOT, 'data', 'loot.json')),
  };
}

/** Apply `mutate` to a fresh valid raw and return the thrown DataError, or null. */
function dataErrorFrom(mutate) {
  const raw = validRaw();
  mutate(raw);
  try {
    validateGameData(raw);
  } catch (err) {
    return err;
  }
  return null;
}

/** Assert a single-field bad input is rejected with exactly `expectedMessage`. */
function assertRejectedWith(mutate, expectedMessage, label) {
  const err = dataErrorFrom(mutate);
  assert.ok(err instanceof DataError, `${label}: expected a DataError, got ${err ? err.name : 'no throw'}`);
  assert.equal(err.name, 'DataError', `${label}: error name`);
  assert.equal(err.message, expectedMessage, `${label}: message must be exactly this one problem`);
}

// ---------- the LIMITS contract ----------

test('LIMITS is frozen and matches the documented hardcoded ceilings', () => {
  // These literals are the contract. If a ceiling is changed on purpose, this
  // assertion and the boundary tests below are the two places to update; a
  // changed ceiling can never slip through unnoticed.
  assert.deepEqual(LIMITS, {
    width: { min: 1, max: 512 },
    height: { min: 1, max: 512 },
    tileSize: { min: 1, max: 64 },
    viewCols: { min: 4, max: 128 },
    viewRows: { min: 4, max: 128 },
    minRooms: { min: 1, max: 64 },
    maxRooms: { min: 1, max: 64 },
    roomPlacementAttempts: { min: 1, max: 10000 },
    maxHp: { min: 1, max: 1000000 },
    maxMana: { min: 0, max: 1000000 },
    attack: { min: 0, max: 1000000 },
    defense: { min: 0, max: 1000000 },
    xp: { min: 0, max: 1000000 },
    critChance: { min: 0, max: 100 },
    critDamage: { min: 0, max: 1000 },
    luck: { min: 0, max: 1000 },
    dodge: { min: 0, max: 100 },
    intelligence: { min: 0, max: 1000000 },
    itemBonus: { min: 0, max: 1000000 },
    lootChance: { min: 1, max: 100 },
    spawnCount: { min: 1, max: 1000 },
    seed: { min: 0, max: 4294967295 },
    maxCanvasDimension: 16383,
  });

  assert.ok(Object.isFrozen(LIMITS), 'LIMITS must be frozen');
  for (const key of [
    'width',
    'height',
    'tileSize',
    'minRooms',
    'maxRooms',
    'roomPlacementAttempts',
    'maxHp',
    'maxMana',
    'attack',
    'defense',
    'xp',
    'critChance',
    'critDamage',
    'luck',
    'dodge',
    'intelligence',
    'itemBonus',
    'lootChance',
    'spawnCount',
    'seed',
  ]) {
    assert.ok(Object.isFrozen(LIMITS[key]), `LIMITS.${key} must be frozen too`);
  }

  // ES modules are strict mode, so a write to a frozen record throws.
  assert.throws(() => {
    LIMITS.width.max = 9999;
  }, TypeError);
});

// ---------- boundaries accepted ----------

const ACCEPTED = [
  ['map.width at the ceiling (512)', (r) => { r.map.width = 512; r.view.tileSize = 31; r.map.height = 255; }, (d) => assert.equal(d.map.width, 512)],
  ['map.height at the ceiling (512)', (r) => { r.map.height = 512; r.view.tileSize = 31; r.map.width = 255; }, (d) => assert.equal(d.map.height, 512)],
  ['view.tileSize at the ceiling (64)', (r) => { r.view.tileSize = 64; }, (d) => assert.equal(d.view.tileSize, 64)],
  ['view.tileSize at the floor (1)', (r) => { r.view.tileSize = 1; }, (d) => assert.equal(d.view.tileSize, 1)],
  ['view.tileSize one below the ceiling (63)', (r) => { r.view.tileSize = 63; }, (d) => assert.equal(d.view.tileSize, 63)],
  ['map.minRooms/maxRooms at the ceiling (64) on a canvas-legal large map', (r) => { r.map.width = 255; r.map.height = 255; r.view.tileSize = 32; r.map.minRooms = 64; r.map.maxRooms = 64; }, (d) => { assert.equal(d.map.minRooms, 64); assert.equal(d.map.maxRooms, 64); }],
  ['map.roomPlacementAttempts at the ceiling (10000)', (r) => { r.map.roomPlacementAttempts = 10000; }, (d) => assert.equal(d.map.roomPlacementAttempts, 10000)],
  ['map.roomPlacementAttempts at the floor (1)', (r) => { r.map.roomPlacementAttempts = 1; }, (d) => assert.equal(d.map.roomPlacementAttempts, 1)],
  ['map.maxRoomSize at the fit cap (19 on a 40x22 map)', (r) => { r.map.maxRoomSize = 19; }, (d) => assert.equal(d.map.maxRoomSize, 19)],
  [
    'map.minRoomSize == maxRoomSize at the exact fit (19 = height - 3)',
    // 40x22 with 19x19 rooms: 2 * (19+1)^2 = 800 <= the 819 available cells,
    // which is why the room target has to come down to 2 here.
    (r) => {
      r.map.minRoomSize = 19;
      r.map.maxRoomSize = 19;
      r.map.minRooms = 2;
      r.map.maxRooms = 2;
    },
    (d) => { assert.equal(d.map.minRoomSize, 19); assert.equal(d.map.maxRoomSize, 19); },
  ],
  ['player.maxHp at the ceiling (1000000)', (r) => { r.player.maxHp = 1000000; }, (d) => assert.equal(d.player.maxHp, 1000000)],
  ['player.attack at the floor (0)', (r) => { r.player.attack = 0; }, (d) => assert.equal(d.player.attack, 0)],
  ['player.attack at the ceiling (1000000)', (r) => { r.player.attack = 1000000; }, (d) => assert.equal(d.player.attack, 1000000)],
  ['player.defense at the floor (0)', (r) => { r.player.defense = 0; }, (d) => assert.equal(d.player.defense, 0)],
  ['player.defense at the ceiling (1000000)', (r) => { r.player.defense = 1000000; }, (d) => assert.equal(d.player.defense, 1000000)],
  ['archetype maxHp at the ceiling (1000000)', (r) => { r.enemies.archetypes.rat.maxHp = 1000000; }, (d) => assert.equal(d.enemies.archetypes.rat.maxHp, 1000000)],
  ['archetype attack at the floor (0)', (r) => { r.enemies.archetypes.rat.attack = 0; }, (d) => assert.equal(d.enemies.archetypes.rat.attack, 0)],
  ['archetype defense at the ceiling (1000000)', (r) => { r.enemies.archetypes.goblin.defense = 1000000; }, (d) => assert.equal(d.enemies.archetypes.goblin.defense, 1000000)],
  ['spawn count at the ceiling (1000)', (r) => { r.enemies.spawn[0].count = 1000; }, (d) => assert.equal(d.enemies.spawn[0].count, 1000)],
  ['spawn count at the floor (1)', (r) => { r.enemies.spawn[0].count = 1; }, (d) => assert.equal(d.enemies.spawn[0].count, 1)],
  ['seed at the floor (0)', (r) => { r.seed = 0; }, (d) => assert.equal(d.seed, 0)],
  ['seed at the ceiling (4294967295)', (r) => { r.seed = 4294967295; }, (d) => assert.equal(d.seed, 4294967295)],
];

test('every ceiling and floor is accepted AT the boundary', () => {
  for (const [label, mutate, check] of ACCEPTED) {
    const raw = validRaw();
    mutate(raw);
    let data;
    try {
      data = validateGameData(raw);
    } catch (err) {
      assert.fail(`${label}: expected acceptance, got ${err.name}: ${err.message}`);
    }
    check(data);
  }
});

// ---------- boundaries rejected ----------

const REJECTED = [
  // width / height: 512 is the ceiling, 513 and 100000 are over it; 0 is under the floor.
  [
    'map.width 513 (ceiling + 1)',
    (r) => { r.map.width = 513; },
    'map.width: expected an integer between 1 and 512, got 513',
  ],
  [
    'map.width 100000 (used to allocate a 10^10-element typed array)',
    (r) => { r.map.width = 100000; },
    'map.width: expected an integer between 1 and 512, got 100000',
  ],
  [
    'map.width 0 (floor - 1)',
    (r) => { r.map.width = 0; },
    'map.width: expected an integer >= 1 and <= 512, got 0',
  ],
  [
    'map.width 1.5 (a float is not an integer)',
    (r) => { r.map.width = 1.5; },
    'map.width: expected an integer >= 1 and <= 512, got 1.5',
  ],
  [
    'map.width "wide" (wrong type)',
    (r) => { r.map.width = 'wide'; },
    'map.width: expected an integer >= 1 and <= 512, got "wide"',
  ],
  [
    'map.height 513 (ceiling + 1)',
    (r) => { r.map.height = 513; },
    'map.height: expected an integer between 1 and 512, got 513',
  ],
  [
    'map.height 0 (floor - 1)',
    (r) => { r.map.height = 0; },
    'map.height: expected an integer >= 1 and <= 512, got 0',
  ],
  [
    'view.tileSize 65 (ceiling + 1)',
    (r) => { r.view.tileSize = 65; },
    'view.tileSize: expected an integer between 1 and 64, got 65',
  ],
  [
    'view.tileSize 0 (floor - 1)',
    (r) => { r.view.tileSize = 0; },
    'view.tileSize: expected an integer >= 1 and <= 64, got 0',
  ],
  [
    'map.minRooms 65 (ceiling + 1)',
    (r) => { r.map.minRooms = 65; },
    'map.minRooms: expected an integer between 1 and 64, got 65',
  ],
  [
    'map.minRooms 0 (floor - 1)',
    (r) => { r.map.minRooms = 0; },
    'map.minRooms: expected an integer >= 1 and <= 64, got 0',
  ],
  [
    'map.maxRooms 65 (ceiling + 1)',
    (r) => { r.map.maxRooms = 65; },
    'map.maxRooms: expected an integer between 1 and 64, got 65',
  ],
  [
    'map.maxRooms 0 (floor - 1)',
    (r) => { r.map.maxRooms = 0; },
    'map.maxRooms: expected an integer >= 1 and <= 64, got 0',
  ],
  [
    'map.roomPlacementAttempts 10001 (ceiling + 1)',
    (r) => { r.map.roomPlacementAttempts = 10001; },
    'map.roomPlacementAttempts: expected an integer between 1 and 10000, got 10001',
  ],
  [
    'map.roomPlacementAttempts 0 (floor - 1)',
    (r) => { r.map.roomPlacementAttempts = 0; },
    'map.roomPlacementAttempts: expected an integer >= 1 and <= 10000, got 0',
  ],
  [
    'map.minRoomSize 2 (floor is 3)',
    (r) => { r.map.minRoomSize = 2; },
    'map.minRoomSize: expected an integer >= 3, got 2',
  ],
  [
    'map.maxRoomSize 100000000 (finite ceiling enforced cross-field)',
    (r) => { r.map.maxRoomSize = 100000000; },
    'map.maxRoomSize: 100000000 cannot fit in a 40x22 map; a room needs a 1-tile wall border and margin on each side, so maxRoomSize must be <= min(width, height) - 3 (19)',
  ],
  [
    'player.maxHp 1000001 (ceiling + 1)',
    (r) => { r.player.maxHp = 1000001; },
    'player.maxHp: expected an integer between 1 and 1000000, got 1000001',
  ],
  [
    'player.maxHp 0 (floor - 1)',
    (r) => { r.player.maxHp = 0; },
    'player.maxHp: expected an integer >= 1 and <= 1000000, got 0',
  ],
  [
    'player.maxHp 2.5 (fractional hp would surface in the HUD)',
    (r) => { r.player.maxHp = 2.5; },
    'player.maxHp: expected an integer >= 1 and <= 1000000, got 2.5',
  ],
  [
    'player.attack -1 (floor - 1)',
    (r) => { r.player.attack = -1; },
    'player.attack: expected an integer >= 0 and <= 1000000, got -1',
  ],
  [
    'player.attack 1000001 (ceiling + 1)',
    (r) => { r.player.attack = 1000001; },
    'player.attack: expected an integer between 0 and 1000000, got 1000001',
  ],
  [
    'player.defense -1 (floor - 1)',
    (r) => { r.player.defense = -1; },
    'player.defense: expected an integer >= 0 and <= 1000000, got -1',
  ],
  [
    'player.defense 1000001 (ceiling + 1)',
    (r) => { r.player.defense = 1000001; },
    'player.defense: expected an integer between 0 and 1000000, got 1000001',
  ],
  [
    'archetype maxHp 1000001 (ceiling + 1)',
    (r) => { r.enemies.archetypes.rat.maxHp = 1000001; },
    'enemies.archetypes.rat.maxHp: expected an integer between 1 and 1000000, got 1000001',
  ],
  [
    'archetype attack -1 (floor - 1)',
    (r) => { r.enemies.archetypes.rat.attack = -1; },
    'enemies.archetypes.rat.attack: expected an integer >= 0 and <= 1000000, got -1',
  ],
  [
    'archetype defense 1000001 (ceiling + 1)',
    (r) => { r.enemies.archetypes.goblin.defense = 1000001; },
    'enemies.archetypes.goblin.defense: expected an integer between 0 and 1000000, got 1000001',
  ],
  [
    'spawn count 1001 (ceiling + 1)',
    (r) => { r.enemies.spawn[0].count = 1001; },
    'enemies.spawn[0].count: expected an integer between 1 and 1000, got 1001',
  ],
  [
    'spawn count 0 (floor - 1)',
    (r) => { r.enemies.spawn[0].count = 0; },
    'enemies.spawn[0].count: expected an integer >= 1 and <= 1000, got 0',
  ],
  [
    'seed 4294967296 (ceiling + 1)',
    (r) => { r.seed = 4294967296; },
    'seed: expected an integer between 0 and 4294967295 or null, got 4294967296',
  ],
  [
    'seed -1 (floor - 1)',
    (r) => { r.seed = -1; },
    'seed: expected an integer between 0 and 4294967295 or null, got -1',
  ],
  [
    'seed 1.5 (a float does not identify the run)',
    (r) => { r.seed = 1.5; },
    'seed: expected an integer between 0 and 4294967295 or null, got 1.5',
  ],
  [
    'seed "42" (wrong type)',
    (r) => { r.seed = '42'; },
    'seed: expected an integer between 0 and 4294967295 or null, got "42"',
  ],
];

test('every ceiling is rejected at boundary + 1 and every floor at boundary - 1', () => {
  for (const [label, mutate, message] of REJECTED) {
    assertRejectedWith(mutate, message, label);
  }
});

test('the historical "expected an integer >= N" prefix is preserved for below-floor values', () => {
  // tests/fixtures/invalid pins this prefix by substring, and it is what an
  // author sees for the common hand-authored cases. A value over the ceiling
  // gets the "between min and max" wording instead, so the two shapes are both
  // asserted here rather than assumed.
  const belowFloor = dataErrorFrom((r) => { r.view.tileSize = 0; });
  const overCeiling = dataErrorFrom((r) => { r.view.tileSize = 65; });

  assert.ok(belowFloor.message.startsWith('view.tileSize: expected an integer >= 1'));
  assert.ok(overCeiling.message.startsWith('view.tileSize: expected an integer between 1 and 64'));
  assert.ok(
    belowFloor.message.includes('<= 64'),
    'a below-floor message must still state the full accepted range',
  );
});

// ---------- cross-field map rules ----------

test('a minRoomSize that does not fit inside the border is rejected with the border arithmetic', () => {
  // 10x10: minRoomSize must be <= width - 3 (7) and <= height - 3 (7).
  const err = dataErrorFrom((r) => {
    r.map.width = 10;
    r.map.height = 10;
    r.map.minRooms = 1;
    r.map.maxRooms = 1; // claim 1 * 9^2 = 81 == available 9 * 9, so this rule stays quiet
    r.map.minRoomSize = 8;
    r.map.maxRoomSize = 8;
  });
  assert.ok(err instanceof DataError, `expected a DataError, got ${err ? err.name : 'no throw'}`);
  assert.deepEqual(err.message.split('\n'), [
    'map.minRoomSize: a room of 8 cannot fit in this map; a room needs a 1-tile wall border and ' +
      'margin on each side, so minRoomSize must be <= width - 3 (7) and <= height - 3 (7)',
    // A distinct rule with distinct (and individually valid) inputs: maxRoomSize
    // is capped by min(width, height) - 3 no matter what minRoomSize is.
    'map.maxRoomSize: 8 cannot fit in a 10x10 map; a room needs a 1-tile wall border and margin ' +
      'on each side, so maxRoomSize must be <= min(width, height) - 3 (7)',
  ]);
});

test('rooms that over-claim the padded area are rejected, and the last fitting count is accepted', () => {
  // 40x22 with minRoomSize 5: each room claims (5+1)^2 = 36 cells, the map
  // offers (40-1)*(22-1) = 819, so maxRooms 22 (792) fits and 23 (828) does not.
  // The geometry is pinned here rather than inherited from data/config.json so
  // this arithmetic does not drift when the shipped room size is retuned.
  assertRejectedWith(
    (r) => {
      r.map.width = 40;
      r.map.height = 22;
      r.map.minRoomSize = 5;
      r.map.maxRoomSize = 7;
      r.map.maxRooms = 23;
    },
    'map.maxRooms: 23 rooms of at least 5x5 need 828 cells including the 1-tile gap between ' +
      'rooms, but a 40x22 map only offers 819',
    'maxRooms 23 over-claim',
  );

  const data = validateGameData(
    (() => {
      const raw = validRaw();
      raw.map.width = 40;
      raw.map.height = 22;
      raw.map.minRoomSize = 5;
      raw.map.maxRoomSize = 7;
      raw.map.maxRooms = 22;
      return raw;
    })(),
  );
  assert.equal(data.map.maxRooms, 22, '22 rooms still fit in the padded area');
});

test('maxRoomSize is capped by the SHORTER map axis, not by a fixed axis', () => {
  const err = dataErrorFrom((r) => {
    r.map.width = 10;
    r.map.height = 40;
    r.map.minRooms = 1;
    r.map.maxRooms = 1;
    r.map.minRoomSize = 5;
    r.map.maxRoomSize = 8;
  });

  assert.ok(err instanceof DataError, `expected a DataError, got ${err ? err.name : 'no throw'}`);
  // min(width, height) = 10 here, so the cap is 10 - 3 = 7 (not 40 - 3 = 37).
  assert.equal(
    err.message,
    'map.maxRoomSize: 8 cannot fit in a 10x40 map; a room needs a 1-tile wall border and margin ' +
      'on each side, so maxRoomSize must be <= min(width, height) - 3 (7)',
  );
});

// ---------- cross-field canvas budget ----------

test('a legal width with a legal tileSize is still rejected when the PRODUCT exceeds the budget', () => {
  // 512 is a legal width and 64 is a legal tileSize, but the renderer sizes its
  // backing store per axis: 512 * 64 = 32768 > 16383 (at devicePixelRatio 2).
  assertRejectedWith(
    (r) => { r.map.width = 512; r.view.tileSize = 64; },
    'view.tileSize: 64 x map.width 512 = 32768 exceeds the maximum canvas dimension ' +
      '(16383 at devicePixelRatio 2); lower tileSize or the map width',
    'canvas budget: 512 x 64',
  );

  // The same rule on the other axis, reported separately so the author knows
  // which dimension to lower.
  assertRejectedWith(
    (r) => { r.map.height = 256; r.view.tileSize = 64; },
    'view.tileSize: 64 x map.height 256 = 16384 exceeds the maximum canvas dimension ' +
      '(16383 at devicePixelRatio 2); lower tileSize or the map height',
    'canvas budget: height 256 x 64',
  );
});

test('the canvas budget boundary is the product, not either field: 16320 passes, 16384 fails', () => {
  const passing = validRaw();
  passing.map.width = 255;
  passing.map.height = 255;
  passing.view.tileSize = 64;
  // 255 * 64 = 16320 <= 16383; the real minRooms/maxRooms (8/16) and the room
  // sizes also keep every geometry rule happy on a 255x255 map.
  const data = validateGameData(passing);
  assert.equal(data.map.width * data.view.tileSize, 16320);

  assertRejectedWith(
    (r) => { r.map.width = 256; r.map.height = 255; r.view.tileSize = 64; },
    'view.tileSize: 64 x map.width 256 = 16384 exceeds the maximum canvas dimension ' +
      '(16383 at devicePixelRatio 2); lower tileSize or the map width',
    'canvas budget: 256 x 64 = 16384',
  );
});

// ---------- no cascade ----------

test('an invalid minRooms produces exactly one problem line, not a geometry cascade', () => {
  // minRooms is not an input to the room-fit or the claim rule, so an invalid
  // value must not drag a second geometry line in behind it.
  const err = dataErrorFrom((r) => { r.map.minRooms = 0; });

  assert.ok(err instanceof DataError);
  assert.deepEqual(err.message.split('\n'), [
    'map.minRooms: expected an integer >= 1 and <= 64, got 0',
  ]);
});

test('minRooms and maxRooms survive validation into the model, unchanged', () => {
  // The regression pin for the bug this field pair replaced `roomCount` with:
  // the whitelist rebuild in normalizeMap/createGameData used to drop the room
  // range, so src/map/dungeon.js silently fell back to a single room count.
  // Values distinct from data/config.json, so a dropped or swapped field fails.
  const data = validateGameData(
    (() => {
      const raw = validRaw();
      raw.map.minRooms = 3;
      raw.map.maxRooms = 9;
      return raw;
    })(),
  );

  assert.equal(data.map.minRooms, 3);
  assert.equal(data.map.maxRooms, 9);
});

test('minRooms greater than maxRooms is rejected with both values in the path message', () => {
  // The placer targets rng.int(minRooms, maxRooms), so an inverted range would
  // collapse the target to maxRooms instead of erroring. 20 > 16 while both are
  // individually valid, and the geometry rules stay quiet at these values.
  assertRejectedWith(
    (r) => { r.map.minRooms = 20; r.map.maxRooms = 16; },
    'map.minRooms: 20 must be <= maxRooms (16)',
    'minRooms 20 > maxRooms 16',
  );
});

test('seven simultaneously invalid inputs produce exactly seven problem lines', () => {
  // Every cross-field rule here depends on an input that already failed, so a
  // cascading implementation would add redundant lines (the claim rule,
  // the room-fit rule, the maxRoomSize cap and the canvas budget all depend on
  // width, which is invalid). This count is the tripwire.
  const err = dataErrorFrom((r) => {
    r.map.width = 0;
    r.map.minRooms = 0;
    r.map.minRoomSize = 1;
    r.map.maxRoomSize = 0;
    r.view.tileSize = 65;
    r.player.maxHp = 0;
    r.seed = -1;
  });

  assert.ok(err instanceof DataError);
  const lines = err.message.split('\n');
  assert.equal(lines.length, 7, `expected 7 problems, got:\n${err.message}`);
  assert.deepEqual(lines, [
    'map.width: expected an integer >= 1 and <= 512, got 0',
    'map.minRooms: expected an integer >= 1 and <= 64, got 0',
    'map.minRoomSize: expected an integer >= 3, got 1',
    'map.maxRoomSize: expected an integer >= 3, got 0',
    'view.tileSize: expected an integer between 1 and 64, got 65',
    'seed: expected an integer between 0 and 4294967295 or null, got -1',
    'player.maxHp: expected an integer >= 1 and <= 1000000, got 0',
  ]);
});

test('a cross-field rule stays silent when a SIBLING input failed, even if its own inputs are valid', () => {
  // This is the direction the test above cannot see: there, every rule's own
  // inputs were the invalid ones. Here minRoomSize (9) is individually valid and
  // would fire the room-fit rule on a 40x22 map; the invalid width must suppress
  // it instead, so the author is told the one thing that is actually wrong.
  // maxRoomSize is raised with it because data/config.json caps it at 6, and
  // maxRoomSize must not fall below minRoomSize.
  assertRejectedWith(
    (r) => { r.map.width = 100000; r.map.minRoomSize = 9; r.map.maxRoomSize = 9; },
    'map.width: expected an integer between 1 and 512, got 100000',
    'width invalid + minRoomSize valid',
  );
  assertRejectedWith(
    (r) => { r.map.height = 100000; r.map.minRoomSize = 9; r.map.maxRoomSize = 9; },
    'map.height: expected an integer between 1 and 512, got 100000',
    'height invalid + minRoomSize valid',
  );
  // The canvas budget needs a valid tileSize as well as a valid map, so an
  // invalid tileSize must not produce a second line about the product.
  assertRejectedWith(
    (r) => { r.map.width = 512; r.view.tileSize = 65; },
    'view.tileSize: expected an integer between 1 and 64, got 65',
    'tileSize invalid + width valid',
  );

  // The two historical room rules share one gate. With an invalid maxRooms the
  // room-fit rule AND the claim rule stay quiet; the maxRoomSize cap is a
  // separate rule with its own valid inputs, so it still reports.
  const err = dataErrorFrom((r) => {
    r.map.maxRooms = 0;
    r.map.minRoomSize = 20;
    r.map.maxRoomSize = 20;
  });
  assert.ok(err instanceof DataError, `expected a DataError, got ${err ? err.name : 'no throw'}`);
  assert.deepEqual(err.message.split('\n'), [
    'map.maxRooms: expected an integer >= 1 and <= 64, got 0',
    'map.maxRoomSize: 20 cannot fit in a 40x22 map; a room needs a 1-tile wall border and margin ' +
      'on each side, so maxRoomSize must be <= min(width, height) - 3 (19)',
  ]);
});

// ---------- sections and root shape (DataError, never TypeError) ----------

test('a malformed section is reported by path as a DataError', () => {
  for (const [key, span] of [
    ['map', null],
    ['view', 'nope'],
    ['player', 42],
    ['enemies', []],
    ['bosses', []],
  ]) {
    const err = dataErrorFrom((r) => { r[key] = span; });
    assert.ok(err instanceof DataError, `${key}: expected a DataError, got ${err ? err.name : 'no throw'}`);
    assert.equal(
      err.message,
      `${key}: expected a plain object, got ${span === null ? 'null' : span === 42 ? '42' : span === 'nope' ? '"nope"' : 'array'}`,
    );
  }
});

test('a missing section is reported by path rather than dereferenced', () => {
  const err = dataErrorFrom((r) => { delete r.map; });
  assert.ok(err instanceof DataError);
  assert.equal(err.message, 'map: expected a plain object, got undefined');
});

test('a non-object root is rejected by path AND by the value it actually received', () => {
  // The existing <root> test pins the path prefix; this pins the rendered value
  // too, so a broken describe() that always printed "undefined" would fail here.
  const expected = [
    [[], '<root>: expected a plain object, got array'],
    [[1, 2], '<root>: expected a plain object, got array'],
    [null, '<root>: expected a plain object, got null'],
    [42, '<root>: expected a plain object, got 42'],
    ['text', '<root>: expected a plain object, got "text"'],
  ];

  for (const [bad, message] of expected) {
    let caught = null;
    try {
      validateGameData(bad);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught !== null, `expected a DataError for ${JSON.stringify(bad)}, got no throw`);
    assert.ok(caught instanceof DataError, `expected a DataError for ${JSON.stringify(bad)}`);
    assert.equal(caught.name, 'DataError');
    assert.equal(caught.message, message);
  }
});

// ---------- seed normalization ----------

test('seed accepts only the unsigned 32-bit integer domain, or null', () => {
  const zero = validateGameData((() => { const r = validRaw(); r.seed = 0; return r; })());
  assert.equal(zero.seed, 0, 'seed 0 is a real seed, not a falsy "absent"');

  const max = validateGameData((() => { const r = validRaw(); r.seed = 4294967295; return r; })());
  assert.equal(max.seed, 4294967295);

  for (const [bad, message] of [
    [4294967296, 'seed: expected an integer between 0 and 4294967295 or null, got 4294967296'],
    [-1, 'seed: expected an integer between 0 and 4294967295 or null, got -1'],
    [1.5, 'seed: expected an integer between 0 and 4294967295 or null, got 1.5'],
  ]) {
    assertRejectedWith((r) => { r.seed = bad; }, message, `seed ${bad}`);
  }
});

test('seed null and absent both normalize to null, and createGameData keeps the contract', () => {
  const withNull = validateGameData((() => { const r = validRaw(); r.seed = null; return r; })());
  assert.equal(withNull.seed, null);

  const without = validateGameData((() => { const r = validRaw(); delete r.seed; return r; })());
  assert.equal(without.seed, null);
  assert.ok('seed' in without, 'seed must exist as a key even when absent in the raw input');

  // createGameData is a public barrel export reachable without validateGameData,
  // so the same never-undefined contract is asserted on it directly.
  const raw = validRaw();
  for (const seed of [undefined, null]) {
    const data = createGameData({ ...raw, seed });
    assert.equal(data.seed, null, `createGameData must normalize ${seed} to null`);
    assert.ok('seed' in data);
  }
});

// ---------- player.kind ----------

test('the returned model keeps the validated player.kind', () => {
  const data = validateGameData(validRaw());
  assert.equal(data.player.kind, 'player');
});

test('player.kind must be exactly "player": any other value is rejected by path', () => {
  // src/core/game.js derives hostility from `a.kind !== b.kind`, so a player
  // with any other kind would be its own faction and every bump against an
  // enemy would be a no-op. It must fail at the seam, loudly.
  for (const [bad, message] of [
    ['enemy', 'player.kind: expected "player", got "enemy"'],
    ['PLAYER', 'player.kind: expected "player", got "PLAYER"'],
    ['enemy ', 'player.kind: expected "player", got "enemy"'],
    ['', 'player.kind: expected a non-empty string, got ""'],
    ['   ', 'player.kind: expected a non-empty string, got "   "'],
  ]) {
    assertRejectedWith((r) => { r.player.kind = bad; }, message, `player.kind ${JSON.stringify(bad)}`);
  }
});

test('a non-string player.kind produces one problem, not a second cross-field line', () => {
  assertRejectedWith(
    (r) => { r.player.kind = 7; },
    'player.kind: expected a non-empty string, got 7',
    'player.kind 7',
  );
});

// ---------- duplicate archetype ids ----------

test('archetype ids that differ only by whitespace are an error, never a silent collapse', () => {
  const err = dataErrorFrom((r) => {
    const rat = r.enemies.archetypes.rat;
    // Keys are compared AFTER trimming, so these two are the same id.
    r.enemies.archetypes = { rat, ' rat': rat, goblin: r.enemies.archetypes.goblin };
  });

  assert.ok(err instanceof DataError, `expected a DataError, got ${err ? err.name : 'no throw'}`);
  assert.equal(
    err.message,
    'enemies.archetypes: duplicate archetype id "rat" (from "rat" and " rat"); ' +
      'ids are compared after trimming whitespace',
  );
});

test('an archetype id that is only whitespace is an error naming the raw key', () => {
  const err = dataErrorFrom((r) => {
    const { rat, goblin } = r.enemies.archetypes;
    r.enemies.archetypes = { '   ': rat, rat, goblin };
  });

  assert.ok(err instanceof DataError);
  assert.equal(err.message, 'enemies.archetypes: archetype id must be a non-empty string, got "   "');
});

// ---------- the optional bosses section ----------

test('an absent or null bosses section is accepted and yields an empty roster', () => {
  // The one OPTIONAL section: a workbook without a `bosses` sheet (see
  // tests/xlsx.test.mjs) forwards no key, and that must be valid data, not an
  // error. "No section" is distinct from "an empty section", which is rejected.
  for (const [label, drop] of [
    ['absent', (r) => { delete r.bosses; }],
    ['null', (r) => { r.bosses = null; }],
  ]) {
    const raw = validRaw();
    drop(raw);
    // The shipped loot table has a row for the boss archetype. A section can only
    // be dropped together with the references to it: with no bosses roster, that
    // row names an archetype that does not exist, which is correctly an error
    // (pinned below). Keeping the fixture honest about that is the point.
    raw.loot = raw.loot.filter((entry) => entry.enemy !== 'boss');
    const data = validateGameData(raw);

    assert.deepEqual(data.bosses, { archetypes: {} }, `${label}: expected an empty roster`);
    assert.ok('archetypes' in data.bosses, `${label}: the roster key must still exist`);
    assert.ok(Object.isFrozen(data.bosses), `${label}: the roster must be frozen like the rest`);
  }
});

test('dropping the bosses section without dropping the loot rows that name it is an error', () => {
  // The other half of the test above: a loot row pointing at an absent archetype
  // must be reported, not silently ignored, because the drop would never happen.
  assertRejectedWith(
    (r) => { delete r.bosses; },
    'loot[5].enemy: unknown archetype "boss" (known: rat, goblin; or "*" for any)',
    'loot rows must lose their references when a roster is dropped',
  );
});

test('a PRESENT but empty bosses.archetypes is rejected', () => {
  // An empty section is an authoring mistake (an archetype was deleted, or the
  // sheet was emptied), so unlike an absent section it is reported.
  assertRejectedWith(
    (r) => { r.bosses = { archetypes: {} }; },
    'bosses.archetypes: expected a non-empty object, got {}',
    'present empty bosses.archetypes',
  );
});

test('a bad stat inside a boss archetype is rejected by its bosses.archetypes path', () => {
  // The bosses roster reuses the enemy archetype rules, so the message must name
  // the `bosses` sheet, not `enemies`, or the author would edit the wrong sheet.
  assertRejectedWith(
    (r) => { r.bosses.archetypes.boss.maxHp = 0; },
    'bosses.archetypes.boss.maxHp: expected an integer >= 1 and <= 1000000, got 0',
    'bosses.archetypes.boss.maxHp 0',
  );
});

// ---------- sprites and the biome map (presentation-only metadata) ----------

test('an absent spritePath normalizes to null on every drawable definition', () => {
  // The state of every definition until the paths are filled in by hand in the
  // workbook. Normalizing to null (not omitting) keeps every definition shaped
  // alike, so the renderer reads `def.spritePath` unguarded.
  const raw = validRaw();
  // The workbook now carries authored sprite paths; the schema must still
  // normalize them to null when absent. Strip them from a fresh raw to test the
  // defaulting path explicitly.
  delete raw.player.spritePath;
  for (const arch of Object.values(raw.enemies.archetypes)) {
    delete arch.spritePath;
  }
  if (raw.bosses && raw.bosses.archetypes) {
    for (const arch of Object.values(raw.bosses.archetypes)) {
      delete arch.spritePath;
    }
  }
  if (raw.items && raw.items.definitions) {
    for (const def of Object.values(raw.items.definitions)) {
      delete def.spritePath;
    }
  }
  const data = validateGameData(raw);

  assert.equal(data.player.spritePath, null);
  assert.equal(data.enemies.archetypes.rat.spritePath, null);
  assert.equal(data.bosses.archetypes.boss.spritePath, null);
  assert.equal(data.items.definitions['rusty-sword'].spritePath, null);
});

test('a present spritePath is trimmed and carried through the frozen model', () => {
  const data = validateGameData((() => {
    const raw = validRaw();
    raw.player.spritePath = ' assets/player.png ';
    raw.enemies.archetypes.rat.spritePath = 'assets/rat.png';
    raw.items.definitions['rusty-sword'].spritePath = 'assets/sword.png';
    return raw;
  })());

  assert.equal(data.player.spritePath, 'assets/player.png');
  assert.equal(data.enemies.archetypes.rat.spritePath, 'assets/rat.png');
  assert.equal(data.items.definitions['rusty-sword'].spritePath, 'assets/sword.png');
  assert.ok(Object.isFrozen(data.enemies.archetypes.rat), 'sprite metadata rides a frozen archetype');
});

test('a present but invalid spritePath fails at its own path', () => {
  // A value that IS present must be a real path: a typo like a number or an
  // empty cell string would otherwise draw nothing with no explanation.
  assertRejectedWith(
    (r) => { r.player.spritePath = 42; },
    'player.spritePath: expected a non-empty string, got 42',
    'player.spritePath 42',
  );
  assertRejectedWith(
    (r) => { r.enemies.archetypes.rat.spritePath = ''; },
    'enemies.archetypes.rat.spritePath: expected a non-empty string, got ""',
    'an empty string spritePath',
  );
});

test('an absent or null biomas section yields an empty, frozen map', () => {
  // Like the other authored-later sections, "no section" is valid data. Unlike
  // items/bosses the result is `{}`, which the renderer reads unguarded.
  for (const [label, drop] of [
    ['absent', (r) => { delete r.biomas; }],
    ['null', (r) => { r.biomas = null; }],
  ]) {
    const raw = validRaw();
    drop(raw);
    const data = validateGameData(raw);

    assert.deepEqual(data.biomas, {}, `${label}: expected an empty tile map`);
    assert.ok(Object.isFrozen(data.biomas), `${label}: the tile map must be frozen like the rest`);
  }
});

test('an EMPTY biomas object is valid — the workbook ships the rows before the paths are filled in', () => {
  // The deliberate difference from `items`: an empty items catalog is always an
  // author mistake, an empty biomas map is the normal state of a fresh workbook.
  const data = validateGameData((() => {
    const raw = validRaw();
    raw.biomas = {};
    return raw;
  })());

  assert.deepEqual(data.biomas, {});
});

test('biomas entries are carried, ids trimmed, and the map frozen', () => {
  const data = validateGameData((() => {
    const raw = validRaw();
    raw.biomas = { ' pared1 ': 'assets/wall.png', piso1: 'assets/floor.png' };
    return raw;
  })());

  assert.deepEqual(
    data.biomas,
    { pared1: 'assets/wall.png', piso1: 'assets/floor.png' },
    'ids are compared/kept after trimming, values as authored',
  );
  assert.ok(Object.isFrozen(data.biomas));
});

test('a bad biomas value is rejected by its own key', () => {
  assertRejectedWith(
    (r) => { r.biomas = { piso1: 7 }; },
    'biomas.piso1: expected a non-empty string, got 7',
    'biomas.piso1 7',
  );
});

test('a biomas section that is not a plain object is rejected', () => {
  assertRejectedWith(
    (r) => { r.biomas = ['piso1']; },
    'biomas: expected a plain object, got array',
    'biomas as an array',
  );
});

test('two biomas ids that collide after trimming are rejected', () => {
  assertRejectedWith(
    (r) => { r.biomas = { pared1: 'a.png', ' pared1 ': 'b.png' }; },
    'biomas: duplicate biome id "pared1" (from "pared1" and " pared1 "); ' +
      'ids are compared after trimming whitespace',
    'trimmed duplicate biome ids',
  );
});

// ---------- deep freezing ----------

test('freezeGameData freezes children even when the input is already frozen at the top level', () => {
  const child = { b: 1 };
  const nested = [child];
  const outer = Object.freeze({ a: nested });
  assert.equal(Object.isFrozen(outer), true, 'setup: the input is frozen at the top level');
  assert.equal(Object.isFrozen(nested), false, 'setup: its child is still mutable');

  const result = freezeGameData(outer);

  assert.equal(result, outer, 'freezeGameData returns the same reference');
  assert.equal(Object.isFrozen(nested), true, 'a frozen parent must not shield a mutable child');
  assert.equal(Object.isFrozen(child), true, 'the walk must reach the leaves');
  assert.throws(() => {
    nested.push(2);
  }, TypeError);
  assert.throws(() => {
    child.b = 2;
  }, TypeError);
  assert.equal(child.b, 1, 'the graph must be unchanged after the failed writes');
});

test('freezeGameData passes primitives through untouched', () => {
  for (const value of [42, 'x', null, undefined, true]) {
    assert.equal(freezeGameData(value), value);
  }
});

// ---------- the progression and equipment seam ----------

test('a stat the author did not declare defaults to 0 instead of failing the load', () => {
  // This is what keeps an older source loadable: the workbook fixtures predate
  // the xp/crit/luck columns and cannot be regenerated here, so the reader omits
  // the key and the schema has to supply the default. A PRESENT-but-bad value is
  // still an error (see the boundary table); only an ABSENT one defaults.
  const data = validateGameData(
    (() => {
      const raw = validRaw();
      delete raw.player.critChance;
      delete raw.player.critDamage;
      delete raw.player.luck;
      delete raw.player.dodge;
      delete raw.player.intelligence;
      delete raw.player.maxMana;
      delete raw.enemies.archetypes.rat.xp;
      delete raw.enemies.archetypes.rat.critChance;
      delete raw.enemies.archetypes.rat.dodge;
      delete raw.bosses.archetypes.boss.critDamage;
      delete raw.bosses.archetypes.boss.intelligence;
      delete raw.bosses.archetypes.boss.maxMana;
      return raw;
    })(),
  );

  assert.equal(data.player.critChance, 0);
  assert.equal(data.player.critDamage, 0);
  assert.equal(data.player.luck, 0);
  assert.equal(data.player.dodge, 0);
  assert.equal(data.player.intelligence, 0);
  assert.equal(data.player.maxMana, 0);
  assert.equal(data.enemies.archetypes.rat.xp, 0);
  assert.equal(data.enemies.archetypes.rat.critChance, 0);
  assert.equal(data.enemies.archetypes.rat.dodge, 0);
  assert.equal(data.bosses.archetypes.boss.critDamage, 0);
  assert.equal(data.bosses.archetypes.boss.intelligence, 0);
  assert.equal(data.bosses.archetypes.boss.maxMana, 0);

  // A null is NOT absent: it is a written mistake and must not be hidden by the
  // default, or a bad cell would silently become a zero stat.
  assertRejectedWith(
    (r) => { r.player.luck = null; },
    'player.luck: expected an integer >= 0 and <= 1000, got null',
    'null is not treated as absent',
  );
});

test('the stat ceilings are enforced on the new fields too', () => {
  const cases = [
    ['player.critChance above its ceiling', (r) => { r.player.critChance = 101; }, 'player.critChance: expected an integer between 0 and 100, got 101'],
    ['enemies xp above its ceiling', (r) => { r.enemies.archetypes.rat.xp = 1000001; }, 'enemies.archetypes.rat.xp: expected an integer between 0 and 1000000, got 1000001'],
    ['bosses critDamage above its ceiling', (r) => { r.bosses.archetypes.boss.critDamage = 1001; }, 'bosses.archetypes.boss.critDamage: expected an integer between 0 and 1000, got 1001'],
    ['player luck below its floor', (r) => { r.player.luck = -1; }, 'player.luck: expected an integer >= 0 and <= 1000, got -1'],
    ['player dodge above its ceiling', (r) => { r.player.dodge = 101; }, 'player.dodge: expected an integer between 0 and 100, got 101'],
    ['player intelligence above its ceiling', (r) => { r.player.intelligence = 1000001; }, 'player.intelligence: expected an integer between 0 and 1000000, got 1000001'],
    ['player maxMana above its ceiling', (r) => { r.player.maxMana = 1000001; }, 'player.maxMana: expected an integer between 0 and 1000000, got 1000001'],
  ];
  for (const [label, mutate, message] of cases) {
    assertRejectedWith(mutate, message, label);
  }
});

test('an absent items section or loot table is an empty catalog/table, not an error', () => {
  // Same optionality contract as `bosses`: a source authored before equipment
  // existed stays loadable, and "no section" is not "a broken section".
  const data = validateGameData(
    (() => {
      const raw = validRaw();
      delete raw.items;
      delete raw.loot;
      return raw;
    })(),
  );

  assert.deepEqual(data.items, { definitions: {} });
  assert.deepEqual(data.loot, []);
});

test('an explicit null items/loot section is treated like an absent one', () => {
  const data = validateGameData(
    (() => {
      const raw = validRaw();
      raw.items = null;
      raw.loot = null;
      return raw;
    })(),
  );

  assert.deepEqual(data.items, { definitions: {} });
  assert.deepEqual(data.loot, []);
});

test('a PRESENT but empty items catalog is rejected', () => {
  // "No items sheet" already means "no catalog", so an empty one is an author
  // mistake, not a second spelling of the same thing.
  assertRejectedWith(
    (r) => { r.items = { definitions: {} }; },
    'items.definitions: expected a non-empty object, got {}',
    'empty items catalog',
  );
});

test('an item with an unknown slot is rejected, naming the slot and the known ones', () => {
  assertRejectedWith(
    (r) => { r.items.definitions['rusty-sword'].slot = 'hat'; },
    'items.definitions.rusty-sword.slot: unknown slot "hat" (known: weapon, chest, belt, boots, gloves)',
    'unknown item slot',
  );
});

test('every known slot is accepted', () => {
  for (const slot of ['weapon', 'chest', 'belt', 'boots', 'gloves']) {
    const data = validateGameData(
      (() => {
        const raw = validRaw();
        raw.items.definitions['rusty-sword'].slot = slot;
        return raw;
      })(),
    );
    assert.equal(data.items.definitions['rusty-sword'].slot, slot);
  }
});

test('item bonuses default to 0 and are bounded like the stats they mirror', () => {
  const data = validateGameData(
    (() => {
      const raw = validRaw();
      // A minimal item: identity only, every bonus omitted.
      raw.items.definitions['plain-ring'] = { name: 'Plain Ring', glyph: 'o', slot: 'belt' };
      return raw;
    })(),
  );

  const item = data.items.definitions['plain-ring'];
  assert.equal(item.attack, 0);
  assert.equal(item.defense, 0);
  assert.equal(item.maxHp, 0);
  assert.equal(item.maxMana, 0);
  assert.equal(item.critChance, 0);
  assert.equal(item.critDamage, 0);
  assert.equal(item.luck, 0);
  assert.equal(item.dodge, 0);
  assert.equal(item.intelligence, 0);

  assertRejectedWith(
    (r) => { r.items.definitions['rusty-sword'].attack = -1; },
    'items.definitions.rusty-sword.attack: expected an integer >= 0 and <= 1000000, got -1',
    'a negative item bonus',
  );
});

test('a duplicate item id (after trimming) is rejected, like the archetype rosters', () => {
  assertRejectedWith(
    (r) => { r.items.definitions[' rusty-sword'] = { name: 'Dup', glyph: ')', slot: 'weapon' }; },
    'items.definitions: duplicate item id "rusty-sword" (from "rusty-sword" and " rusty-sword"); ids are compared after trimming whitespace',
    'duplicate item id',
  );
});

test('a loot row may name a real archetype, the "*" wildcard, or fail', () => {
  const data = validateGameData(
    (() => {
      const raw = validRaw();
      raw.loot = [
        { enemy: '*', item: 'dagger', chance: 100 },
        { enemy: 'boss', item: 'dagger', chance: 1 },
        { enemy: 'rat', item: 'dagger', chance: 50 },
      ];
      return raw;
    })(),
  );

  assert.deepEqual(data.loot, [
    { enemy: '*', item: 'dagger', chance: 100 },
    { enemy: 'boss', item: 'dagger', chance: 1 },
    { enemy: 'rat', item: 'dagger', chance: 50 },
  ]);

  assertRejectedWith(
    (r) => { r.loot = [{ enemy: 'troll', item: 'dagger', chance: 10 }]; },
    'loot[0].enemy: unknown archetype "troll" (known: rat, goblin, boss; or "*" for any)',
    'unknown loot archetype',
  );
});

test('a loot row pointing at an unknown item is rejected, naming the known ids', () => {
  assertRejectedWith(
    (r) => { r.loot = [{ enemy: 'rat', item: 'excalibur', chance: 10 }]; },
    'loot[0].item: unknown item "excalibur" (known: rusty-sword, dagger, leather-armor, sturdy-belt, worn-boots, leather-gloves)',
    'unknown loot item',
  );
});

test('a loot chance outside 1..100 is rejected at its row', () => {
  // The message shape is readInt's: a value ABOVE the ceiling reads "between
  // min and max", anything else keeps the ">= min and <= max" form.
  for (const [bad, expected] of [
    [0, 'loot[0].chance: expected an integer >= 1 and <= 100, got 0'],
    [101, 'loot[0].chance: expected an integer between 1 and 100, got 101'],
    [-5, 'loot[0].chance: expected an integer >= 1 and <= 100, got -5'],
  ]) {
    assertRejectedWith((r) => { r.loot[0].chance = bad; }, expected, `loot chance ${bad}`);
  }
});

test('a broken roster yields ONE problem, not a cascade of unknown-id loot lines', () => {
  // The loot membership checks are skipped when the roster they depend on failed
  // to validate, because a second, bogus "unknown archetype" line would point
  // the author at the loot table for a mistake made in the enemies roster.
  const err = dataErrorFrom((r) => {
    delete r.enemies.archetypes.rat.attack;
  });

  assert.ok(err instanceof DataError);
  assert.equal(
    err.message.split('\n').length,
    1,
    `exactly one problem line, got:\n${err.message}`,
  );
  assert.match(err.message, /enemies\.archetypes\.rat\.attack/);
});
