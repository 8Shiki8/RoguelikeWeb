/**
 * Rules-engine regression harness.
 *
 * Ported faithfully from the throwaway slice-1 `engine-smoke.mjs` script: same
 * seeds, same deterministic policy, same assertions. It was renamed to match the
 * `node --test` file pattern because a bare `engine-smoke.mjs` is silently never
 * collected by the runner.
 *
 * Three bugs actually shipped through this code, each pinned by an assertion
 * below:
 *   1. zero damage -> 200/200 runs "cleared" with 0 deaths (see `outcomes.dead`);
 *   2. bumping a wall consumed a turn (see the blocked-move test);
 *   3. the enemy phase kept acting after the player died (see the death test).
 *
 * All paths are derived from `import.meta.url`, so the harness runs from any
 * checkout on any machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  GameStatus,
  LEVEL_STATS,
  POINTS_PER_LEVEL,
  applyLevelUpPoint,
  createGame,
  deferLevelUp,
  playerAction,
} from '../src/core/game.js';
import { damageFor, resolveAttack } from '../src/core/combat.js';
import { createEntity } from '../src/entities/entity.js';
import { createRng } from '../src/core/rng.js';
import { isWalkable } from '../src/map/tiles.js';
import { DATA_VERSION, createGameData, validateGameData } from '../src/data/index.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));

const config = readJson('data/config.json');

/** The validated GameData the engine consumes, built from the real data files. */
const GAME_DATA = validateGameData({
  dataVersion: DATA_VERSION,
  map: config.map,
  view: config.view,
  seed: config.seed ?? null,
  player: readJson('data/player.json'),
  enemies: readJson('data/enemies.json'),
  bosses: readJson('data/bosses.json'),
});

const SEEDS = 200;

const DIRS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

