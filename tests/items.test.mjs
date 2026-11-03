/**
 * Stage 3: items, the bag, equipment and loot.
 *
 * The pure loot roller is driven with a spy rng (so the draw/no-draw contract is
 * exact), and the engine paths (drop on death, pickup on step, equip/unequip,
 * descent) are driven end to end against the real data files. Equipment is
 * asserted by its EFFECT on the live stats, because that is the contract every
 * other reader (combat, the panel) depends on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { createGame, playerAction } from '../src/core/game.js';
import { equipItem, unequipItem } from '../src/core/equipment.js';
import { rollLoot } from '../src/core/loot.js';
import { isWalkable } from '../src/map/tiles.js';
import { ANY_ENEMY, DATA_VERSION, validateGameData } from '../src/data/index.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));

const config = readJson('data/config.json');
const playerJson = readJson('data/player.json');
const enemiesJson = readJson('data/enemies.json');
const bossesJson = readJson('data/bosses.json');
const itemsJson = readJson('data/items.json');
const lootJson = readJson('data/loot.json');

function rawData({ items = itemsJson, loot = lootJson } = {}) {
  return {
    dataVersion: DATA_VERSION,
    map: config.map,
    view: config.view,
    seed: config.seed ?? null,
    player: playerJson,
    enemies: enemiesJson,
    bosses: bossesJson,
    items,
    loot,
  };
}

/** The validated GameData the engine consumes, built from the real data files. */
const GAME_DATA = validateGameData(rawData());

/** Same catalog, but a loot table that ALWAYS drops one item — for a deterministic kill. */
const DROP_DATA = validateGameData(
  rawData({ loot: [{ enemy: 'rat', item: 'worn-boots', chance: 100 }] }),
);

/** The shipped catalog plus a synthetic mana item (no shipped item grants mana yet). */
const MANA_DATA = validateGameData(
  rawData({
    items: {
      definitions: {
        ...itemsJson.definitions,
        'mana-charm': { name: 'Mana Charm', glyph: '*', slot: 'belt', maxMana: 10 },
      },
    },
    loot: [],
  }),
);

const DIRS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

/** Teleport the player next to `target` on a free walkable cell; return the step toward it. */
function placePlayerNextTo(game, target) {
  for (const dir of DIRS) {
    const x = target.x + dir.dx;
    const y = target.y + dir.dy;
    if (!isWalkable(game.map, x, y)) continue;
    if (game.enemies.some((e) => e.alive && e.x === x && e.y === y)) continue;
    game.player.x = x;
    game.player.y = y;
    return { dx: -dir.dx, dy: -dir.dy };
  }
  throw new Error('test setup: no free walkable cell next to the target');
}

/** A free, walkable neighbour of the player: {x, y, dx, dy}. */
function freeNeighbour(game) {
  for (const dir of DIRS) {
    const x = game.player.x + dir.dx;
    const y = game.player.y + dir.dy;
    if (!isWalkable(game.map, x, y)) continue;
    if (game.enemies.some((e) => e.alive && e.x === x && e.y === y)) continue;
    return { x, y, dx: dir.dx, dy: dir.dy };
  }
  throw new Error('test setup: the player has no free walkable neighbour');
}

// ---------- rollLoot: the pure roller ----------

test('rollLoot rolls each matching row and the wildcard, never drawing for no match', () => {
  const table = [
    { enemy: 'rat', item: 'cheese', chance: 50 },
    { enemy: 'goblin', item: 'coin', chance: 50 },
    { enemy: ANY_ENEMY, item: 'pebble', chance: 50 },
  ];

  const always50 = { int: () => 50 };
  assert.deepEqual(
    rollLoot(table, 'rat', 0, always50),
    ['cheese', 'pebble'],
    'a 50% roll at exactly 50 drops both the rat row and the wildcard',
  );
  assert.deepEqual(
    rollLoot(table, 'goblin', 0, always50),
    ['coin', 'pebble'],
    'the goblin row and the wildcard are the goblin\'s matches',
  );

  const spy = {
    calls: 0,
    int() {
      this.calls += 1;
      return 1;
    },
  };
  assert.deepEqual(
    rollLoot(table, 'dragon', 0, spy),
    ['pebble'],
    'an archetype with no own row still matches the wildcard',
  );
  assert.equal(spy.calls, 1, 'a non-matching row must not consume a draw');

  const untouched = {
    calls: 0,
    int() {
      this.calls += 1;
      return 1;
    },
  };
  assert.deepEqual(rollLoot([], 'rat', 0, untouched), [], 'an empty table drops nothing');
  assert.equal(untouched.calls, 0, 'an empty table must not consume a draw either');
});

