/**
 * Export the authored game data to an Excel workbook a human can edit.
 *
 * Dev-only and offline: this imports NOTHING outside Node built-ins. It is a
 * build step run by hand, never by the browser and never by the game, which
 * keeps loading the generated `data/*.json` at runtime.
 *
 * Usage (from the repo root):
 *   node tools/xlsx-write.mjs
 *
 * Reads `data/player.json` + `data/enemies.json` + `data/bosses.json` +
 * `data/items.json` + `data/loot.json` + `data/biomas.json` (tolerated as
 * missing on the first run that introduces the `biomas` sheet), writes
 * `player-enemies.xlsx`.
 * Faithful export: values are copied verbatim, never invented or repaired. The
 * matching importer lives in tools/xlsx-to-json.mjs.
 *
 * ROUND-TRIP WARNING: the workbook is rebuilt from the JSON files, so any edit
 * made by hand in Excel survives only until this tool runs again. After filling
 * `spritePath` cells in the workbook, run `node tools/xlsx-to-json.mjs` BEFORE
 * any future `xlsx-write` run, or the paths are wiped.
 *
 * An .xlsx is an OPC (ZIP) package, so the container is written by hand with
 * `node:zlib`. Strings are written as inline strings (`t="inlineStr"`), which
 * keeps the writer and the reader independent; see xlsx-to-json.mjs for the
 * formats Excel produces when it re-saves the file.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const PLAYER_PATH = 'data/player.json';
const ENEMIES_PATH = 'data/enemies.json';
const BOSSES_PATH = 'data/bosses.json';
const ITEMS_PATH = 'data/items.json';
const LOOT_PATH = 'data/loot.json';
const BIOMAS_PATH = 'data/biomas.json';
const WORKBOOK_PATH = 'player-enemies.xlsx';

const PLAYER_SHEET = 'player';
const ENEMIES_SHEET = 'enemies';
const BOSSES_SHEET = 'bosses';
const ITEMS_SHEET = 'items';
const LOOT_SHEET = 'loot';
const BIOMAS_SHEET = 'biomas';

const PLAYER_HEADERS = ['id', 'kind', 'name', 'glyph', 'maxHp', 'maxMana', 'attack', 'defense', 'critChance', 'critDamage', 'luck', 'dodge', 'intelligence', 'spritePath'];
const ENEMIES_HEADERS = ['id', 'name', 'glyph', 'maxHp', 'maxMana', 'attack', 'defense', 'xp', 'critChance', 'critDamage', 'dodge', 'intelligence', 'count', 'spritePath'];
// No `count`: a boss is never drawn from the random spawn table.
const BOSSES_HEADERS = ['id', 'name', 'glyph', 'maxHp', 'maxMana', 'attack', 'defense', 'xp', 'critChance', 'critDamage', 'dodge', 'intelligence', 'spritePath'];
const ITEMS_HEADERS = ['id', 'name', 'glyph', 'slot', 'attack', 'defense', 'maxHp', 'maxMana', 'critChance', 'critDamage', 'luck', 'dodge', 'intelligence', 'spritePath'];
const LOOT_HEADERS = ['enemy', 'item', 'chance'];
const BIOMAS_HEADERS = ['id', 'spritePath'];

// The biome rows the writer ALWAYS emits (the `biomas` sheet is authored as a
// fixed pair: wall look + floor look). A key in data/biomas.json outside this
// list is refused rather than silently dropped — a faithful export must never
// lose an authored value.
const BIOMAS_ROWS = ['pared1', 'piso1'];

// `spritePath` is written as an empty string when the model carries no path
// (null), which is the state the reader skips: an empty cell means "draw the
// glyph/tile". So the round trip JSON -> workbook -> JSON is stable both before
// and after the paths are filled in by hand.
const spriteCell = (value) => asText(value ?? '');

// `loot[].enemy` wildcard; it must match src/data/schema.js's ANY_ENEMY. The
// literal is repeated rather than imported because this tool deliberately has
// no dependency on src/ (see the module header).
const ANY_ENEMY = '*';

// ---------------------------------------------------------------- CRC32 -----

/** Standard ZIP CRC-32 (IEEE 802.3), required by every entry header. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------ ZIP -----

// Fixed DOS timestamp (2020-01-01 00:00:00) so repeated exports are byte-stable:
// re-running the tool cannot dirty the file just by changing the clock.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/**
 * Build a ZIP archive (deflate, no data descriptors) from `{name, data}` pairs.
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const compressed = deflateRawSync(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // method
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16); // central directory offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, end]);
}

// ------------------------------------------------------------------ XML -----

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    n -= 1;
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return letters;
}

/** @param {{kind:'string'|'number', value:string|number}} cell */
function cellXml(cell, column, row) {
  const ref = `${columnLetter(column)}${row}`;
  if (cell.kind === 'number') {
    return `<c r="${ref}"><v>${cell.value}</v></c>`;
  }
  // xml:space="preserve" keeps leading/trailing spaces visible in Excel.
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`;
}

/** @param {{kind:'string'|'number', value:string|number}[][]} rows */
function sheetXml(rows) {
  const body = rows
    .map((cells, rowIndex) => {
      const r = rowIndex + 1;
      const cols = cells.map((cell, colIndex) => cellXml(cell, colIndex, r)).join('');
      return `<row r="${r}">${cols}</row>`;
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData>` +
    '</worksheet>'
  );
}