function dist(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Assign every pending level-up point (to maxHp) so the run can resume.
 * `applyLevelUpPoint` clears the prompt once the last point is spent, so this
 * always makes progress; the boolean return lets the caller bail out instead of
 * spinning forever should that ever stop being true.
 * @returns {boolean} whether any point was spent.
 */
function assignAllPoints(game) {
  let progress = false;
  while (game.player.pointsUnspent > 0) {
    if (!applyLevelUpPoint(game, 'maxHp')) break;
    progress = true;
  }
  return progress;
}

// ---------- 1. determinism ----------
test('the same seed reproduces the same dungeon and enemy spawns', () => {
  const a = createGame({ data: GAME_DATA, seed: 12345 });
  const b = createGame({ data: GAME_DATA, seed: 12345 });
  const c = createGame({ data: GAME_DATA, seed: 999 });

  assert.equal(
    a.map.tiles.join(','),
    b.map.tiles.join(','),
    'same seed must produce the same dungeon tiles',
  );
  assert.notEqual(
    a.map.tiles.join(','),
    c.map.tiles.join(','),
    'different seeds should produce different dungeons',
  );
  assert.equal(
    a.enemies.map((e) => `${e.x},${e.y}`).join('|'),
    b.enemies.map((e) => `${e.x},${e.y}`).join('|'),
    'same seed must produce the same enemy spawns',
  );
});

// ---------- 2. dungeon + spawn sanity, over many seeds ----------
// Every inner check is collected and asserted once at the end: 100k+ individual
// assertions would add runtime and noise without adding diagnostics.
test(`dungeon and spawn sanity hold across ${SEEDS} seeds`, (t) => {
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  const fingerprints = new Set();
  let repairedMaps = 0;

  for (let s = 0; s < SEEDS; s += 1) {
    const seed = 1000 + s * 7919;
    const game = createGame({ data: GAME_DATA, seed });

    check(
      game.map.tiles.length === GAME_DATA.map.width * GAME_DATA.map.height,
      `seed ${seed}: tile count`,
    );
    check(game.map.connectivity.connected === true, `seed ${seed}: dungeon not connected`);
    check(
      game.map.rooms.length >= GAME_DATA.map.minRooms &&
        game.map.rooms.length <= GAME_DATA.map.maxRooms,
      `seed ${seed}: room count ${game.map.rooms.length} outside ` +
        `[${GAME_DATA.map.minRooms}, ${GAME_DATA.map.maxRooms}]`,
    );
    if (game.map.connectivity.repaired) repairedMaps += 1;
    fingerprints.add(game.map.tiles.join(''));

    for (const room of game.map.rooms) {
      check(
        room.w >= GAME_DATA.map.minRoomSize && room.w <= GAME_DATA.map.maxRoomSize,
        `seed ${seed}: room width ${room.w} out of range`,
      );
      check(
        room.h >= GAME_DATA.map.minRoomSize && room.h <= GAME_DATA.map.maxRoomSize,
        `seed ${seed}: room height ${room.h} out of range`,
      );
    }

    const all = [game.player, ...game.enemies];
    check(isWalkable(game.map, game.player.x, game.player.y), `seed ${seed}: player not on floor`);
    for (const e of game.enemies) {
      check(isWalkable(game.map, e.x, e.y), `seed ${seed}: enemy not on floor`);
    }
    const cells = all.map((e) => `${e.x},${e.y}`);
    check(new Set(cells).size === cells.length, `seed ${seed}: entities overlap at spawn`);

    const rooms = game.map.rooms;
    for (let i = 0; i < rooms.length; i += 1) {
      for (let j = i + 1; j < rooms.length; j += 1) {
        const a = rooms[i];
        const b = rooms[j];
        const gapX = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
        const gapY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
        check(Math.max(gapX, gapY) >= 1, `seed ${seed}: rooms ${i},${j} touch (no separating wall)`);
      }
    }
  }

  t.diagnostic(`distinct dungeons: ${fingerprints.size}/${SEEDS}`);
  t.diagnostic(`connectivity repairs: ${repairedMaps}`);
  assert.equal(failures.length, 0, failures.slice(0, 25).join('\n'));
});

// ---------- 3. turn invariants, over many played runs ----------
test(`turn invariants hold across ${SEEDS} played runs`, (t) => {
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  const outcomes = { dead: 0, cleared: 0, timeout: 0 };
  let totalTurns = 0;
  let levelUps = 0;
  let playerDamageTaken = 0;
  let playerKills = 0;

  for (let s = 0; s < SEEDS; s += 1) {
    const seed = 1000 + s * 7919;
    const game = createGame({ data: GAME_DATA, seed });

    let guard = 0;
    while (
      (game.status === GameStatus.PLAYING || game.status === GameStatus.LEVEL_UP) &&
      guard < 400
    ) {
      // A level-up pauses the run (status LEVEL_UP) until its points are
      // assigned. That is free bookkeeping, not a turn, so it must not consume
      // the turn budget -- otherwise every levelling run is miscounted as a
      // timeout. A false return would mean the prompt is stuck; give up.
      if (game.status === GameStatus.LEVEL_UP) {
        levelUps += 1;
        if (!assignAllPoints(game)) break;
        continue;
      }

      guard += 1;
      const turnBefore = game.turn;
      const posBefore = `${game.player.x},${game.player.y}`;
      const hpBefore = game.player.hp;
      const livingBefore = game.enemies.filter((e) => e.alive).length;

      // Deterministic policy: 70% chase the nearest enemy, 30% random walk.
      const roll = (seed * 31 + guard * 17) % 10;
      let action;
      const nearest = game.enemies
        .filter((e) => e.alive)
        .sort((a, b) => dist(a, game.player) - dist(b, game.player))[0];
      if (nearest && roll < 7) {
        const dx = Math.sign(nearest.x - game.player.x);
        const dy = Math.sign(nearest.y - game.player.y);
        action = Math.abs(dx) + Math.abs(dy) === 1 ? { type: 'move', dx, dy } : { type: 'wait' };
      } else if (roll === 7) {
        action = { type: 'wait' };
      } else {
        action = { type: 'move', ...DIRS[(guard + s) % 4] };
      }

      const events = playerAction(game, action);

      // Descending the stairs is the ONE action that legitimately breaks the
      // per-level turn arithmetic: src/core/game.js `descendStairs` swaps in a
      // fresh level and restarts that level's counter (`game.turn = 0`). This
      // harness only reaches that path now that the dungeon has 8-16 rooms
      // (the 2-room dungeon it replaced never found the stairs in 400 turns),
      // and the invariant below is deliberately a per-level one.
      const descended = events.some((ev) => ev.type === 'descend');

      // one player action => at most one turn
      if (!descended) {
        check(game.turn - turnBefore <= 1, `seed ${seed}: turn advanced by more than 1`);
        check(game.turn >= turnBefore, `seed ${seed}: turn went backwards`);
      }

      const moved = `${game.player.x},${game.player.y}` !== posBefore;
      if (moved && !descended) {
        check(game.turn === turnBefore + 1, `seed ${seed}: movement did not consume exactly one turn`);
      }
      if (action.type === 'wait' && !descended) {
        check(game.turn === turnBefore + 1, `seed ${seed}: waiting did not consume a turn`);
      }

      // enemy phase must not exceed one action per living enemy
      const enemyMoves = events.filter(
        (ev) => ev.type === 'move' && ev.actor.kind === 'enemy',
      ).length;
      const enemyAttacks = events.filter(
        (ev) => ev.type === 'attack' && ev.actor.kind === 'enemy',
      ).length;
      check(
        enemyMoves + enemyAttacks <= livingBefore,
        `seed ${seed}: enemy phase did ${enemyMoves + enemyAttacks} actions for ${livingBefore} enemies`,
      );

      // state invariants
      for (const entity of [game.player, ...game.enemies]) {
        check(
          entity.hp >= 0 && entity.hp <= entity.maxHp,
          `seed ${seed}: ${entity.name} hp out of range`,
        );
        check(entity.alive === entity.hp > 0, `seed ${seed}: ${entity.name} alive/hp mismatch`);
      }
      const livingCells = [game.player, ...game.enemies]
        .filter((e) => e.alive)
        .map((e) => `${e.x},${e.y}`);
      check(
        new Set(livingCells).size === livingCells.length,
        `seed ${seed}: entities overlap mid-run`,
      );

      // the player only ever loses hp through enemy attacks
      if (game.player.hp < hpBefore) {
        const hits = events.filter(
          (ev) => ev.type === 'attack' && ev.target.kind === 'player' && ev.actor.kind === 'enemy',
        );
        check(hits.length > 0, `seed ${seed}: player lost hp without an enemy attack event`);
        playerDamageTaken += hits.reduce((sum, ev) => sum + ev.damage, 0);
      }
      playerKills += events.filter(
        (ev) => ev.type === 'attack' && ev.actor.kind === 'player' && ev.killed,
      ).length;
    }

    totalTurns += game.turn;
    if (game.status === GameStatus.DEAD) outcomes.dead += 1;
    else if (game.status === GameStatus.CLEARED) outcomes.cleared += 1;
    else outcomes.timeout += 1;
  }

  t.diagnostic(
    `outcomes: ${outcomes.dead} deaths / ${outcomes.cleared} cleared / ${outcomes.timeout} timeout`,
  );
  t.diagnostic(`level-ups offered: ${levelUps}`);
  t.diagnostic(`avg turns per run: ${(totalTurns / SEEDS).toFixed(1)}`);
  t.diagnostic(`player took ${playerDamageTaken} damage, landed ${playerKills} kills`);
  assert.equal(failures.length, 0, failures.slice(0, 25).join('\n'));
  // Regression guard for the zero-damage bug (which produced 200/200 eager
  // "cleared" with 0 deaths). It asserts damage actually flows, NOT that some
  // balance happens to kill the player: the authored workbook gives the player
  // 80 maxHp, against which not one of these runs dies, so a "deaths > 0" guard
  // would fail for a reason that is not a bug.
  assert.ok(
    playerDamageTaken > 0,
    `expected the player to take damage across ${SEEDS} runs (zero-damage regression)`,
  );
  assert.ok(
    playerKills > 0,
    `expected the player to land kills across ${SEEDS} runs (zero-damage regression)`,
  );
});

// ---------- 4. explicit damage rule check ----------
test('damageFor is max(1, attack - defense)', () => {
  const game = createGame({ data: GAME_DATA, seed: 4242 });
  const player = game.player;
  const enemy = game.enemies[0];

  assert.equal(
    damageFor(player, enemy),
    Math.max(1, player.attack - enemy.defense),
    'damageFor must be max(1, attack - defense)',
  );
  assert.equal(damageFor({ attack: 1 }, { defense: 99 }), 1, 'damage must never drop below 1');
});

/** Teleport the player next to `target` on a free walkable cell. Returns the step toward it. */
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

// ---------- 5. blocked move must not consume a turn ----------
test('bumping a wall does not advance the turn and reports a blocked event', () => {
  const game = createGame({ data: GAME_DATA, seed: 31337 });
  let tested = false;

  for (let y = 1; y < game.map.height && !tested; y += 1) {
    for (let x = 1; x < game.map.width && !tested; x += 1) {
      if (!isWalkable(game.map, x, y)) continue;
      if (game.enemies.some((e) => e.alive && e.x === x && e.y === y)) continue;
      const wall = DIRS.find((d) => !isWalkable(game.map, x + d.dx, y + d.dy));
      if (!wall) continue;

      game.player.x = x;
      game.player.y = y;
      const before = game.turn;
      const events = playerAction(game, { type: 'move', dx: wall.dx, dy: wall.dy });

      assert.equal(game.turn, before, 'bumping a wall must not advance the turn');
      assert.ok(
        events.some((e) => e.type === 'blocked' && e.reason === 'wall'),
        'bumping a wall must emit a blocked event',
      );
      tested = true;
    }
  }

  assert.ok(tested, 'test setup: expected at least one wall-adjacent floor cell');
});

// ---------- 6. attacking consumes exactly one turn ----------
test('bumping an enemy attacks it and consumes exactly one turn', () => {
  const game = createGame({ data: GAME_DATA, seed: 555 });
  const enemy = game.enemies[0];
  const step = placePlayerNextTo(game, enemy);
  const before = game.turn;
  const hpBefore = enemy.hp;

  const events = playerAction(game, { type: 'move', dx: step.dx, dy: step.dy });
  const attack = events.find((e) => e.type === 'attack' && e.actor.kind === 'player');

  assert.ok(attack !== undefined, 'bumping an enemy must produce an attack event');
  assert.equal(attack.target.id, enemy.id, 'the attack event must name the bumped enemy');
  assert.equal(
    enemy.hp,
    Math.max(0, hpBefore - attack.damage),
    'reported damage must match applied damage',
  );
  assert.equal(game.turn, before + 1, 'an attack must consume exactly one turn');
});

// ---------- 7. death path freezes the game ----------
test('a lethal enemy hit kills the player and freezes the game', () => {
  const game = createGame({ data: GAME_DATA, seed: 606 });
  const enemy = game.enemies[0];
  placePlayerNextTo(game, enemy);
  game.player.hp = 1;
  enemy.attack = 99; // guarantee a lethal hit
  const turnBefore = game.turn;

  const events = playerAction(game, { type: 'wait' });
  const enemyAttacks = events.filter((e) => e.type === 'attack' && e.actor.kind === 'enemy');

  assert.equal(game.player.alive, false, 'a lethal hit must kill the player');
  assert.equal(game.player.hp, 0, 'player hp must floor at 0');
  assert.equal(game.status, GameStatus.DEAD, 'player death must set status to dead');
  assert.ok(
    events.some((e) => e.type === 'gameover' && e.winner === 'enemies'),
    'death must emit a gameover event',
  );
  assert.equal(enemyAttacks.length, 1, 'the enemy phase must stop as soon as the player dies');
  assert.equal(game.turn, turnBefore + 1, 'the fatal turn must still count as one turn');

  const turnAfter = game.turn;
  const ignored = playerAction(game, { type: 'wait' });
  assert.equal(ignored.length, 0, 'no action may be processed after death');
  assert.equal(game.turn, turnAfter, 'the turn must not advance after death');
});

// ---------- 8. spawn failures are source-agnostic ----------
test('an unknown spawn archetype fails with a source-agnostic engine error', () => {
  // Validation rejects a dangling spawn archetype as `enemies.spawn[N].archetype`
  // before this can happen, so the engine's own guard is reached by building the
  // GameData directly, as a non-validating adapter could.
  const data = createGameData({
    dataVersion: DATA_VERSION,
    map: { ...GAME_DATA.map },
    view: { ...GAME_DATA.view },
    seed: null,
    player: { ...GAME_DATA.player },
    enemies: { archetypes: {}, spawn: [{ archetype: 'troll', count: 1 }] },
  });

  assert.throws(
    () => createGame({ data, seed: 1 }),
    (err) => {
      assert.equal(err.message, 'Unknown enemy archetype "troll"');
      assert.ok(
        !err.message.includes('.json'),
        `src/core must not name a data file (it would be a lie for an Excel/DB adapter): ${err.message}`,
      );
      return true;
    },
  );
});

// ---------- 9. the panel target tracks the player's own last attack ----------

test('game.target starts null and a player attack makes the bumped enemy the target', () => {
  const game = createGame({ data: GAME_DATA, seed: 4242 });
  assert.equal(game.target, null, 'a fresh run has no target');

  const enemy = game.enemies[0];
  enemy.maxHp = 100;
  enemy.hp = 100; // survive the hit, so the reference must still be set afterwards
  const step = placePlayerNextTo(game, enemy);

  playerAction(game, { type: 'move', dx: step.dx, dy: step.dy });

  assert.equal(game.target, enemy, "the player's attack must become the panel target");
});

test('an enemy attacking the player does not become the panel target', () => {
  const game = createGame({ data: GAME_DATA, seed: 4243 });
  const enemy = game.enemies[0];
  placePlayerNextTo(game, enemy);

  const events = playerAction(game, { type: 'wait' });

  assert.ok(
    events.some((e) => e.type === 'attack' && e.actor.kind === 'enemy'),
    'test setup: an adjacent enemy must attack the waiting player',
  );
  assert.equal(game.target, null, 'only the player sets the panel target');
});

test('the killing blow clears game.target', () => {
  const game = createGame({ data: GAME_DATA, seed: 4244 });
  const enemy = game.enemies[0];
  enemy.hp = 1; // any hit kills
  const step = placePlayerNextTo(game, enemy);

  playerAction(game, { type: 'move', dx: step.dx, dy: step.dy });

  assert.equal(enemy.alive, false, 'test setup: the hit must be lethal');
  assert.equal(game.target, null, 'a dead enemy is nothing left to show');
});

// ---------- 10. the stairs marker always sits on a reachable room cell ----------
// The renderer draws `> ` at map.stairs and the player walks onto it to descend.
// If generation ever moved the marker off a walkable room cell -- or left it on
// the boss level -- the descent would silently become unreachable or pointless.
test('levels 1-4 place walkable stairs inside a room; the boss level has none', () => {
  for (let level = 1; level <= 4; level += 1) {
    const game = createGame({ data: GAME_DATA, seed: 7, level });
    const stairs = game.map.stairs;

    assert.ok(stairs, `level ${level} must place stairs`);
    assert.ok(
      isWalkable(game.map, stairs.x, stairs.y),
      `level ${level} stairs must sit on a walkable tile`,
    );
    assert.ok(
      game.map.rooms.some(
        (r) => stairs.x >= r.x && stairs.x < r.x + r.w && stairs.y >= r.y && stairs.y < r.y + r.h,
      ),
      `level ${level} stairs must lie inside a room rect`,
    );
  }

  const boss = createGame({ data: GAME_DATA, seed: 7, level: 5 });
  assert.equal(boss.map.stairs, null, 'the boss level is won by combat, not by descending');
});

// ---------- 11. the new combat stats reach the entities ----------
test('createEntity carries crit and luck, defaulting missing ones to 0', () => {
  const hero = createEntity({
    kind: 'player',
    name: 'Hero',
    glyph: '@',
    x: 0,
    y: 0,
    maxHp: 10,
    attack: 1,
    defense: 1,
    critChance: 5,
    critDamage: 50,
    luck: 3,
  });
  assert.equal(hero.critChance, 5);
  assert.equal(hero.critDamage, 50);
  assert.equal(hero.luck, 3);

  // An archetype that declares none (e.g. enemies have no luck) must still read
  // as a number so combat never has to guard for undefined.
  const bare = createEntity({
    kind: 'enemy',
    name: 'Rat',
    glyph: 'r',
    x: 1,
    y: 1,
    maxHp: 5,
    attack: 1,
    defense: 0,
  });
  assert.equal(bare.critChance, 0);
  assert.equal(bare.critDamage, 0);
  assert.equal(bare.luck, 0);
});

test('the shipped player and enemies carry the crit stats from the data', () => {
  const game = createGame({ data: GAME_DATA, seed: 1 });
  assert.ok(game.player.critChance > 0, 'the player must ship with a crit chance');
  assert.equal(typeof game.player.critDamage, 'number');
  assert.equal(typeof game.player.luck, 'number');
  for (const enemy of game.enemies) {
    assert.equal(typeof enemy.critChance, 'number', `${enemy.name} critChance`);
    assert.equal(typeof enemy.critDamage, 'number', `${enemy.name} critDamage`);
  }
});

// ---------- 12. critical hits ----------
test('critChance 100 always crits and scales damage by the critDamage bonus', () => {
  const attacker = createEntity({
    kind: 'player',
    name: 'Hero',
    glyph: '@',
    x: 0,
    y: 0,
    maxHp: 10,
    attack: 10,
    defense: 0,
    critChance: 100,
    critDamage: 50,
  });
  const target = createEntity({
    kind: 'enemy',
    name: 'Dummy',
    glyph: 'd',
    x: 1,
    y: 0,
    maxHp: 100,
    attack: 0,
    defense: 2,
  });

  const result = resolveAttack(attacker, target, createRng(1));

  assert.equal(result.crit, true, 'critChance 100 must always crit');
  assert.equal(
    result.damage,
    Math.round(Math.max(1, 10 - 2) * 1.5),
    'a +50% crit bonus must scale the base damage',
  );
});

test('critChance 0 never crits and does not draw from the rng', () => {
  const attacker = { attack: 5, critChance: 0, critDamage: 100 };
  const rng = createRng(99);

  const result = resolveAttack(attacker, { hp: 50, maxHp: 50, defense: 0, alive: true }, rng);

  assert.equal(result.crit, false);
  assert.equal(result.damage, 5, 'a non-crit deals the base damage');
  // Same seed, no attack at all: the first draw must match, proving the
  // impossible roll never happened (which keeps the stream stable).
  assert.equal(rng.next(), createRng(99).next(), 'a 0 crit chance must not consume a draw');
});

test('resolveAttack without an rng is a plain, crit-free hit', () => {
  const result = resolveAttack(
    { attack: 4, critChance: 100, critDamage: 500 },
    { hp: 30, maxHp: 30, defense: 0, alive: true },
  );

  assert.equal(result.crit, false, 'without an rng there is no crit roll');
  assert.equal(result.damage, 4);
});

test('the same seed reproduces the same crit sequence', () => {
  const sequence = () => {
    const rng = createRng(2024);
    const attacker = { attack: 3, critChance: 50, critDamage: 100 };
    const rolls = [];
    for (let i = 0; i < 20; i += 1) {
      const target = { hp: 1000, maxHp: 1000, defense: 0, alive: true };
      rolls.push(resolveAttack(attacker, target, rng).damage);
    }
    return rolls;
  };

  const a = sequence();
  assert.deepEqual(a, sequence(), 'crits must be reproducible from the seed');
  assert.equal(new Set(a).size, 2, '20 rolls at 50% must mix crits and non-crits');
});

// ---------- 12b. dodge ----------
test('a defender that dodges takes no damage and reports the evade', () => {
  const rng = createRng(7);
  const result = resolveAttack(
    { attack: 10, critChance: 100, critDamage: 500 },
    { hp: 20, maxHp: 20, defense: 0, alive: true, dodge: 100 },
    rng,
  );

  assert.equal(result.dodged, true);
  assert.equal(result.damage, 0, 'an evaded hit deals no damage');
  assert.equal(result.crit, false, 'an evaded hit cannot also be a crit');
  assert.equal(result.killed, false);
  assert.equal(result.hp, 20, 'the defender must be untouched');
});

test('a 0 dodge never dodges and does not consume a draw', () => {
  const rng = createRng(31);
  const result = resolveAttack(
    { attack: 5, critChance: 0, critDamage: 0 },
    { hp: 50, maxHp: 50, defense: 0, alive: true, dodge: 0 },
    rng,
  );

  assert.equal(result.dodged, false);
  assert.equal(result.damage, 5);
  // Same seed, no attack at all: the first draw must match, proving the
  // impossible roll never happened (which keeps the stream stable).
  assert.equal(rng.next(), createRng(31).next(), 'a 0 dodge must not consume a draw');
});

test('the same seed reproduces the same dodge sequence', () => {
  const sequence = () => {
    const rng = createRng(555);
    const attacker = { attack: 7, critChance: 0, critDamage: 0 };
    const rolls = [];
    for (let i = 0; i < 30; i += 1) {
      const target = { hp: 1000, maxHp: 1000, defense: 0, alive: true, dodge: 50 };
      rolls.push(resolveAttack(attacker, target, rng).dodged);
    }
    return rolls;
  };

  const a = sequence();
  assert.deepEqual(a, sequence(), 'dodges must be reproducible from the seed');
  assert.equal(new Set(a).size, 2, '30 rolls at 50% must mix evades and hits');
});

// ---------- 13. the level-up pause ----------
test('reaching the xp threshold pauses the run; spending the point resumes it', () => {
  const game = createGame({ data: GAME_DATA, seed: 4242 });
  const enemy = game.enemies[0];
  enemy.hp = 1; // one hit kills
  enemy.xp = game.player.xpToNext; // guarantees a level on the kill
  const step = placePlayerNextTo(game, enemy);

  playerAction(game, { type: 'move', dx: step.dx, dy: step.dy });

  assert.equal(enemy.alive, false, 'test setup: the hit must be lethal');
  assert.equal(game.status, GameStatus.LEVEL_UP, 'gaining a level must pause the run');
  assert.equal(game.player.level, 2);
  assert.equal(game.player.pointsUnspent, POINTS_PER_LEVEL, 'a level hands out its whole pool');

  const maxHpBefore = game.player.maxHp;
  assert.equal(applyLevelUpPoint(game, 'maxHp'), true);
  assert.equal(game.player.maxHp, maxHpBefore + 10, '+HP must raise maxHp');
  assert.equal(game.player.pointsUnspent, POINTS_PER_LEVEL - 1);
  assert.equal(game.status, GameStatus.LEVEL_UP, 'the run stays paused while points remain');

  // Only the LAST point lifts the pause, so the whole pool must be spendable.
  while (game.player.pointsUnspent > 0) {
    assert.equal(applyLevelUpPoint(game, 'attack'), true, 'each remaining point is spendable');
  }
  assert.equal(game.player.pointsUnspent, 0);
  assert.equal(game.status, GameStatus.PLAYING, 'spending the last point resumes the run');

  assert.equal(applyLevelUpPoint(game, 'maxHp'), false, 'no points remain once resumed');
});

test('a level-up blocks play while its points are unspent', () => {
  const game = createGame({ data: GAME_DATA, seed: 4242 });
  game.player.pointsUnspent = 1;
  game.status = GameStatus.LEVEL_UP;

  const before = `${game.player.x},${game.player.y}`;
  const events = playerAction(game, { type: 'move', dx: 1, dy: 0 });

  assert.equal(events.length, 0, 'a paused level-up must ignore actions');
  assert.equal(`${game.player.x},${game.player.y}`, before, 'and must not move the player');
  assert.equal(game.status, GameStatus.LEVEL_UP, 'and must stay paused');
});

test('a level distributes exactly 3 stat points, and stacked levels stack the pool', () => {
  // The requirement is 3 points per level, so the constant itself is pinned: every
  // other test reads it, which would silently follow it back down to 1.
  assert.equal(POINTS_PER_LEVEL, 3, 'the run must be owed 3 stat points per level');

  const game = createGame({ data: GAME_DATA, seed: 4242 });
  const enemy = game.enemies[0];
  enemy.hp = 1; // one hit kills
  // Four thresholds' worth of xp: with a doubling cost the kill crosses two of
  // them (T then 2T) but not the third, so TWO levels are gained at once.
  enemy.xp = game.player.xpToNext * 4;
  const step = placePlayerNextTo(game, enemy);

  playerAction(game, { type: 'move', dx: step.dx, dy: step.dy });

  assert.equal(enemy.alive, false, 'test setup: the hit must be lethal');
  assert.equal(game.player.level, 3, 'test setup: two levels were gained at once');
  assert.equal(
    game.player.pointsUnspent,
    POINTS_PER_LEVEL * 2,
    'each stacked level contributes its own pool',
  );
});

test('a level-up can be postponed: play resumes with every point kept', () => {
  const game = createGame({ data: GAME_DATA, seed: 4242 });
  game.player.pointsUnspent = POINTS_PER_LEVEL;
  game.status = GameStatus.LEVEL_UP;

  assert.equal(deferLevelUp(game), true, 'the pause is lifted');
  assert.equal(game.status, GameStatus.PLAYING, 'the run continues at once');
  assert.equal(game.player.pointsUnspent, POINTS_PER_LEVEL, 'not one point is lost');

  // The postponed pool stays spendable mid-run, and spending one point must not
  // re-pause the run the player just chose to keep playing.
  assert.equal(applyLevelUpPoint(game, 'critChance'), true, 'a postponed point is spendable while playing');
  assert.equal(game.player.pointsUnspent, POINTS_PER_LEVEL - 1);
  assert.equal(game.status, GameStatus.PLAYING, 'spending one never re-pauses the run');
});

test('there is nothing to postpone in a running game, or to spend in a finished one', () => {
  const game = createGame({ data: GAME_DATA, seed: 4242 });
  assert.equal(deferLevelUp(game), false, 'a running game has no pause to lift');
  assert.equal(game.status, GameStatus.PLAYING, 'and its status is untouched');

  game.player.pointsUnspent = POINTS_PER_LEVEL;
  game.status = GameStatus.DEAD;
  assert.equal(applyLevelUpPoint(game, 'attack'), false, 'a finished run rejects the pool');
  assert.equal(game.player.pointsUnspent, POINTS_PER_LEVEL, 'and spends nothing');
});

test('a level-up earned by the LAST enemy survives the level-clear check', () => {
  // Regression: the xp threshold is usually crossed by the killing blow of the
  // final enemy, and the "all enemies dead" status update used to overwrite the
  // LEVEL_UP pause, silently swallowing the level-up.
  const game = createGame({ data: GAME_DATA, seed: 4242 });
  for (const enemy of game.enemies.slice(1)) {
    enemy.alive = false;
    enemy.hp = 0;
  }
  const last = game.enemies[0];
  last.hp = 1; // one hit kills
  last.xp = game.player.xpToNext; // and the kill crosses the xp threshold
  const step = placePlayerNextTo(game, last);

  playerAction(game, { type: 'move', dx: step.dx, dy: step.dy });

  assert.equal(last.alive, false, 'test setup: the last enemy must die');
  assert.equal(
    game.status,
    GameStatus.LEVEL_UP,
    'clearing the level must not swallow the level-up pause',
  );
  assert.equal(game.player.pointsUnspent, POINTS_PER_LEVEL);
  for (let i = 0; i < POINTS_PER_LEVEL; i += 1) {
    assert.equal(applyLevelUpPoint(game, 'maxHp'), true, 'each earned point must be spendable');
  }
  assert.equal(game.status, GameStatus.PLAYING, 'spending them all resumes the cleared level');
});

test('a level-up point can be spent on ANY stat in LEVEL_STATS', () => {
  // The requirement is that every stat is distributable, not just the original
  // HP/ATK/DEF trio, so drive each entry of the shared table.
  for (const stat of LEVEL_STATS) {
    const game = createGame({ data: GAME_DATA, seed: 4242 });
    game.player.pointsUnspent = 1;
    game.status = GameStatus.LEVEL_UP;
    const before = game.player[stat.key] || 0;
    const hpBefore = game.player.hp;
    const poolBefore = stat.fills ? game.player[stat.fills] : null;

    assert.equal(applyLevelUpPoint(game, stat.key), true, `${stat.key} must be spendable`);
    assert.ok(game.player[stat.key] > before, `${stat.key} must increase`);
    if (stat.fills) {
      assert.ok(
        game.player[stat.fills] > poolBefore,
        `${stat.key} must also raise its live pool (${stat.fills})`,
      );
    } else {
      assert.equal(game.player.hp, hpBefore, `${stat.key} must not heal`);
    }
    assert.equal(game.player.pointsUnspent, 0);
    assert.equal(game.status, GameStatus.PLAYING, 'spending the last point resumes the run');
  }
});

test('a capped percentage stat stops at its cap instead of exceeding 100', () => {
  const game = createGame({ data: GAME_DATA, seed: 4242 });
  const dodge = LEVEL_STATS.find((stat) => stat.key === 'dodge');
  game.player.dodge = dodge.cap; // already at the cap
  game.player.pointsUnspent = 1;
  game.status = GameStatus.LEVEL_UP;

  assert.equal(applyLevelUpPoint(game, 'dodge'), true, 'the point is still accepted');
  assert.equal(game.player.dodge, dodge.cap, 'dodge must not grow past its cap');
  assert.equal(game.player.pointsUnspent, 0, 'and the point is consumed');
});

test('an unknown stat is rejected and does not consume the point', () => {
  const game = createGame({ data: GAME_DATA, seed: 4242 });
  game.player.pointsUnspent = 1;
  game.status = GameStatus.LEVEL_UP;

  assert.equal(applyLevelUpPoint(game, 'mana'), false, 'a stat outside LEVEL_STATS is rejected');
  assert.equal(game.player.pointsUnspent, 1, 'a rejected stat must not spend the point');
  assert.equal(game.status, GameStatus.LEVEL_UP);
});
