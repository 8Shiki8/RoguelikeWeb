/**
 * Validation and normalization for raw, untrusted game data.
 *
 * The job of this module is to turn whatever an adapter loaded (parsed JSON,
 * an Excel row set, a DB result) into a GameData the engine can trust. It
 * collects EVERY problem before throwing a single DataError, so an author
 * fixing data/*.json sees all issues at once instead of one per reload.
 *
 * The returned object is rebuilt from a whitelist: unknown keys are ignored
 * and can never leak into the model or pollute Object.prototype.
 *
 * Every numeric field is bounded on BOTH ends (see LIMITS). Real data is
 * hand-authored in spreadsheets and eventually in a DB, where a mis-keyed zero
 * or a stray exponent is a normal event; without a ceiling such a value reaches
 * the generator or the renderer and turns into a RangeError (a 10^10-element
 * Uint8Array) or a wedged tab instead of a path-based DataError.
 *
 * The cross-field map invariants in checkMapGeometry() are NECESSARY but not
 * sufficient: a map that validates here can still be too tight for the random
 * room placer on some seeds, and that residual failure is correctly a generator
 * (seed) failure, not invalid data.
 */

import { DATA_VERSION, createGameData } from './model.js';

/**
 * Error raised for invalid game data.
 * `message` is path-based and may contain several newline-separated problems.
 */
export class DataError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DataError';
  }
}

/**
 * Accepted range for every numeric field, so the seam can reject a value before
 * it reaches the generator or the renderer.
 *
 * Where the ceilings come from (they are policy, not physics — 512 is simply
 * "far more than this prototype ever needs", while the canvas budget is derived):
 *  - `width`/`height`/`minRooms`/`maxRooms`/`roomPlacementAttempts`/`tileSize`
 *    keep generation and drawing bounded. A 100000x100000 map would need a 10^10
 *    element `Uint8Array` and a full-tile redraw per frame.
 *  - `maxCanvasDimension` is derived, not guessed: `src/render/canvas.js`
 *    `resize()` sets `canvas.width = map.width * tileSize * deviceScale` with
 *    `deviceScale = Math.min(devicePixelRatio, 2)`, and browsers cap a canvas
 *    dimension at 32767 px. 32767 / 2 = 16383 is therefore the largest product
 *    that cannot overflow the backing store on any device. Because this is a
 *    PRODUCT of two fields it is checked cross-field in checkMapGeometry().
 *  - `maxHp`/`attack`/`defense`/spawn `count` keep combat numbers sane while
 *    still allowing generous values. They must also be INTEGERS: `createEntity`
 *    copies `maxHp` straight into `hp` and `resolveAttack` subtracts damage
 *    without rounding, so a fractional stat would surface as fractional hp in
 *    the HUD. Spawn `count` is a positive integer (>= 1): an archetype without a
 *    spawn count is not part of the random spawn table at all.
 *  - `seed` is the unsigned 32-bit domain of `createRng` (`seed >>> 0`), so a
 *    seed outside it (or a float, which is truncated) would not identify the run.
 *  - `xp`/`critChance`/`critDamage`/`luck`/`dodge`/`intelligence`/`maxMana` are
 *    the progression and combat stats; `itemBonus` is the same ceiling applied to
 *    an item's flat bonus and `lootChance` is a genuine percentage (1..100), so a
 *    loot row always means "this can drop".
 */
export const LIMITS = Object.freeze({
  width: Object.freeze({ min: 1, max: 512 }),
  height: Object.freeze({ min: 1, max: 512 }),
  tileSize: Object.freeze({ min: 1, max: 64 }),
  /**
   * The viewport window, in TILES: the renderer draws a `cols x rows` window
   * centred on the player instead of the whole map, so this — not `map` — is what
   * sets the canvas size and how much of the dungeon the player can see.
   * Ceilings are far above any sane value and only keep a typo from making a
   * canvas the browser cannot allocate.
   */
  viewCols: Object.freeze({ min: 4, max: 128 }),
  viewRows: Object.freeze({ min: 4, max: 128 }),
  minRooms: Object.freeze({ min: 1, max: 64 }),
  maxRooms: Object.freeze({ min: 1, max: 64 }),
  roomPlacementAttempts: Object.freeze({ min: 1, max: 10000 }),
  maxHp: Object.freeze({ min: 1, max: 1000000 }),
  /**
   * The mana pool a combatant can hold. Unlike `maxHp` it may be 0 (a combatant
   * with no magic at all), so it shares the flat ceiling without a floor of 1.
   */
  maxMana: Object.freeze({ min: 0, max: 1000000 }),
  attack: Object.freeze({ min: 0, max: 1000000 }),
  defense: Object.freeze({ min: 0, max: 1000000 }),
  /** Experience an enemy or boss grants when the player kills it. */
  xp: Object.freeze({ min: 0, max: 1000000 }),
  /** Percent chance for a hit to crit. Above 100 is meaningless, so it is capped. */
  critChance: Object.freeze({ min: 0, max: 100 }),
  /** Percent bonus damage on a crit (50 = +50%). */
  critDamage: Object.freeze({ min: 0, max: 1000 }),
  /** Loot-quality/loot-chance stat; only the player reads it. */
  luck: Object.freeze({ min: 0, max: 1000 }),
  /** Percent chance to evade an incoming attack entirely. Above 100 is meaningless, so it is capped. */
  dodge: Object.freeze({ min: 0, max: 100 }),
  /**
   * Placeholder for future spellcasting: nothing in src/core reads it yet, but it
   * is authored and spendable so the level-up points can target it today.
   */
  intelligence: Object.freeze({ min: 0, max: 1000000 }),
  /**
   * The `attack`/`defense`/`maxHp` BONUS an item grants. Bounded from 0 (an item
   * may grant nothing on one axis) and shares the stat ceilings for the top end.
   */
  itemBonus: Object.freeze({ min: 0, max: 1000000 }),
  /** `loot[].chance`; a positive percentage (>= 1), so a row always means something. */
  lootChance: Object.freeze({ min: 1, max: 100 }),
  /** `enemies.spawn[].count`; a positive integer (>= 1) */
  spawnCount: Object.freeze({ min: 1, max: 1000 }),
  seed: Object.freeze({ min: 0, max: 4294967295 }),
  maxCanvasDimension: 16383,
});

