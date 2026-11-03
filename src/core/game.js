/**
 * The rules engine. Owns turn order and state transitions, and knows nothing
 * about Canvas or the DOM (per AGENTS.md: gameplay logic must stay independent
 * of rendering).
 *
 * Turn order is explicit and sequential: the player acts once, then every
 * living enemy acts once, in list order. Nothing here is driven by animation
 * frames or timers.
 */

import { isWalkable } from '../map/tiles.js';
import { centerOf, createDungeon, randomFloorInRoom } from '../map/dungeon.js';
import { createEntity, entityAt } from '../entities/entity.js';
import { planEnemyAction } from '../entities/enemy.js';
import { resolveAttack } from './combat.js';
import { createRng } from './rng.js';
import { rollLoot } from './loot.js';
import { createEquipment } from './equipment.js';

export const GameStatus = Object.freeze({
  PLAYING: 'playing',
  DEAD: 'dead',
  CLEARED: 'cleared',
  LEVEL_UP: 'level-up',
  VICTORY: 'victory',
});

const LOG_LIMIT = 200;

/**
 * The stats a level-up point may be spent on, in panel order.
 *
 * This is the SINGLE source of truth for the level-up UI and for
 * `applyLevelUpPoint`: the panel renders one button per entry, `onKey` maps one
 * hotkey per entry, and the spend path reads `amount`/`cap` from here — so
 * making a new stat distributable is one line in this table and nothing else.
 *
 * `amount` is the gain per point; `fills` names the live pool that rises with the
 * ceiling (maxHp refills hp, maxMana refills mana) so a point never leaves the
 * pool looking short; `cap` (when set) is the highest value the stat may reach by
 * spending, so a percentage stat cannot be pushed past 100. The hotkey is only
 * live while the level-up prompt is open, where movement is disabled.
 */
export const LEVEL_STATS = Object.freeze([
  Object.freeze({ key: 'maxHp', short: 'HP', label: 'Max HP', hotkey: 'h', amount: 10, fills: 'hp', cap: null }),
  Object.freeze({ key: 'maxMana', short: 'MP', label: 'Max mana', hotkey: 'm', amount: 10, fills: 'mana', cap: null }),
  Object.freeze({ key: 'attack', short: 'ATK', label: 'Attack', hotkey: 'a', amount: 1, fills: null, cap: null }),
  Object.freeze({ key: 'defense', short: 'DEF', label: 'Defense', hotkey: 'd', amount: 1, fills: null, cap: null }),
  Object.freeze({ key: 'critChance', short: 'CRIT', label: 'Crit chance', hotkey: 'c', amount: 5, fills: null, cap: 100 }),
  Object.freeze({ key: 'critDamage', short: 'CDMG', label: 'Crit damage', hotkey: 'x', amount: 10, fills: null, cap: null }),
  Object.freeze({ key: 'dodge', short: 'DODGE', label: 'Dodge', hotkey: 'v', amount: 3, fills: null, cap: 75 }),
  Object.freeze({ key: 'luck', short: 'LUCK', label: 'Luck', hotkey: 'l', amount: 1, fills: null, cap: null }),
  Object.freeze({ key: 'intelligence', short: 'INT', label: 'Intelligence', hotkey: 'i', amount: 1, fills: null, cap: null }),
]);

/**
 * Points granted each time a level is gained. A kill that crosses two xp
 * thresholds adds this once per loop iteration of checkLevelUp, so a double
 * level-up pays out twice.
 */
export const POINTS_PER_LEVEL = 3;

/**
 * Build a playable run from validated GameData + a seed.
 * @param {{data:object, seed:number, level?:number}} spec `data` is the frozen GameData from src/data
 */
