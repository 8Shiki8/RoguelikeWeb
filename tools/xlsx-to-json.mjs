/**
 * Regenerate the game's data files from the authored Excel workbook.
 *
 * Dev-only and offline: this imports NOTHING outside Node built-ins except the
 * project's own validator and the SHARED workbook reader (`src/data/xlsx.js`),
 * and it is run by hand, never by the browser. The game reads the workbook
 * directly at runtime via src/data/excelSource.js; this CLI stays as the way to
 * produce the committed `data/*.json` fallback.
 *
 * Usage (from the repo root):
 *   node tools/xlsx-to-json.mjs
 *
 * Reads `player-enemies.xlsx` and rewrites `data/player.json` +
 * `data/enemies.json` + `data/bosses.json` + `data/items.json` +
 * `data/loot.json` + `data/biomas.json`, which stay byte-stable for an
 * unchanged workbook. A section the workbook does not declare writes no file at
 * all (writing an empty roster would produce a file the validator rejects) —
 * `data/biomas.json` is the exception: it is always written, because an empty
 * biome map is valid data and the JSON source fetches it unconditionally. The
 * matching exporter lives in tools/xlsx-write.mjs.
 *
 * Paths are resolved against the current working directory (run from the repo
 * root).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { validateGameData } from '../src/data/index.js';
import { readStats } from '../src/data/xlsx.js';

const WORKBOOK_PATH = 'player-enemies.xlsx';
const PLAYER_PATH = 'data/player.json';
const ENEMIES_PATH = 'data/enemies.json';
const BOSSES_PATH = 'data/bosses.json';
const ITEMS_PATH = 'data/items.json';
const LOOT_PATH = 'data/loot.json';
const BIOMAS_PATH = 'data/biomas.json';
const CONFIG_PATH = 'data/config.json';

// --------------------------------------------------------- JSON output ------

/**
 * Join field lines into a 2-space-indented object body. The spritePath line is
 * APPENDED only when the model carries a non-null value (an unfilled workbook
 * cell normalizes to null), so a workbook without filled paths stays
 * byte-identical to the pre-sprite layout.
 */
function objectBody(fields) {
  return fields.map((field, index) => `  ${field}${index < fields.length - 1 ? ',' : ''}`).join('\n');
}

/**
 * Serialize to the exact committed file layout: 2-space indent, the object
 * whitelist in schema order, and the compact one-line spawn entries.
 */
function stringifyPlayer(player) {
  const fields = [
    `"id": ${JSON.stringify(player.id)}`,
    `"kind": ${JSON.stringify(player.kind)}`,
    `"name": ${JSON.stringify(player.name)}`,
    `"glyph": ${JSON.stringify(player.glyph)}`,
    `"maxHp": ${player.maxHp}`,
    `"maxMana": ${player.maxMana}`,
    `"attack": ${player.attack}`,
    `"defense": ${player.defense}`,
    `"critChance": ${player.critChance}`,
    `"critDamage": ${player.critDamage}`,
    `"luck": ${player.luck}`,
    `"dodge": ${player.dodge}`,
    `"intelligence": ${player.intelligence}`,
  ];
  if (player.spritePath != null) fields.push(`"spritePath": ${JSON.stringify(player.spritePath)}`);
  return `{\n${objectBody(fields)}\n}\n`;
}

/**
 * One archetype block, shared by the enemies and bosses serializers so a field
 * can never be emitted in one file and silently dropped from the other. Fields
 * carry NO trailing comma; the caller joins them with the right separators.
 */
function archetypeBody(archetype) {
  const fields = [
    `"name": ${JSON.stringify(archetype.name)}`,
    `"glyph": ${JSON.stringify(archetype.glyph)}`,
    `"maxHp": ${archetype.maxHp}`,
    `"maxMana": ${archetype.maxMana}`,
    `"attack": ${archetype.attack}`,
    `"defense": ${archetype.defense}`,
    `"xp": ${archetype.xp}`,
    `"critChance": ${archetype.critChance}`,
    `"critDamage": ${archetype.critDamage}`,
    `"dodge": ${archetype.dodge}`,
    `"intelligence": ${archetype.intelligence}`,
  ];
  if (archetype.spritePath != null) {
    fields.push(`"spritePath": ${JSON.stringify(archetype.spritePath)}`);
  }
  return fields;
}