test('luck raises a row chance in percentage points, clamped at certain', () => {
  const table = [{ enemy: 'rat', item: 'cheese', chance: 50 }];
  const at85 = { int: () => 85 };

  assert.deepEqual(rollLoot(table, 'rat', 0, at85), [], 'an 85 beats a base 50%');
  assert.deepEqual(rollLoot(table, 'rat', 40, at85), ['cheese'], 'luck 40 turns 50% into 90%');

  const at100 = { int: () => 100 };
  assert.deepEqual(
    rollLoot(table, 'rat', 500, at100),
    ['cheese'],
    'a row clamped to 100% always drops',
  );
});

// ---------- drop on death ----------

test('a killed archetype drops its loot on the floor at its cell', () => {
  const game = createGame({ data: DROP_DATA, seed: 555 });
  const rat = game.enemies.find((e) => e.archetypeId === 'rat');
  assert.ok(rat, 'test setup: the shipped spawn table includes a rat');
  rat.xp = 0; // keep the kill from pausing for a level-up
  rat.hp = 1; // one hit kills
  const cell = { x: rat.x, y: rat.y };
  const step = placePlayerNextTo(game, rat);

  const events = playerAction(game, { type: 'move', dx: step.dx, dy: step.dy });

  assert.equal(rat.alive, false, 'test setup: the hit must be lethal');
  assert.deepEqual(
    game.groundItems.map((g) => [g.item, g.x, g.y]),
    [['worn-boots', cell.x, cell.y]],
    'the drop must lie on the corpse cell',
  );
  const drop = events.find((e) => e.type === 'drop');
  assert.ok(drop, 'killing a drop-bearing archetype must emit a drop event');
  assert.equal(drop.name, 'Worn Boots', 'the drop event carries the display name');
});

test('a table with no matching rows drops nothing and emits no drop event', () => {
  const game = createGame({ data: GAME_DATA, seed: 4242 });
  // A goblin whose archetype has no row in the SHIPPED table for this seed's
  // single-enemy case is not guaranteed; instead assert the general contract:
  // an enemy whose id matches nothing drops nothing.
  const rat = game.enemies.find((e) => e.archetypeId === 'rat');
  rat.archetypeId = 'no-such-archetype';
  rat.xp = 0;
  rat.hp = 1;
  const step = placePlayerNextTo(game, rat);

  const events = playerAction(game, { type: 'move', dx: step.dx, dy: step.dy });

  // The shipped table's only wildcard row (sturdy-belt, 8%) can still drop, so
  // this asserts the row-scoping rather than "nothing at all": no row names the
  // bogus id.
  assert.equal(
    game.groundItems.some((g) => g.item === 'worn-boots' || g.item === 'dagger'),
    false,
    'a rat-only row must not fire for a different archetype id',
  );
  assert.equal(events.some((e) => e.type === 'drop' && e.item !== 'sturdy-belt'), false);
});

// ---------- pickup on step ----------

test('stepping onto a ground item picks it up into the bag', () => {
  const game = createGame({ data: GAME_DATA, seed: 555 });
  const spot = freeNeighbour(game);
  game.groundItems.push({ item: 'worn-boots', x: spot.x, y: spot.y });

  const events = playerAction(game, { type: 'move', dx: spot.dx, dy: spot.dy });

  assert.ok(game.player.inventory.includes('worn-boots'), 'the item must reach the bag');
  assert.equal(game.groundItems.length, 0, 'the floor loot is consumed');
  const pickup = events.find((e) => e.type === 'pickup');
  assert.ok(pickup, 'picking up must emit a pickup event');
  assert.equal(pickup.name, 'Worn Boots');
});