const asText = (value) => ({ kind: 'string', value });
const asNumber = (value) => ({ kind: 'number', value });

function worksheetPart(index) {
  return `xl/worksheets/sheet${index}.xml`;
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet5.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet6.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

function workbookXml() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    `<sheet name="${PLAYER_SHEET}" sheetId="1" r:id="rId1"/>` +
    `<sheet name="${ENEMIES_SHEET}" sheetId="2" r:id="rId2"/>` +
    `<sheet name="${BOSSES_SHEET}" sheetId="3" r:id="rId3"/>` +
    `<sheet name="${ITEMS_SHEET}" sheetId="4" r:id="rId4"/>` +
    `<sheet name="${LOOT_SHEET}" sheetId="5" r:id="rId5"/>` +
    `<sheet name="${BIOMAS_SHEET}" sheetId="6" r:id="rId6"/>` +
    '</sheets>' +
    '</workbook>'
  );
}

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
  '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>' +
  '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet5.xml"/>' +
  '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet6.xml"/>' +
  '</Relationships>';

// ----------------------------------------------------------------- main -----

const player = JSON.parse(readFileSync(PLAYER_PATH, 'utf8'));
const enemies = JSON.parse(readFileSync(ENEMIES_PATH, 'utf8'));
const bosses = JSON.parse(readFileSync(BOSSES_PATH, 'utf8'));
const items = JSON.parse(readFileSync(ITEMS_PATH, 'utf8'));
const loot = JSON.parse(readFileSync(LOOT_PATH, 'utf8'));
// Tolerated as MISSING (unlike the files above): the first export that
// introduces the `biomas` sheet runs before data/biomas.json exists, and the
// round trip is xlsx-write -> xlsx-to-json, which then creates it.
const biomas = existsSync(BIOMAS_PATH) ? JSON.parse(readFileSync(BIOMAS_PATH, 'utf8')) : {};

// The sheet is a fixed-pair by design (see BIOMAS_ROWS): a key that is not one
// of them would be dropped by this writer, so refuse instead of losing it.
for (const key of Object.keys(biomas)) {
  if (!BIOMAS_ROWS.includes(key)) {
    throw new Error(
      `data/biomas.json has unknown biome id "${key}" (the writer only exports: ${BIOMAS_ROWS.join(', ')})`,
    );
  }
}

// The sheet has one row per archetype carrying that archetype's spawn count, so
// every archetype needs exactly one spawn entry and vice versa. Refuse to guess
// a count: writing one would be inventing a value.
const countByArchetype = new Map(enemies.spawn.map((entry) => [entry.archetype, entry.count]));
for (const id of Object.keys(enemies.archetypes)) {
  if (!countByArchetype.has(id)) {
    throw new Error(`enemies.spawn has no count for archetype "${id}"; cannot export a faithful count`);
  }
}
for (const entry of enemies.spawn) {
  if (!Object.prototype.hasOwnProperty.call(enemies.archetypes, entry.archetype)) {
    throw new Error(`enemies.spawn references unknown archetype "${entry.archetype}"`);
  }
}

// Same reasoning for the loot table: a row pointing at an item or an archetype
// that does not exist would be written into the workbook as a dangling
// reference, so refuse to export it instead of shipping a workbook that the
// reader/validator rejects.
for (const entry of loot) {
  if (!Object.prototype.hasOwnProperty.call(items.definitions, entry.item)) {
    throw new Error(`loot references unknown item "${entry.item}"`);
  }
  const known =
    entry.enemy === ANY_ENEMY ||
    Object.prototype.hasOwnProperty.call(enemies.archetypes, entry.enemy) ||
    Object.prototype.hasOwnProperty.call(bosses.archetypes, entry.enemy);
  if (!known) {
    throw new Error(`loot references unknown archetype "${entry.enemy}"`);
  }
}