function stringifyEnemies(enemies) {
  const lines = ['{', '  "archetypes": {'];
  const ids = Object.keys(enemies.archetypes);
  ids.forEach((id, index) => {
    const archetype = enemies.archetypes[id];
    lines.push(`    ${JSON.stringify(id)}: {`);
    const body = archetypeBody(archetype);
    body.forEach((field, fieldIndex) => {
      lines.push(`      ${field}${fieldIndex < body.length - 1 ? ',' : ''}`);
    });
    lines.push(`    }${index < ids.length - 1 ? ',' : ''}`);
  });
  lines.push('  },');
  lines.push('  "spawn": [');
  enemies.spawn.forEach((entry, index) => {
    const comma = index < enemies.spawn.length - 1 ? ',' : '';
    lines.push(`    { "archetype": ${JSON.stringify(entry.archetype)}, "count": ${entry.count} }${comma}`);
  });
  lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** The boss roster: the same archetype block style, with no spawn table. */
function stringifyBosses(bosses) {
  const lines = ['{', '  "archetypes": {'];
  const ids = Object.keys(bosses.archetypes);
  ids.forEach((id, index) => {
    const archetype = bosses.archetypes[id];
    lines.push(`    ${JSON.stringify(id)}: {`);
    const body = archetypeBody(archetype);
    body.forEach((field, fieldIndex) => {
      lines.push(`      ${field}${fieldIndex < body.length - 1 ? ',' : ''}`);
    });
    lines.push(`    }${index < ids.length - 1 ? ',' : ''}`);
  });
  lines.push('  }');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** The equipment catalog: the same id-keyed block style as the rosters. */
function stringifyItems(items) {
  const lines = ['{', '  "definitions": {'];
  const ids = Object.keys(items.definitions);
  ids.forEach((id, index) => {
    const item = items.definitions[id];
    lines.push(`    ${JSON.stringify(id)}: {`);
    const fields = [
      `"name": ${JSON.stringify(item.name)}`,
      `"glyph": ${JSON.stringify(item.glyph)}`,
      `"slot": ${JSON.stringify(item.slot)}`,
      `"attack": ${item.attack}`,
      `"defense": ${item.defense}`,
      `"maxHp": ${item.maxHp}`,
      `"maxMana": ${item.maxMana}`,
      `"critChance": ${item.critChance}`,
      `"critDamage": ${item.critDamage}`,
      `"luck": ${item.luck}`,
      `"dodge": ${item.dodge}`,
      `"intelligence": ${item.intelligence}`,
    ];
    if (item.spritePath != null) fields.push(`"spritePath": ${JSON.stringify(item.spritePath)}`);
    fields.forEach((field, fieldIndex) => {
      lines.push(`      ${field}${fieldIndex < fields.length - 1 ? ',' : ''}`);
    });
    lines.push(`    }${index < ids.length - 1 ? ',' : ''}`);
  });
  lines.push('  }');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** The biome tile map: a flat id -> spritePath object (`{}` when nothing is filled). */
function stringifyBiomas(biomas) {
  return `${JSON.stringify(biomas, null, 2)}\n`;
}

/** The loot table: compact one-line rows, like the enemies spawn entries. */
function stringifyLoot(loot) {
  const lines = ['['];
  loot.forEach((entry, index) => {
    const comma = index < loot.length - 1 ? ',' : '';
    lines.push(
      `  { "enemy": ${JSON.stringify(entry.enemy)}, "item": ${JSON.stringify(entry.item)}, ` +
        `"chance": ${entry.chance} }${comma}`,
    );
  });
  lines.push(']');
  return `${lines.join('\n')}\n`;
}

// ----------------------------------------------------------------- main -----

// Build everything in memory and validate BEFORE touching disk: a malformed
// workbook must leave data/*.json exactly as they were.
const stats = await readStats(readFileSync(WORKBOOK_PATH));

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
// Validate through the real seam; a DataError propagates and nothing is written.
const data = validateGameData({
  dataVersion: config.dataVersion,
  map: config.map,
  view: config.view,
  seed: config.seed ?? null,
  player: stats.player,
  enemies: stats.enemies,
  bosses: stats.bosses,
  items: stats.items,
  loot: stats.loot,
  biomas: stats.biomas,
});

const written = [PLAYER_PATH, ENEMIES_PATH];
writeFileSync(PLAYER_PATH, stringifyPlayer(data.player));
writeFileSync(ENEMIES_PATH, stringifyEnemies(data.enemies));

// Unlike the roster sections, `biomas` is ALWAYS written: an empty map is valid
// data (no biome sprites yet), and jsonSource fetches this file unconditionally
// — skipping it would leave the JSON fallback with a 404.
writeFileSync(BIOMAS_PATH, stringifyBiomas(data.biomas));
written.push(BIOMAS_PATH);

// A section the workbook does not declare is OMITTED from the raw read, and
// writing it anyway would emit `{}`/`[]` — a shape validateGameData rejects, so
// the next load of data/*.json would fail. Only write what was declared.
if (stats.bosses !== undefined) {
  writeFileSync(BOSSES_PATH, stringifyBosses(data.bosses));
  written.push(BOSSES_PATH);
}
if (stats.items !== undefined) {
  writeFileSync(ITEMS_PATH, stringifyItems(data.items));
  written.push(ITEMS_PATH);
}
if (stats.loot !== undefined) {
  writeFileSync(LOOT_PATH, stringifyLoot(data.loot));
  written.push(LOOT_PATH);
}

console.log(`wrote ${written.join(', ')}`);