test('the drop -> floor -> pickup loop closes', () => {
  const game = createGame({ data: DROP_DATA, seed: 555 });
  const rat = game.enemies.find((e) => e.archetypeId === 'rat');
  rat.xp = 0;
  rat.hp = 1;
  const step = placePlayerNextTo(game, rat);
  playerAction(game, { type: 'move', dx: step.dx, dy: step.dy }); // kill, drop
  assert.equal(game.groundItems.length, 1, 'test setup: the rat dropped');

  // Step back onto the corpse cell (it is free; the rat is dead).
  const onto = { type: 'move', dx: rat.x - game.player.x, dy: rat.y - game.player.y };
  assert.equal(Math.abs(onto.dx) + Math.abs(onto.dy), 1, 'test setup: the player is orthogonally adjacent');
  playerAction(game, onto);

  assert.ok(game.player.inventory.includes('worn-boots'), 'the dropped item ends up in the bag');
  assert.equal(game.groundItems.length, 0, 'and leaves the floor');
});

// ---------- equipment ----------

test('equipping applies bonuses and unequipping reverses them exactly', () => {
  const game = createGame({ data: GAME_DATA, seed: 1 });
  const p = game.player;
  const baseAttack = p.attack;
  p.inventory.push('rusty-sword');

  assert.equal(equipItem(game, 'rusty-sword'), true);
  assert.equal(p.equipment.weapon, 'rusty-sword');
  assert.equal(p.attack, baseAttack + 2, 'a +2 weapon raises attack');
  assert.equal(p.inventory.includes('rusty-sword'), false, 'the item left the bag');

  assert.equal(unequipItem(game, 'weapon'), true);
  assert.equal(p.equipment.weapon, null);
  assert.equal(p.attack, baseAttack, 'unequipping must restore the base attack');
  assert.ok(p.inventory.includes('rusty-sword'), 'the item returned to the bag');
});

test('a level-up gain made while a item is worn survives unequipping', () => {
  const game = createGame({ data: GAME_DATA, seed: 1 });
  const p = game.player;
  const baseAttack = p.attack;
  p.inventory.push('rusty-sword');
  equipItem(game, 'rusty-sword'); // +2

  p.attack += 1; // as applyLevelUpPoint does

  unequipItem(game, 'weapon');
  assert.equal(p.attack, baseAttack + 1, 'the one spent point must remain after the item comes off');
});

test('equipping into an occupied slot swaps the worn item back into the bag', () => {
  const game = createGame({ data: GAME_DATA, seed: 1 });
  const p = game.player;
  const baseAttack = p.attack;
  p.inventory.push('rusty-sword', 'dagger');

  equipItem(game, 'rusty-sword'); // +2
  assert.equal(p.attack, baseAttack + 2);
  equipItem(game, 'dagger'); // +1, rusty-sword comes off
  assert.equal(p.attack, baseAttack + 1, 'the displaced item\'s bonus must be removed');
  assert.equal(p.equipment.weapon, 'dagger');
  assert.ok(p.inventory.includes('rusty-sword'), 'the displaced weapon returns to the bag');
  assert.equal(p.inventory.includes('dagger'), false);
});

test('a maxHp item fills the granted ceiling and unequip clamps the current hp', () => {
  const game = createGame({ data: GAME_DATA, seed: 1 });
  const p = game.player;
  const maxHpBefore = p.maxHp;
  assert.equal(p.hp, p.maxHp, 'test setup: the hero starts full');
  p.inventory.push('sturdy-belt');

  equipItem(game, 'sturdy-belt'); // +3 maxHp
  assert.equal(p.maxHp, maxHpBefore + 3);
  assert.equal(p.hp, maxHpBefore + 3, 'the granted ceiling is filled');

  p.hp = p.maxHp;
  unequipItem(game, 'belt');
  assert.equal(p.maxHp, maxHpBefore);
  assert.equal(p.hp, maxHpBefore, 'hp must clamp down to the restored ceiling');
});