export function createGame({ data, seed, level = 1 }) {
  const rng = createRng(seed ^ (level * 131542391));
  const bossLevel = level >= 5;
  const map = createDungeon(data.map, rng, { boss: bossLevel });

  const spawn = centerOf(map.rooms[0]);
  const player = createEntity({ ...data.player, x: spawn.x, y: spawn.y });
  // Only the player carries a bag and worn gear. They live on the run rather
  // than on createEntity's generic shape, and they survive a descent: descending
  // keeps this same player object.
  player.inventory = [];
  player.equipment = createEquipment();
  const entities = [player];

  const enemies = [];
  if (bossLevel) {
    const bossArchetype = data.bosses.archetypes.boss;
    if (bossArchetype) {
      const spot = findSpawnSpotBoss(map, rng, entities);
      if (spot) {
        const enemy = createEntity({
          ...bossArchetype,
          archetypeId: 'boss',
          kind: 'boss',
          x: spot.x,
          y: spot.y,
        });
        enemies.push(enemy);
        entities.push(enemy);
      }
    }
  } else {
    for (const entry of spawnTable(data.enemies)) {
      const archetype = data.enemies.archetypes[entry.archetype];
      if (!archetype) {
        throw new Error(`Unknown enemy archetype "${entry.archetype}"`);
      }
      for (let i = 0; i < entry.count; i += 1) {
        const spot = findSpawnSpot(map, rng, entities);
        if (!spot) continue;
        const enemy = createEntity({
          ...archetype,
          archetypeId: entry.archetype,
          kind: 'enemy',
          x: spot.x,
          y: spot.y,
        });
        enemies.push(enemy);
        entities.push(enemy);
      }
    }
  }

  const game = {
    seed,
    dataVersion: data.dataVersion,
    rng,
    map,
    player,
    enemies,
    entities,
    // Loot waiting on the floor: `{item, x, y}` per drop. Kept off `entities`
    // because items do not block movement and are never attacked.
    groundItems: [],
    status: GameStatus.PLAYING,
    turn: 0,
    log: [],
    target: null,
    level,
    _data: data,
  };

  game.log.push({ type: 'run-start', seed, dataVersion: data.dataVersion, map, enemyCount: enemies.length, level });
  return game;
}

function spawnTable(enemiesData) {
  return enemiesData.spawn ?? [];
}

function findSpawnSpot(map, rng, entities) {
  const isTaken = (x, y) => entityAt(entities, x, y) !== null;
  const rooms = [map.rooms[map.rooms.length - 1], ...map.rooms.slice(1, -1)];
  for (const room of rooms) {
    const spot = randomFloorInRoom(map, room, rng, isTaken);
    if (spot) return spot;
  }
  return null;
}

function findSpawnSpotBoss(map, rng, entities) {
  const isTaken = (x, y) => entityAt(entities, x, y) !== null;
  if (map.rooms.length > 1) {
    const room = map.rooms[map.rooms.length - 1];
    const spot = randomFloorInRoom(map, room, rng, isTaken);
    if (spot) return spot;
  }
  return randomFloorInRoom(map, map.rooms[0], rng, isTaken);
}

function isHostile(a, b) {
  return a.kind !== b.kind;
}

export function playerAction(game, action) {
  if (game.status !== GameStatus.PLAYING) return [];
  if (game.status === GameStatus.LEVEL_UP) return [];

  const events = [];
  const { consumedTurn } = resolveAction(game, game.player, action, events);

  if (consumedTurn) {
    game.turn += 1;
    events.push({ type: 'turn', turn: game.turn });
    if (game.status === GameStatus.PLAYING) runEnemyTurns(game, events);
    checkStairs(game, events);
  }

  appendLog(game, events);
  return events;
}

export function runEnemyTurns(game, events) {
  for (const enemy of game.enemies) {
    if (game.status !== GameStatus.PLAYING) break;
    if (!enemy.alive) continue;
    const action = planEnemyAction(game, enemy);
    resolveAction(game, enemy, action, events);
  }
}

function checkStairs(game, events) {
  if (game.status !== GameStatus.PLAYING) return;
  if (game.map.stairs) {
    if (game.player.x === game.map.stairs.x && game.player.y === game.map.stairs.y) {
      descendStairs(game, events);
    }
  }
}

