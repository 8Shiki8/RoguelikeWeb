/**
 * Entities are plain data: position, identity and combat stats.
 * They hold NO behaviour, so rules stay in src/core and rendering stays in
 * src/render. `spritePath` is presentation-only metadata: carried here so the
 * renderer can find the sprite without asking core for anything.
 */

let nextEntityId = 1;

/**
 * @param {object} spec
 * @returns {object} a live entity
 */
export function createEntity({
  kind,
  name,
  glyph,
  x,
  y,
  maxHp,
  attack,
  defense,
  id = null,
  xp = 0,
  critChance = 0,
  critDamage = 0,
  luck = 0,
  dodge = 0,
  intelligence = 0,
  maxMana = 0,
  archetypeId = null,
  spritePath = null,
  facing = 1,
}) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Entity ${name} needs grid coordinates`);
  }
  if (maxHp <= 0) {
    throw new Error(`Entity ${name} needs a positive maxHp`);
  }

  return {
    id: id ?? `${kind}:${nextEntityId++}`,
    kind, // 'player' | 'enemy' | 'boss'
    // The archetype this actor was built from, so the loot table can be
    // consulted by id when it dies (names are display-only and not unique).
    archetypeId,
    name,
    glyph,
    // Authored sprite path (or null = draw the glyph). Never read by core.
    spritePath: spritePath ?? null,
    facing: typeof facing === 'number' ? facing : 1,
    x,
    y,
    hp: maxHp,
    maxHp,
    // The mana pool mirrors hp/maxHp: `mana` is the current value (starts full)
    // and `maxMana` the ceiling. Nothing consumes mana yet — spells are future
    // work — but every entity carries both so the panel reads them unguarded.
    mana: maxMana || 0,
    maxMana: maxMana || 0,
    attack,
    defense,
    alive: true,
    xp: xp || 0,
    // Combat stats provided by the data layer. Every entity carries all of them so
    // combat and UI never need an undefined guard; an archetype that does not
    // declare one (e.g. enemies have no `luck`) simply reads 0.
    critChance: critChance || 0,
    critDamage: critDamage || 0,
    luck: luck || 0,
    dodge: dodge || 0,
    // Reserved for future spellcasting: nothing reads it yet, but carrying it here
    // keeps every entity shaped alike and makes the stat spendable at level-up.
    intelligence: intelligence || 0,
    level: 1,
    xpToNext: 50,
    pointsUnspent: 0,
  };
}

/** @returns {object|null} the living entity occupying a cell. */
export function entityAt(entities, x, y) {
  return (
    entities.find((entity) => entity.alive && entity.x === x && entity.y === y) ?? null
  );
}

/** @returns {boolean} true when the entity can still act. */
export function isAlive(entity) {
  return entity.alive && entity.hp > 0;
}

/** Snapshot used by events so the UI can report post-action numbers. */
export function snapshot(entity) {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    glyph: entity.glyph,
    x: entity.x,
    y: entity.y,
    hp: entity.hp,
    maxHp: entity.maxHp,
    attack: entity.attack,
    defense: entity.defense,
    alive: entity.alive,
  };
}