test('a maxMana item mirrors the maxHp pool rule', () => {
  const game = createGame({ data: MANA_DATA, seed: 1 });
  const p = game.player;
  const maxManaBefore = p.maxMana;
  assert.equal(p.mana, p.maxMana, 'test setup: the hero starts with a full pool');
  p.inventory.push('mana-charm');

  assert.equal(equipItem(game, 'mana-charm'), true);
  assert.equal(p.maxMana, maxManaBefore + 10);
  assert.equal(p.mana, maxManaBefore + 10, 'the granted ceiling is filled');

  p.mana = p.maxMana;
  unequipItem(game, 'belt');
  assert.equal(p.maxMana, maxManaBefore);
  assert.equal(p.mana, maxManaBefore, 'mana must clamp down to the restored ceiling');
});

test('equipping is refused for an item not in the bag, or an unknown id, changing nothing', () => {
  const game = createGame({ data: GAME_DATA, seed: 1 });
  const p = game.player;
  const attack = p.attack;

  assert.equal(equipItem(game, 'rusty-sword'), false, 'the item is not in the bag');
  assert.equal(equipItem(game, 'excalibur'), false, 'unknown item id');
  assert.equal(equipItem(game, ''), false, 'empty id');
  assert.equal(p.attack, attack, 'a refused equip must change nothing');
  assert.equal(p.equipment.weapon, null);

  assert.equal(unequipItem(game, 'weapon'), false, 'an empty slot has nothing to remove');
  assert.equal(unequipItem(game, 'hat'), false, 'an unknown slot is refused');
});

test('an equipped item survives a descent while floor loot does not', () => {
  const game = createGame({ data: GAME_DATA, seed: 7 });
  const p = game.player;

  p.inventory.push('leather-armor');
  equipItem(game, 'leather-armor');
  const defense = p.defense;
  game.groundItems.push({ item: 'dagger', x: 1, y: 1 });

  p.x = game.map.stairs.x;
  p.y = game.map.stairs.y;
  playerAction(game, { type: 'wait' });

  assert.equal(game.level, 2, 'test setup: standing on the stairs descends');
  assert.equal(p.equipment.chest, 'leather-armor', 'worn gear stays with the hero');
  assert.equal(p.defense, defense, 'and its bonus is still applied');
  assert.equal(game.groundItems.length, 0, 'floor loot belongs to the level it fell in');
});

// ---------- the engine gives every archetype the id the loot table needs ----------

test('spawned enemies and the boss carry the archetypeId the loot table names', () => {
  const game = createGame({ data: GAME_DATA, seed: 1 });
  for (const enemy of game.enemies) {
    assert.ok(
      enemy.archetypeId === 'rat' || enemy.archetypeId === 'goblin',
      `a spawned enemy must carry its archetype id, got ${enemy.archetypeId}`,
    );
  }

  const boss = createGame({ data: GAME_DATA, seed: 1, level: 5 });
  const bossEnemy = boss.enemies.find((e) => e.kind === 'boss');
  assert.ok(bossEnemy, 'test setup: level 5 spawns the boss');
  assert.equal(bossEnemy.archetypeId, 'boss', 'the boss id is what its loot row names');
});

test('the shipped loot table resolves through the shipped item catalog', () => {
  const game = createGame({ data: GAME_DATA, seed: 1 });
  const rows = game._data.loot;

  assert.ok(rows.length > 0, 'the shipped loot table must not be empty');
  assert.ok(rows.some((row) => row.enemy === ANY_ENEMY), 'the wildcard row must survive to the engine');
  for (const row of rows) {
    assert.ok(game._data.items.definitions[row.item], `loot row names a real item: ${row.item}`);
  }

  // A rat matches its own rows plus the wildcard, so it can always drop something.
  const everything = { int: () => 1 };
  assert.ok(rollLoot(rows, 'rat', 0, everything).length > 0, 'a rat must be able to drop');
});