function descendStairs(game, events) {
  if (game.level >= 5) {
    game.status = GameStatus.VICTORY;
    events.push({ type: 'gameover', winner: 'player', victory: true });
    return;
  }
  const newLevel = game.level + 1;
  events.push({ type: 'descend', level: newLevel });
  const seed = game.rng.seed;
  const rng = createRng(seed ^ (newLevel * 131542391));
  const bossLevel = newLevel >= 5;
  const map = createDungeon(game._data.map, rng, { boss: bossLevel });
  game.map = map;
  game.level = newLevel;
  const spawn = centerOf(map.rooms[0]);
  game.player.x = spawn.x;
  game.player.y = spawn.y;
  game.turn = 0;
  game.target = null;
  game.enemies = [];
  game.entities = [game.player];
  // Floor items belong to the level that spawned them; the bag and the worn gear
  // stay with the hero (same player object, so there is nothing to copy here).
  game.groundItems = [];
  if (bossLevel) {
    const bossArchetype = game._data.bosses.archetypes.boss;
    if (bossArchetype) {
      const spot = findSpawnSpotBoss(map, rng, game.entities);
      if (spot) {
        const enemy = createEntity({
          ...bossArchetype,
          archetypeId: 'boss',
          kind: 'boss',
          x: spot.x,
          y: spot.y,
        });
        game.enemies.push(enemy);
        game.entities.push(enemy);
      }
    }
  } else {
    for (const entry of spawnTable(game._data.enemies)) {
      const archetype = game._data.enemies.archetypes[entry.archetype];
      if (!archetype) continue;
      for (let i = 0; i < entry.count; i += 1) {
        const spot = findSpawnSpot(map, rng, game.entities);
        if (!spot) continue;
        const enemy = createEntity({
          ...archetype,
          archetypeId: entry.archetype,
          kind: 'enemy',
          x: spot.x,
          y: spot.y,
        });
        game.enemies.push(enemy);
        game.entities.push(enemy);
      }
    }
  }
  game.rng = rng;
  game.log.push({ type: 'level', level: newLevel });
}

function resolveAction(game, actor, action, events) {
  if (!actor.alive) return { consumedTurn: false };
  if (game.status !== GameStatus.PLAYING && game.status !== GameStatus.LEVEL_UP) return { consumedTurn: false };

  if (action.type === 'wait') {
    events.push({ type: 'wait', actor });
    return { consumedTurn: true };
  }

  if (action.type === 'attack') {
    return resolveDirectedAttack(game, actor, action, events);
  }

  if (action.type !== 'move') return { consumedTurn: false };

  const dx = Math.sign(action.dx);
  const dy = Math.sign(action.dy);
  if (dx === 0 && dy === 0) return { consumedTurn: false };
  if (dx !== 0 && dy !== 0) return { consumedTurn: false };

  const from = { x: actor.x, y: actor.y };
  const to = { x: actor.x + dx, y: actor.y + dy };

  if (!isWalkable(game.map, to.x, to.y)) {
    events.push({ type: 'blocked', actor, reason: 'wall' });
    return { consumedTurn: false };
  }

  const occupant = entityAt(game.entities, to.x, to.y);
  if (occupant) {
    if (!isHostile(actor, occupant)) {
      events.push({ type: 'blocked', actor, reason: 'occupied' });
      return { consumedTurn: false };
    }
    return applyAttack(game, actor, occupant, events);
  }

  actor.x = to.x;
  actor.y = to.y;
  events.push({ type: 'move', actor, from, to });
  // Stepping onto loot picks it up. Only the player collects; a foe walking over
  // a drop leaves it for the hero.
  if (actor === game.player) pickupAt(game, to, events);
  return { consumedTurn: true };
}

function resolveDirectedAttack(game, actor, action, events) {
  const dx = Math.sign(action.dx);
  const dy = Math.sign(action.dy);
  const target = entityAt(game.entities, actor.x + dx, actor.y + dy);

  if (!target || !isHostile(actor, target)) {
    events.push({ type: 'blocked', actor, reason: 'empty' });
    return { consumedTurn: true };
  }

  return applyAttack(game, actor, target, events);
}

function applyAttack(game, actor, target, events) {
  const result = resolveAttack(actor, target, game.rng);
  events.push({ type: 'attack', actor, target, ...result });

  if (actor === game.player) {
    game.target = target.alive ? target : null;
    if (!target.alive) {
      dropLoot(game, target, events);
      if (target.xp) {
        game.player.xp = (game.player.xp || 0) + target.xp;
        checkLevelUp(game, events);
      }
    }
  }

  updateStatus(game, events);
  return { consumedTurn: true };
}

/**
 * Roll the dead archetype's loot and lay every drop on the floor at its cell.
 *
 * Items are dropped, never granted: the hero still has to step on them (pickup
 * is part of the movement action), and a lucky find can never silently rewrite
 * the stats mid-fight by auto-equipping.
 */