/**
 * The only value `player.kind` may take.
 *
 * `src/core/game.js` derives hostility from it (`a.kind !== b.kind`), so any
 * other value silently re-classifies the player as a hostile, which makes every
 * bump against an enemy a no-op and leaves the run unwinnable without a single
 * error. It is validated here because it is a data invariant, not a UI detail.
 */
const PLAYER_KIND = 'player';

/**
 * The equipment slots an item may target, and the complete set of slots the
 * player carries. A slot the renderer/panel does not know would render an item
 * that can never be equipped, so an unknown `slot` is a data error rather than a
 * silently ignored column.
 */
export const ITEM_SLOTS = Object.freeze(['weapon', 'chest', 'belt', 'boots', 'gloves']);

/**
 * `loot[].enemy` wildcard: this row applies to every archetype, not just one.
 * Spelled here (not inline in the source) because the workbook column, the
 * validator's error message and `src/core/loot.js` must agree on the token.
 */
export const ANY_ENEMY = '*';

/**
 * Validate and normalize raw data into a frozen GameData.
 *
 * @param {unknown} raw the raw shape produced by a data source
 * @returns {Readonly<object>} a deep-frozen, validated GameData
 * @throws {DataError} listing every problem found, one per line
 */
export function validateGameData(raw) {
  if (!isPlainObject(raw)) {
    throw new DataError(`<root>: expected a plain object, got ${describe(raw)}`);
  }

  const problems = [];

  const dataVersion = readVersion(problems, raw);
  const mapRaw = section(problems, raw, 'map');
  const viewRaw = section(problems, raw, 'view');
  const playerRaw = section(problems, raw, 'player');
  const enemiesRaw = section(problems, raw, 'enemies');

  const map = mapRaw === null ? null : normalizeMap(problems, mapRaw);
  const view = viewRaw === null ? null : normalizeView(problems, viewRaw);
  // Cross-field checks run only after the per-field map AND view checks above,
  // because one of them (the canvas budget) is a product of map and view fields.
  // Each cross-field rule inside checkMapGeometry re-checks its own inputs and
  // skips itself when one of them is invalid, so an invalid field still yields
  // exactly one problem and never a cascading second line.
  if (map !== null) checkMapGeometry(problems, map, view);
  const seed = normalizeSeed(problems, raw);
  const player = playerRaw === null ? null : normalizePlayer(problems, playerRaw);

  // A roster is only usable for CROSS-SECTION checks when its OWN read added no
  // problem. A section can fail "softly" — normalizeItems/normalizeArchetypes
  // return a well-shaped but EMPTY result for an empty section — and treating
  // that empty result as authoritative would report one real problem followed by
  // a bogus "unknown id" line for every loot row. The problem count delta is what
  // distinguishes "read cleanly" from "read into an empty fallback".
  const beforeEnemies = problems.length;
  const enemies = enemiesRaw === null ? null : normalizeEnemies(problems, enemiesRaw);
  const enemiesValid = enemies !== null && problems.length === beforeEnemies;

  // `bosses` is OPTIONAL: an absent source key (a workbook with no `bosses`
  // sheet) or an explicit null means an empty roster, not an error.
  // A present but malformed section is still reported by path, and a present but
  // EMPTY archetype map is a problem too (see normalizeArchetypes) — "no section"
  // and "an empty section" must not be conflated.
  const bossesRaw = raw.bosses;
  const beforeBosses = problems.length;
  let bosses;
  if (bossesRaw === undefined || bossesRaw === null) {
    bosses = { archetypes: {} };
  } else if (isPlainObject(bossesRaw)) {
    bosses = normalizeBosses(problems, bossesRaw);
  } else {
    problems.push(`bosses: expected a plain object, got ${describe(bossesRaw)}`);
    bosses = null;
  }
  const bossesValid = bosses !== null && problems.length === beforeBosses;

  // `items` and `loot` are OPTIONAL for the same reason `bosses` is: a source
  // (or a workbook) authored before equipment existed must stay loadable, and
  // "no section" is not the same thing as "a broken section". `loot` is checked
  // against the item and archetype ids, and that check is SKIPPED for whichever
  // of those two rosters did not read cleanly (null), so one bad roster produces
  // one problem line instead of a cascade of "unknown id" lines.
  const itemsRaw = raw.items;
  const beforeItems = problems.length;
  let items;
  if (itemsRaw === undefined || itemsRaw === null) {
    items = { definitions: {} };
  } else if (isPlainObject(itemsRaw)) {
    items = normalizeItems(problems, itemsRaw);
  } else {
    problems.push(`items: expected a plain object, got ${describe(itemsRaw)}`);
    items = null;
  }
  const itemsValid = items !== null && problems.length === beforeItems;

  const lootRaw = raw.loot;
  let loot;
  if (lootRaw === undefined || lootRaw === null) {
    loot = [];
  } else if (Array.isArray(lootRaw)) {
    loot = normalizeLoot(
      problems,
      lootRaw,
      itemsValid ? Object.keys(items.definitions) : null,
      enemiesValid && bossesValid
        ? [...Object.keys(enemies.archetypes), ...Object.keys(bosses.archetypes)]
        : null,
    );
  } else {
    problems.push(`loot: expected an array, got ${describe(lootRaw)}`);
    loot = null;
  }

  // `biomas` is OPTIONAL like the other authored-later sections, with one
  // deliberate difference: an EMPTY map is valid. The biome rows exist in the
  // workbook before their sprite paths are filled in by hand, so "no paths yet"
  // must load and fall back to the colored tiles — unlike an empty `items`
  // catalog, which would always be an author mistake.
  const biomasRaw = raw.biomas;
  let biomas;
  if (biomasRaw === undefined || biomasRaw === null) {
    biomas = {};
  } else if (isPlainObject(biomasRaw)) {
    biomas = normalizeBiomas(problems, biomasRaw);
  } else {
    problems.push(`biomas: expected a plain object, got ${describe(biomasRaw)}`);
    biomas = null;
  }

  if (problems.length > 0) {
    throw new DataError(problems.join('\n'));
  }

  return createGameData({ dataVersion, map, view, seed, player, enemies, bosses, items, loot, biomas });
}

