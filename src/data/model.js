/**
 * The canonical GameData model.
 *
 * GameData is the ONLY shape the rules engine may consume. Raw parsed JSON must
 * never reach src/core: adapters (JSON today, Excel/DB later) funnel through
 * schema.js, which validates and rebuilds the data field by field from a
 * whitelist, then hands it to createGameData() to be frozen.
 *
 * Building field by field (never spreading raw input) also blocks
 * `__proto__`/`constructor` key pollution, and freezing turns an accidental
 * mutation in gameplay code into a loud strict-mode failure instead of silent
 * state drift between the model and the renderer.
 */

export const DATA_VERSION = 1;

/**
 * Deep-freeze a plain object/array graph.
 *
 * Idempotent: freezing an already-frozen value is a no-op. There is deliberately
 * NO early return for an already-frozen value — `Object.freeze` is shallow, so a
 * frozen parent can still hold mutable children (e.g. one created by
 * `Object.freeze({ a: { b: 1 } })`). Trusting the outer flag left those children
 * writable and silently mutable, which is exactly the state drift freezing is
 * supposed to prevent; every child is therefore visited unconditionally.
 *
 * Our model has no cycles: it is reassembled from primitive fields by
 * createGameData/validateGameData, so a plain recursion terminates. A WeakSet
 * guard was considered and rejected — it would allocate on every load to cover a
 * shape the whitelist rebuild cannot produce.
 *
 * @template T
 * @param {T} value
 * @returns {T} the same value, frozen
 */
export function freezeGameData(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) {
    freezeGameData(value[key]);
  }
  return Object.freeze(value);
}

/**
 * Assemble the canonical GameData shape and freeze it.
 *
 * Only the documented keys are copied, so extra keys present on the inputs are
 * dropped here even if a caller skipped validation. Callers should prefer
 * validateGameData(), which normalizes values before reaching this function.
 *
 * @param {object} spec
 * @param {number} spec.dataVersion
 * @param {object} spec.map     {width, height, minRooms, maxRooms, minRoomSize, maxRoomSize, roomPlacementAttempts}
 * @param {object} spec.view    {tileSize}
 * @param {number|null} spec.seed
 * @param {object} spec.player  {id, kind, name, glyph, maxHp, maxMana, attack, defense, critChance, critDamage, luck, dodge, intelligence, spritePath}
 * @param {object} spec.enemies {archetypes: {[id]: {name, glyph, maxHp, maxMana, attack, defense, xp, critChance, critDamage, dodge, intelligence, spritePath}}, spawn: [{archetype, count}]}
 * @param {object} [spec.bosses] {archetypes: {[id]: {name, glyph, maxHp, maxMana, attack, defense, xp, critChance, critDamage, dodge, intelligence, spritePath}}} — absent means an empty roster
 * @param {object} [spec.items]  {definitions: {[id]: {name, glyph, slot, attack, defense, maxHp, maxMana, critChance, critDamage, luck, dodge, intelligence, spritePath}}} — absent means an empty catalog
 * @param {object[]} [spec.loot] [{enemy, item, chance}] — absent means no drops
 * @param {object} [spec.biomas] {[_id]: spritePath} — flat tile-sprite map; absent means no biome sprites (the renderer draws the colored tiles)
 * @returns {Readonly<object>} a deep-frozen GameData
 */
export function createGameData({ dataVersion, map, view, seed, player, enemies, bosses, items, loot, biomas }) {
  // The archetype field copy is identical for the enemy and boss rosters, so it
  // lives in one place: a field added to the format cannot land in one roster
  // and silently go missing from the other.
  const archetypeFields = (archetype) => ({
    name: archetype.name,
    glyph: archetype.glyph,
    maxHp: archetype.maxHp,
    maxMana: archetype.maxMana,
    attack: archetype.attack,
    defense: archetype.defense,
    xp: archetype.xp,
    critChance: archetype.critChance,
    critDamage: archetype.critDamage,
    dodge: archetype.dodge,
    intelligence: archetype.intelligence,
    // Presentation-only metadata, normalized to null so every archetype carries
    // the same keys and the renderer reads it without an `??` guard.
    spritePath: archetype.spritePath ?? null,
  });
  const archetypes = Object.fromEntries(
    Object.entries(enemies.archetypes).map(([id, archetype]) => [id, archetypeFields(archetype)]),
  );
  // `bosses` is optional: a source without that section yields an empty roster,
  // so `data.bosses.archetypes` is always a real (possibly empty) map.
  const bossArchetypes = Object.fromEntries(
    Object.entries((bosses ?? { archetypes: {} }).archetypes).map(([id, archetype]) => [
      id,
      archetypeFields(archetype),
    ]),
  );
  // `items`/`loot` are optional the same way `bosses` is: an absent section
  // yields an empty catalog/table, never `undefined`, so gameplay code can read
  // `data.items.definitions` and `data.loot` unconditionally.
  const itemDefinitions = Object.fromEntries(
    Object.entries((items ?? { definitions: {} }).definitions).map(([id, item]) => [
      id,
      {
        name: item.name,
        glyph: item.glyph,
        slot: item.slot,
        attack: item.attack,
        defense: item.defense,
        maxHp: item.maxHp,
        maxMana: item.maxMana,
        critChance: item.critChance,
        critDamage: item.critDamage,
        luck: item.luck,
        dodge: item.dodge,
        intelligence: item.intelligence,
        spritePath: item.spritePath ?? null,
      },
    ]),
  );

  return freezeGameData({
    dataVersion,
    map: {
      width: map.width,
      height: map.height,
      minRooms: map.minRooms,
      maxRooms: map.maxRooms,
      minRoomSize: map.minRoomSize,
      maxRoomSize: map.maxRoomSize,
      roomPlacementAttempts: map.roomPlacementAttempts,
    },
    // `cols`/`rows` default here too: createGameData is a public barrel export
    // a caller may reach without validateGameData, and a viewport of `undefined`
    // would size the canvas to NaN rather than throw anywhere a caller can read.
    view: {
      tileSize: view.tileSize,
      cols: view.cols ?? 24,
      rows: view.rows ?? 14,
    },
    // Contract: `seed` is never `undefined`; it normalizes to `null`. Applied
    // here too because createGameData is a public barrel export that callers may
    // reach without going through validateGameData/its normalizeSeed().
    seed: seed ?? null,
    player: {
      id: player.id,
      kind: player.kind,
      name: player.name,
      glyph: player.glyph,
      maxHp: player.maxHp,
      maxMana: player.maxMana,
      attack: player.attack,
      defense: player.defense,
      critChance: player.critChance,
      critDamage: player.critDamage,
      luck: player.luck,
      dodge: player.dodge,
      intelligence: player.intelligence,
      spritePath: player.spritePath ?? null,
    },
    enemies: {
      archetypes,
      spawn: enemies.spawn.map((entry) => ({
        archetype: entry.archetype,
        count: entry.count,
      })),
    },
    bosses: {
      archetypes: bossArchetypes,
    },
    items: {
      definitions: itemDefinitions,
    },
    loot: (loot ?? []).map((entry) => ({
      enemy: entry.enemy,
      item: entry.item,
      chance: entry.chance,
    })),
    // `biomas` is a flat id -> path map of PLAIN strings, so the whitelist copy
    // is a fromEntries remap (the ids were already normalized by schema.js).
    // An absent section yields an empty map, never undefined, so the renderer
    // reads `data.biomas.piso1` unguarded.
    biomas: Object.fromEntries(Object.entries(biomas ?? {}).map(([id, path]) => [id, path])),
  });
}