function dropLoot(game, enemy, events) {
  const drops = rollLoot(game._data.loot, enemy.archetypeId, game.player.luck || 0, game.rng);
  for (const item of drops) {
    game.groundItems.push({ item, x: enemy.x, y: enemy.y });
    events.push({ type: 'drop', actor: enemy, item, name: itemName(game, item) });
  }
}

/** Collect every ground item on a cell the player just stepped onto. */
function pickupAt(game, position, events) {
  const here = game.groundItems.filter(
    (ground) => ground.x === position.x && ground.y === position.y,
  );
  if (here.length === 0) return;

  game.groundItems = game.groundItems.filter(
    (ground) => ground.x !== position.x || ground.y !== position.y,
  );
  for (const ground of here) {
    game.player.inventory.push(ground.item);
    events.push({ type: 'pickup', item: ground.item, name: itemName(game, ground.item) });
  }
}

/** The display name for an item id, falling back to the id itself. */
function itemName(game, itemId) {
  const definition = game._data.items.definitions[itemId];
  return definition ? definition.name : itemId;
}

function checkLevelUp(game, events) {
  while ((game.player.xp || 0) >= (game.player.xpToNext || 50)) {
    game.player.xp = (game.player.xp || 0) - (game.player.xpToNext || 50);
    game.player.level = (game.player.level || 1) + 1;
    game.player.xpToNext = (game.player.xpToNext || 50) * 2;
    game.player.pointsUnspent = (game.player.pointsUnspent || 0) + POINTS_PER_LEVEL;
    game.status = GameStatus.LEVEL_UP;
    events.push({ type: 'levelup', level: game.player.level });
  }
}

function updateStatus(game, events) {
  if (game.status !== GameStatus.PLAYING && game.status !== GameStatus.LEVEL_UP) return;
  if (!game.player.alive) {
    game.status = GameStatus.DEAD;
    events.push({ type: 'gameover', winner: 'enemies' });
    return;
  }

  // Felling the boss ends the run and takes precedence over a pending level-up:
  // the run is over, so there is nothing left to spend the points on.
  if (game.level >= 5 && game.enemies.some((e) => e.kind === 'boss' && !e.alive)) {
    game.status = GameStatus.VICTORY;
    events.push({ type: 'gameover', winner: 'player', victory: true });
    return;
  }

  // Everything else leaves the status alone. In particular, "all enemies dead"
  // on levels 1-4 must NOT reset a LEVEL_UP pause: the xp threshold is often
  // crossed by the killing blow of the LAST enemy, and clearing that pause here
  // silently swallowed the level-up. `applyLevelUpPoint` resumes play (status
  // PLAYING) once the points are spent, and the player then walks to the stairs.
}

function appendLog(game, events) {
  game.log.push(...events);
  if (game.log.length > LOG_LIMIT) {
    game.log.splice(0, game.log.length - LOG_LIMIT);
  }
}

export function isOver(game) {
  return game.status !== GameStatus.PLAYING && game.status !== GameStatus.LEVEL_UP;
}

/**
 * Postpone the level-up pause: play resumes while the points stay unspent, and
 * the dialog can be reopened later (panel hint / N key), so nothing is lost by
 * walking away from the prompt.
 * @returns {boolean} true when a pause was actually lifted.
 */
export function deferLevelUp(game) {
  if (game.status !== GameStatus.LEVEL_UP) return false;
  game.status = GameStatus.PLAYING;
  return true;
}

export function applyLevelUpPoint(game, stat) {
  // Points are spendable during the pause AND while playing a postponed
  // level-up; every other status (dead, victory, ...) still rejects them.
  if (game.status !== GameStatus.PLAYING && game.status !== GameStatus.LEVEL_UP) return false;
  if (!game.player.pointsUnspent || game.player.pointsUnspent < 1) return false;

  const definition = LEVEL_STATS.find((entry) => entry.key === stat);
  if (!definition) return false;

  const current = game.player[definition.key] || 0;
  const raised =
    definition.cap == null ? current + definition.amount : Math.min(definition.cap, current + definition.amount);
  const gained = raised - current;
  game.player[definition.key] = raised;
  if (definition.fills && gained > 0) game.player[definition.fills] += gained;

  game.player.pointsUnspent -= 1;
  // The pause only lifts for the last point, and only while paused: a point
  // spent on a postponed level-up must not touch the status.
  if (game.player.pointsUnspent === 0 && game.status === GameStatus.LEVEL_UP) game.status = GameStatus.PLAYING;
  return true;
}