/** @returns {boolean} true for a non-null, non-array object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Render a received value inside an error message. */
function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Read and validate a required child section, reporting when it is not an object.
 * @returns {object|null} the section, or null when it was already reported
 */
function section(problems, raw, key) {
  const value = raw[key];
  if (!isPlainObject(value)) {
    problems.push(`${key}: expected a plain object, got ${describe(value)}`);
    return null;
  }
  return value;
}

function readVersion(problems, raw) {
  const value = raw.dataVersion;
  if (value === undefined) {
    problems.push(`dataVersion: missing, expected ${DATA_VERSION}`);
    return undefined;
  }
  if (value !== DATA_VERSION) {
    problems.push(`dataVersion: expected ${DATA_VERSION}, got ${describe(value)}`);
    return undefined;
  }
  return DATA_VERSION;
}

/**
 * Read a required integer inside `[min, max]`.
 *
 * `max` defaults to `Infinity` for the two fields whose ceiling is cross-field
 * rather than absolute (`minRoomSize` and `maxRoomSize`, both capped against the
 * map by checkMapGeometry), so those call sites read like the original ones.
 *
 * Message shape: a value ABOVE the ceiling gets `expected an integer between
 * min and max`, while a wrong type, a non-integer or a value below the floor
 * keeps the historical `expected an integer >= min` prefix and adds the ceiling.
 * The prefix is not cosmetic — tests/fixtures/invalid pins it by substring, and
 * dropping it would turn a data error into a broken test. Every message still
 * states the full accepted range, so an author never has to guess the ceiling.
 *
 * @returns {number|undefined} the value, or undefined when it was invalid
 */
function readInt(problems, container, key, path, min, max = Infinity) {
  const value = container[key];
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  ) {
    return value;
  }

  const overCeiling = max !== Infinity && Number.isInteger(value) && value > max;
  const expected =
    max === Infinity
      ? `expected an integer >= ${min}`
      : overCeiling
        ? `expected an integer between ${min} and ${max}`
        : `expected an integer >= ${min} and <= ${max}`;
  problems.push(`${path}: ${expected}, got ${describe(value)}`);
  return undefined;
}

/**
 * Read a required non-empty string, trimmed.
 * @returns {string|undefined} the trimmed value, or undefined when invalid
 */