const playerRows = [
  PLAYER_HEADERS.map(asText),
  [
    asText(player.id),
    asText(player.kind),
    asText(player.name),
    asText(player.glyph),
    asNumber(player.maxHp),
    asNumber(player.maxMana),
    asNumber(player.attack),
    asNumber(player.defense),
    asNumber(player.critChance),
    asNumber(player.critDamage),
    asNumber(player.luck),
    asNumber(player.dodge),
    asNumber(player.intelligence),
    spriteCell(player.spritePath),
  ],
];

const enemyRows = [
  ENEMIES_HEADERS.map(asText),
  ...Object.keys(enemies.archetypes).map((id) => {
    const archetype = enemies.archetypes[id];
    return [
      asText(id),
      asText(archetype.name),
      asText(archetype.glyph),
      asNumber(archetype.maxHp),
      asNumber(archetype.maxMana),
      asNumber(archetype.attack),
      asNumber(archetype.defense),
      asNumber(archetype.xp),
      asNumber(archetype.critChance),
      asNumber(archetype.critDamage),
      asNumber(archetype.dodge),
      asNumber(archetype.intelligence),
      asNumber(countByArchetype.get(id)),
      spriteCell(archetype.spritePath),
    ];
  }),
];

// No count column: a boss is spawned by src/core's level-5 branch, not from the
// random spawn table, so there is nothing to count.
const bossRows = [
  BOSSES_HEADERS.map(asText),
  ...Object.keys(bosses.archetypes).map((id) => {
    const archetype = bosses.archetypes[id];
    return [
      asText(id),
      asText(archetype.name),
      asText(archetype.glyph),
      asNumber(archetype.maxHp),
      asNumber(archetype.maxMana),
      asNumber(archetype.attack),
      asNumber(archetype.defense),
      asNumber(archetype.xp),
      asNumber(archetype.critChance),
      asNumber(archetype.critDamage),
      asNumber(archetype.dodge),
      asNumber(archetype.intelligence),
      spriteCell(archetype.spritePath),
    ];
  }),
];

const itemRows = [
  ITEMS_HEADERS.map(asText),
  ...Object.keys(items.definitions).map((id) => {
    const item = items.definitions[id];
    return [
      asText(id),
      asText(item.name),
      asText(item.glyph),
      asText(item.slot),
      asNumber(item.attack),
      asNumber(item.defense),
      asNumber(item.maxHp),
      asNumber(item.maxMana),
      asNumber(item.critChance),
      asNumber(item.critDamage),
      asNumber(item.luck),
      asNumber(item.dodge),
      asNumber(item.intelligence),
      spriteCell(item.spritePath),
    ];
  }),
];

const lootRows = [
  LOOT_HEADERS.map(asText),
  ...loot.map((entry) => [asText(entry.enemy), asText(entry.item), asNumber(entry.chance)]),
];

// Both rows are ALWAYS written (an empty spritePath cell is what the reader
// skips, so a fresh export ships the structure and no paths — exactly the
// state the author starts from).
const biomasRows = [
  BIOMAS_HEADERS.map(asText),
  ...BIOMAS_ROWS.map((id) => [asText(id), spriteCell(biomas[id])]),
];

const workbook = zip([
  { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
  { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
  { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(), 'utf8') },
  { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS, 'utf8') },
  { name: worksheetPart(1), data: Buffer.from(sheetXml(playerRows), 'utf8') },
  { name: worksheetPart(2), data: Buffer.from(sheetXml(enemyRows), 'utf8') },
  { name: worksheetPart(3), data: Buffer.from(sheetXml(bossRows), 'utf8') },
  { name: worksheetPart(4), data: Buffer.from(sheetXml(itemRows), 'utf8') },
  { name: worksheetPart(5), data: Buffer.from(sheetXml(lootRows), 'utf8') },
  { name: worksheetPart(6), data: Buffer.from(sheetXml(biomasRows), 'utf8') },
]);

writeFileSync(WORKBOOK_PATH, workbook);
console.log(`wrote ${WORKBOOK_PATH} (${workbook.length} bytes)`);