function readString(problems, container, key, path) {
  const value = container[key];
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${path}: expected a non-empty string, got ${describe(value)}`);
    return undefined;
  }
  return value.trim();
}

/**
 * Read an OPTIONAL integer inside `[min, max]`.
 *
 * Used for the stats and item bonuses an author MAY declare: a value the author
 * did not write is `0` (absent means "not declared"), because the same data is
 * hand-authored in a spreadsheet where adding a column later must not invalidate
 * every row that predates it. A value that IS present is validated exactly like a
 * required one, so a typo still fails at its own path instead of degrading to 0.
 *
 * `null` is deliberately NOT treated as absent: only `undefined` is. A JSON
 * author who wrote `"xp": null` made a mistake, and hiding it behind a default
 * is exactly the silent-wrong-stat failure the seam exists to prevent.
 *
 * @returns {number} the value, or `fallback` when the key is absent
 */
function readOptionalInt(problems, container, key, path, min, max, fallback = 0) {
  if (container[key] === undefined) return fallback;
  const value = readInt(problems, container, key, path, min, max);
  return value === undefined ? fallback : value;
}

/**
 * Read an OPTIONAL sprite path: absent means "no sprite, draw the glyph", which
 * is the normal state of a workbook whose paths are filled in by hand (or of a
 * workbook authored before sprites existed). A value that IS present must be a
 * non-empty string, validated exactly like a required one, so a typo (a number,
 * a stray null) fails at its own path instead of silently drawing nothing.
 *
 * @returns {string|undefined} the trimmed path, or undefined when absent
 */
function readOptionalSpritePath(problems, container, key, path) {
  if (container[key] === undefined) return undefined;
  return readString(problems, container, key, path);
}

function normalizeMap(problems, raw) {
  const width = readInt(problems, raw, 'width', 'map.width', LIMITS.width.min, LIMITS.width.max);
  const height = readInt(
    problems,
    raw,
    'height',
    'map.height',
    LIMITS.height.min,
    LIMITS.height.max,
  );
  const minRooms = readInt(
    problems,
    raw,
    'minRooms',
    'map.minRooms',
    LIMITS.minRooms.min,
    LIMITS.minRooms.max,
  );
  const maxRooms = readInt(
    problems,
    raw,
    'maxRooms',
    'map.maxRooms',
    LIMITS.maxRooms.min,
    LIMITS.maxRooms.max,
  );
  // No absolute ceiling: minRoomSize is capped against the map, not against a
  // constant, so checkMapGeometry reports it instead (one clear message).
  const minRoomSize = readInt(problems, raw, 'minRoomSize', 'map.minRoomSize', 3);
  // Hidden invariant: maxRoomSize must not be below minRoomSize. When
  // minRoomSize itself was invalid we fall back to its own floor (3) so the
  // author still gets a meaningful message for maxRoomSize. The upper end of
  // maxRoomSize is cross-field too: it must fit inside the map (see below).
  const maxRoomFloor = minRoomSize ?? 3;
  const maxRoomSize = readInt(problems, raw, 'maxRoomSize', 'map.maxRoomSize', maxRoomFloor);
  const roomPlacementAttempts = readInt(
    problems,
    raw,
    'roomPlacementAttempts',
    'map.roomPlacementAttempts',
    LIMITS.roomPlacementAttempts.min,
    LIMITS.roomPlacementAttempts.max,
  );
  return {
    width,
    height,
    minRooms,
    maxRooms,
    minRoomSize,
    maxRoomSize,
    roomPlacementAttempts,
  };
}

/**
 * Cross-field map invariants.
 *
 * `normalizeMap` validates every map field in isolation, but an individually
 * valid set of fields can still be geometrically infeasible. Without this check
 * such a map is accepted at the seam and only blows up later, inside the dungeon
 * generator, as an untyped Error instead of a path-based DataError.
 *
 * None of the conditions below is an exact packing proof — treat them as a cheap
 * feasibility filter rather than a guarantee that the placer will succeed. The
 * real placer (src/map/dungeon.js) draws `w`/`h` from
 * `rng.int(minRoomSize, maxRoomSize)`, then `x`/`y` from
 * `rng.int(ROOM_MARGIN, width - w - ROOM_MARGIN - 1)` /
 * `rng.int(ROOM_MARGIN, height - h - ROOM_MARGIN - 1)`, and rejects any
 * candidate whose box, padded by `ROOM_MARGIN` on all four sides, overlaps an
 * already-placed room:
 *  - A room needs a 1-tile wall border and margin on each side, which is where
 *    the `width - 3` / `height - 3` bounds come from: they keep those placement
 *    ranges non-empty with `x >= 1`, so they are the bound the placer is
 *    GUARANTEED to satisfy (1 border + 1 margin each side, plus the closing
 *    tile). They are conservative rather than exact — a room of exactly
 *    `width - 2` also happens to fit — and deliberately so: rejecting a
 *    barely-fittable map at the seam is a clearer failure than letting the
 *    generator place a room outside the map at some later seed.
 *  - The claim area is `maxRooms * (minRoomSize + 1)^2`: `maxRooms` because that
 *    is the worst case the placer will target, and `(minRoomSize + 1)` per axis
 *    for the 1-tile gap the strict overlap rejection leaves between two rooms.
 *    It is only a NECESSARY lower bound, not an exact packing condition: it
 *    ignores that two neighbouring rooms can share the single gap between them,
 *    and it is expressed against `minRoomSize` because that is the smallest room
 *    the placer can draw.
 *
 * These are necessary, NOT sufficient: a map that passes can still be too tight
 * for the random placer on some seeds. That residual failure is deliberately
 * left to the generator (it is a seed problem, not invalid data), so no further
 * heuristic is added here.
 *
 * No rule cascades: each one skips itself when any of ITS OWN inputs failed its
 * per-field check. An input like `{ minRooms: 0 }` therefore yields exactly one
 * problem for `map.minRooms`, never a redundant second line.
 *
 * @param {object} map normalized map section (fields may be undefined)
 * @param {object|null} view normalized view section, or null when it was missing
 */
function checkMapGeometry(problems, map, view) {
  const { width, height, minRooms, maxRooms, minRoomSize, maxRoomSize } = map;

  // Both ends are individually valid here, but the placer targets
  // `rng.int(minRooms, maxRooms)`, so an inverted range would collapse it.
  if (minRooms !== undefined && maxRooms !== undefined && minRooms > maxRooms) {
    problems.push(`map.minRooms: ${minRooms} must be <= maxRooms (${maxRooms})`);
  }

  // The room-fit rule and the claim rule share this gate (the union of their
  // inputs), so an invalid maxRooms still suppresses the room-size message that
  // depends on it, exactly as the old shared roomCount gate did.
  if (
    width !== undefined &&
    height !== undefined &&
    maxRooms !== undefined &&
    minRoomSize !== undefined
  ) {
    if (minRoomSize > width - 3 || minRoomSize > height - 3) {
      problems.push(
        `map.minRoomSize: a room of ${minRoomSize} cannot fit in this map; ` +
          'a room needs a 1-tile wall border and margin on each side, so ' +
          `minRoomSize must be <= width - 3 (${width - 3}) and <= height - 3 (${height - 3})`,
      );
    }

    const padded = (minRoomSize + 1) * (minRoomSize + 1);
    const claim = maxRooms * padded;
    const available = (width - 1) * (height - 1);
    if (claim > available) {
      problems.push(
        `map.maxRooms: ${maxRooms} rooms of at least ${minRoomSize}x${minRoomSize} ` +
          `need ${claim} cells including the 1-tile gap between rooms, ` +
          `but a ${width}x${height} map only offers ${available}`,
      );
    }
  }

  // A room can be at most `min(width, height) - 3` on its smaller axis, so a
  // larger maxRoomSize cannot be honoured: the placer draws `x`/`y` from
  // `rng.int(1, width - w - 1)`, and once `w` exceeds that bound the range goes
  // empty for most candidates and the run silently falls short of its room
  // target instead. Skipped unless all three inputs are individually valid.
  if (maxRoomSize !== undefined && width !== undefined && height !== undefined) {
    const cap = Math.min(width, height) - 3;
    if (maxRoomSize > cap) {
      problems.push(
        `map.maxRoomSize: ${maxRoomSize} cannot fit in a ${width}x${height} map; ` +
          'a room needs a 1-tile wall border and margin on each side, so ' +
          `maxRoomSize must be <= min(width, height) - 3 (${cap})`,
      );
    }
  }

  // The renderer sizes its backing store from the map AND the tile size, so this
  // budget is cross-field. Skipped unless both map axes and tileSize are valid.
  const tileSize = view === null || view === undefined ? undefined : view.tileSize;
  if (width !== undefined && height !== undefined && tileSize !== undefined) {
    checkCanvasBudget(problems, width, height, tileSize);
  }
}

/**
 * Reject a map/tile combination whose canvas backing store would exceed the
 * browser's maximum dimension.
 *
 * `src/render/canvas.js` `resize()` multiplies by `deviceScale =
 * Math.min(devicePixelRatio, 2)`, so the data-level budget is the limit at the
 * WORST device (a 2x display) — validating against the 1x value would let a
 * config pass on a laptop and blow up on a retina screen. Both axes are reported
 * separately so the author knows which dimension to lower.
 */
function checkCanvasBudget(problems, width, height, tileSize) {
  const max = LIMITS.maxCanvasDimension;
  if (tileSize * width > max) {
    problems.push(
      `view.tileSize: ${tileSize} x map.width ${width} = ${tileSize * width} ` +
        `exceeds the maximum canvas dimension (${max} at devicePixelRatio 2); ` +
        'lower tileSize or the map width',
    );
  }
  if (tileSize * height > max) {
    problems.push(
      `view.tileSize: ${tileSize} x map.height ${height} = ${tileSize * height} ` +
        `exceeds the maximum canvas dimension (${max} at devicePixelRatio 2); ` +
        'lower tileSize or the map height',
    );
  }
}

/**
 * Viewport size in tiles, used when `config.json` declares no `view.cols` /
 * `view.rows`. Both keys were added when the renderer stopped drawing the whole
 * map and started drawing a window centred on the player, so a config authored
 * before that (and every test fixture) must keep loading with the same window
 * the game shipped with.
 */
const VIEW_COLS_DEFAULT = 24;
const VIEW_ROWS_DEFAULT = 14;

function normalizeView(problems, raw) {
  return {
    tileSize: readInt(
      problems,
      raw,
      'tileSize',
      'view.tileSize',
      LIMITS.tileSize.min,
      LIMITS.tileSize.max,
    ),
    // Optional with a default, exactly like the optional stats: absent is the
    // shipped window, a PRESENT value is validated strictly so a typo fails at
    // its own path instead of silently shrinking the world the player can see.
    cols: readOptionalInt(
      problems,
      raw,
      'cols',
      'view.cols',
      LIMITS.viewCols.min,
      LIMITS.viewCols.max,
      VIEW_COLS_DEFAULT,
    ),
    rows: readOptionalInt(
      problems,
      raw,
      'rows',
      'view.rows',
      LIMITS.viewRows.min,
      LIMITS.viewRows.max,
      VIEW_ROWS_DEFAULT,
    ),
  };
}

/**
 * `seed` is optional: absent or null normalizes to null, not undefined.
 *
 * An in-range value must be an INTEGER: `createRng` folds the seed with
 * `seed >>> 0`, so 1.5 and 1 produce byte-identical dungeons while the UI would
 * still show the 1.5 that was typed. A seed that does not identify its run
 * defeats the whole point of having a seed, so it is rejected at the seam.
 */
function normalizeSeed(problems, raw) {
  const value = raw.seed;
  if (value === undefined || value === null) return null;
  const { min, max } = LIMITS.seed;
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  problems.push(`seed: expected an integer between ${min} and ${max} or null, got ${describe(value)}`);
  return null;
}

function normalizePlayer(problems, raw) {
  const id = readString(problems, raw, 'id', 'player.id');
  const kind = readString(problems, raw, 'kind', 'player.kind');
  // Only reported when `kind` was otherwise readable: a missing/differently typed
  // kind already produced the readString problem, and a second line for the same
  // field is exactly the cascade the other cross-field checks avoid.
  if (kind !== undefined && kind !== PLAYER_KIND) {
    problems.push(`player.kind: expected ${JSON.stringify(PLAYER_KIND)}, got ${JSON.stringify(kind)}`);
  }
  return {
    id,
    kind,
    name: readString(problems, raw, 'name', 'player.name'),
    glyph: readString(problems, raw, 'glyph', 'player.glyph'),
    maxHp: readInt(problems, raw, 'maxHp', 'player.maxHp', LIMITS.maxHp.min, LIMITS.maxHp.max),
    maxMana: readOptionalInt(
      problems,
      raw,
      'maxMana',
      'player.maxMana',
      LIMITS.maxMana.min,
      LIMITS.maxMana.max,
    ),
    attack: readInt(problems, raw, 'attack', 'player.attack', LIMITS.attack.min, LIMITS.attack.max),
    defense: readInt(
      problems,
      raw,
      'defense',
      'player.defense',
      LIMITS.defense.min,
      LIMITS.defense.max,
    ),
    critChance: readOptionalInt(
      problems,
      raw,
      'critChance',
      'player.critChance',
      LIMITS.critChance.min,
      LIMITS.critChance.max,
    ),
    critDamage: readOptionalInt(
      problems,
      raw,
      'critDamage',
      'player.critDamage',
      LIMITS.critDamage.min,
      LIMITS.critDamage.max,
    ),
    luck: readOptionalInt(problems, raw, 'luck', 'player.luck', LIMITS.luck.min, LIMITS.luck.max),
    dodge: readOptionalInt(
      problems,
      raw,
      'dodge',
      'player.dodge',
      LIMITS.dodge.min,
      LIMITS.dodge.max,
    ),
    intelligence: readOptionalInt(
      problems,
      raw,
      'intelligence',
      'player.intelligence',
      LIMITS.intelligence.min,
      LIMITS.intelligence.max,
    ),
    spritePath: readOptionalSpritePath(problems, raw, 'spritePath', 'player.spritePath'),
  };
}

function normalizeEnemies(problems, raw) {
  const archetypes = normalizeArchetypes(problems, raw.archetypes, 'enemies');
  const spawn = normalizeSpawn(problems, raw.spawn, archetypes);
  return { archetypes, spawn };
}

/**
 * The boss roster. Same nested shape as `enemies.archetypes` (with no spawn
 * table), so the archetype rules are shared rather than duplicated.
 */
function normalizeBosses(problems, raw) {
  return { archetypes: normalizeArchetypes(problems, raw.archetypes, 'bosses') };
}

/**
 * The equipment catalog. Same nested shape as the archetype rosters (`id` keyed
 * objects validated through the same id rules), but each entry is an item
 * definition rather than a combatant.
 *
 * Bonuses are OPTIONAL and default to 0: most items grant one axis (a weapon
 * grants `attack`, boots grant `defense`), and forcing every row to spell out
 * six zeros would make the workbook unreadable for no gain.
 */
function normalizeItems(problems, raw) {
  const definitionsRaw = raw.definitions;
  if (!isPlainObject(definitionsRaw)) {
    problems.push(`items.definitions: expected a non-empty object, got ${describe(definitionsRaw)}`);
    return { definitions: {} };
  }

  const keys = Object.keys(definitionsRaw);
  if (keys.length === 0) {
    problems.push('items.definitions: expected a non-empty object, got {}');
    return { definitions: {} };
  }

  const entries = [];
  const seenIds = new Map();
  for (const key of keys) {
    // Same trimming/duplicate policy as normalizeArchetypes: a hand-authored
    // sheet must not silently lose an item to a stray space in its id.
    const id = key.trim();
    if (id === '') {
      problems.push(`items.definitions: item id must be a non-empty string, got ${describe(key)}`);
      continue;
    }
    if (seenIds.has(id)) {
      problems.push(
        `items.definitions: duplicate item id ${JSON.stringify(id)} ` +
          `(from ${JSON.stringify(seenIds.get(id))} and ${JSON.stringify(key)}); ` +
          'ids are compared after trimming whitespace',
      );
      continue;
    }
    seenIds.set(id, key);

    const entry = definitionsRaw[key];
    const path = `items.definitions.${id}`;
    if (!isPlainObject(entry)) {
      problems.push(`${path}: expected a plain object, got ${describe(entry)}`);
      continue;
    }

    const slot = readString(problems, entry, 'slot', `${path}.slot`);
    if (slot !== undefined && !ITEM_SLOTS.includes(slot)) {
      problems.push(
        `${path}.slot: unknown slot ${JSON.stringify(slot)} (known: ${ITEM_SLOTS.join(', ')})`,
      );
    }

    entries.push([
      id,
      {
        name: readString(problems, entry, 'name', `${path}.name`),
        glyph: readString(problems, entry, 'glyph', `${path}.glyph`),
        slot,
        attack: readOptionalInt(problems, entry, 'attack', `${path}.attack`, LIMITS.itemBonus.min, LIMITS.itemBonus.max),
        defense: readOptionalInt(problems, entry, 'defense', `${path}.defense`, LIMITS.itemBonus.min, LIMITS.itemBonus.max),
        maxHp: readOptionalInt(problems, entry, 'maxHp', `${path}.maxHp`, LIMITS.itemBonus.min, LIMITS.itemBonus.max),
        maxMana: readOptionalInt(problems, entry, 'maxMana', `${path}.maxMana`, LIMITS.maxMana.min, LIMITS.maxMana.max),
        critChance: readOptionalInt(problems, entry, 'critChance', `${path}.critChance`, LIMITS.critChance.min, LIMITS.critChance.max),
        critDamage: readOptionalInt(problems, entry, 'critDamage', `${path}.critDamage`, LIMITS.critDamage.min, LIMITS.critDamage.max),
        luck: readOptionalInt(problems, entry, 'luck', `${path}.luck`, LIMITS.luck.min, LIMITS.luck.max),
        dodge: readOptionalInt(problems, entry, 'dodge', `${path}.dodge`, LIMITS.dodge.min, LIMITS.dodge.max),
        intelligence: readOptionalInt(
          problems,
          entry,
          'intelligence',
          `${path}.intelligence`,
          LIMITS.intelligence.min,
          LIMITS.intelligence.max,
        ),
        spritePath: readOptionalSpritePath(problems, entry, 'spritePath', `${path}.spritePath`),
      },
    ]);
  }

  return { definitions: Object.fromEntries(entries) };
}

/**
 * The loot table: one row per "when this archetype dies, this item may drop".
 *
 * Cross-field membership is checked like `enemies.spawn` is: an unknown `item`
 * names the known ids, and `enemy` must be a real archetype id or the `ANY_ENEMY`
 * wildcard. Both checks are skipped when the section they depend on failed to
 * validate, so a broken `items`/`enemies` yields its own problem line and not a
 * cascade of "unknown id" lines on top of it.
 *
 * @param {string[]|null} knownItems item ids, or null when `items` did not validate
 * @param {string[]|null} knownArchetypes enemy+boss ids, or null when they did not validate
 */
function normalizeLoot(problems, raw, knownItems, knownArchetypes) {
  const itemList = knownItems === null ? '(unknown)' : knownItems.length > 0 ? knownItems.join(', ') : '(none)';
  const archetypeList =
    knownArchetypes === null ? '(unknown)' : knownArchetypes.length > 0 ? knownArchetypes.join(', ') : '(none)';

  return raw.map((entry, index) => {
    const path = `loot[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${path}: expected a plain object, got ${describe(entry)}`);
      return { enemy: undefined, item: undefined, chance: undefined };
    }

    const item = readString(problems, entry, 'item', `${path}.item`);
    if (item !== undefined && knownItems !== null && !knownItems.includes(item)) {
      problems.push(`${path}.item: unknown item ${JSON.stringify(item)} (known: ${itemList})`);
    }

    const enemy = readString(problems, entry, 'enemy', `${path}.enemy`);
    if (
      enemy !== undefined &&
      enemy !== ANY_ENEMY &&
      knownArchetypes !== null &&
      !knownArchetypes.includes(enemy)
    ) {
      problems.push(
        `${path}.enemy: unknown archetype ${JSON.stringify(enemy)} ` +
          `(known: ${archetypeList}; or ${JSON.stringify(ANY_ENEMY)} for any)`,
      );
    }

    const chance = readInt(
      problems,
      entry,
      'chance',
      `${path}.chance`,
      LIMITS.lootChance.min,
      LIMITS.lootChance.max,
    );
    return { enemy, item, chance };
  });
}

/**
 * The biome tile map: a flat `id -> spritePath` object (`{ "piso1":
 * "assets/..." }`), validated id-by-id.
 *
 * An empty map is valid (see the `biomas` branch in validateGameData), but a
 * PRESENT value must be a non-empty string: the workbook reader never emits an
 * empty path, so one that arrives here came from a hand-edited JSON and names
 * its own key in the error.
 */
function normalizeBiomas(problems, raw) {
  const entries = [];
  const seenIds = new Map();
  for (const key of Object.keys(raw)) {
    const id = key.trim();
    if (id === '') {
      problems.push(`biomas: biome id must be a non-empty string, got ${describe(key)}`);
      continue;
    }
    if (seenIds.has(id)) {
      problems.push(
        `biomas: duplicate biome id ${JSON.stringify(id)} ` +
          `(from ${JSON.stringify(seenIds.get(id))} and ${JSON.stringify(key)}); ` +
          'ids are compared after trimming whitespace',
      );
      continue;
    }
    seenIds.set(id, key);
    entries.push([id, readString(problems, raw, key, `biomas.${id}`)]);
  }
  return Object.fromEntries(entries);
}

/**
 * @param {string} prefix section name used in every message path:
 *   `'enemies'` or `'bosses'`
 */
function normalizeArchetypes(problems, raw, prefix) {
  if (!isPlainObject(raw)) {
    problems.push(`${prefix}.archetypes: expected a non-empty object, got ${describe(raw)}`);
    return {};
  }

  const keys = Object.keys(raw);
  if (keys.length === 0) {
    problems.push(`${prefix}.archetypes: expected a non-empty object, got {}`);
    return {};
  }

  // Build through an entries array + Object.fromEntries: assigning an untrusted
  // key directly (e.g. "__proto__") would mutate the prototype instead.
  const entries = [];
  // Maps a normalized id to the original key it came from, so a collision can
  // name both spellings. Without this, `{ rat: ..., ' rat': ... }` — the classic
  // hand-authored-spreadsheet mistake — silently collapses to one archetype and
  // one enemy disappears from the spawn table with no error anywhere.
  const seenIds = new Map();
  for (const key of keys) {
    // The raw key is trimmed exactly once, here; every later use reads `id`.
    const id = key.trim();
    if (id === '') {
      problems.push(`${prefix}.archetypes: archetype id must be a non-empty string, got ${describe(key)}`);
      continue;
    }
    if (seenIds.has(id)) {
      problems.push(
        `${prefix}.archetypes: duplicate archetype id ${JSON.stringify(id)} ` +
          `(from ${JSON.stringify(seenIds.get(id))} and ${JSON.stringify(key)}); ` +
          'ids are compared after trimming whitespace',
      );
      continue; // keep the first definition; the duplicate is a reported error
    }
    seenIds.set(id, key);

    const entry = raw[key];
    const path = `${prefix}.archetypes.${id}`;
    if (!isPlainObject(entry)) {
      problems.push(`${path}: expected a plain object, got ${describe(entry)}`);
      continue;
    }
    entries.push([
      id,
      {
        name: readString(problems, entry, 'name', `${path}.name`),
        glyph: readString(problems, entry, 'glyph', `${path}.glyph`),
        maxHp: readInt(problems, entry, 'maxHp', `${path}.maxHp`, LIMITS.maxHp.min, LIMITS.maxHp.max),
        maxMana: readOptionalInt(
          problems,
          entry,
          'maxMana',
          `${path}.maxMana`,
          LIMITS.maxMana.min,
          LIMITS.maxMana.max,
        ),
        attack: readInt(
          problems,
          entry,
          'attack',
          `${path}.attack`,
          LIMITS.attack.min,
          LIMITS.attack.max,
        ),
        defense: readInt(
          problems,
          entry,
          'defense',
          `${path}.defense`,
          LIMITS.defense.min,
          LIMITS.defense.max,
        ),
        xp: readOptionalInt(problems, entry, 'xp', `${path}.xp`, LIMITS.xp.min, LIMITS.xp.max),
        critChance: readOptionalInt(
          problems,
          entry,
          'critChance',
          `${path}.critChance`,
          LIMITS.critChance.min,
          LIMITS.critChance.max,
        ),
        critDamage: readOptionalInt(
          problems,
          entry,
          'critDamage',
          `${path}.critDamage`,
          LIMITS.critDamage.min,
          LIMITS.critDamage.max,
        ),
        dodge: readOptionalInt(problems, entry, 'dodge', `${path}.dodge`, LIMITS.dodge.min, LIMITS.dodge.max),
        intelligence: readOptionalInt(
          problems,
          entry,
          'intelligence',
          `${path}.intelligence`,
          LIMITS.intelligence.min,
          LIMITS.intelligence.max,
        ),
        spritePath: readOptionalSpritePath(problems, entry, 'spritePath', `${path}.spritePath`),
      },
    ]);
  }

  return Object.fromEntries(entries);
}

function normalizeSpawn(problems, raw, archetypes) {
  if (!Array.isArray(raw)) {
    problems.push(`enemies.spawn: expected an array, got ${describe(raw)}`);
    return [];
  }

  const known = Object.keys(archetypes);
  const knownList = known.length > 0 ? known.join(', ') : '(none)';

  return raw.map((entry, index) => {
    const path = `enemies.spawn[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${path}: expected a plain object, got ${describe(entry)}`);
      return { archetype: undefined, count: undefined };
    }

    const archetype = readString(problems, entry, 'archetype', `${path}.archetype`);
    if (
      archetype !== undefined &&
      !Object.prototype.hasOwnProperty.call(archetypes, archetype)
    ) {
      problems.push(
        `${path}.archetype: unknown archetype ${JSON.stringify(archetype)} (known: ${knownList})`,
      );
    }
    const count = readInt(
      problems,
      entry,
      'count',
      `${path}.count`,
      LIMITS.spawnCount.min,
      LIMITS.spawnCount.max,
    );
    return { archetype, count };
  });
}
