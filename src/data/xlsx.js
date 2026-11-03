/**
 * The single .xlsx reader, shared by the browser and the dev tool.
 *
 * Environment-agnostic by design: it imports NEITHER `node:zlib` NOR `node:fs`
 * and touches no DOM. ZIP entry 8 is inflated with the platform
 * `DecompressionStream('deflate-raw')`, which Node 22 and browsers both expose,
 * so the exact same code runs in the page and under `node --test`.
 *
 * The reader is written for the file a HUMAN saves from Excel, not just for the
 * one tools/xlsx-write.mjs produces. Excel re-saves an .xlsx with a shared
 * string table, sparse rows (cells are omitted, not written empty), `t="str"`
 * values, rich-text runs and XML entities, so all of those are handled here.
 *
 * `readStats` is pure and read-only: it returns the objects that go into
 * `data/player.json`, `data/enemies.json`, `data/bosses.json`, `data/items.json`,
 * `data/loot.json` and `data/biomas.json`, and lets schema.js decide whether
 * they are valid. The `bosses`, `items`, `loot` and `biomas` sheets are OPTIONAL
 * — a workbook without one simply yields no such key — while the `player` and
 * `enemies` sheets are required.
 */

const WORKBOOK_PATH = 'player-enemies.xlsx';

const PLAYER_SHEET = 'player';
const ENEMIES_SHEET = 'enemies';
const BOSSES_SHEET = 'bosses';
const ITEMS_SHEET = 'items';
const LOOT_SHEET = 'loot';
const BIOMAS_SHEET = 'biomas';

// Required columns. A sheet missing one of these is a broken sheet and is
// rejected by name, because the column carries the identity of the row.
const PLAYER_HEADERS = ['id', 'kind', 'name', 'glyph', 'maxHp', 'attack', 'defense'];
const ENEMIES_HEADERS = ['id', 'name', 'glyph', 'maxHp', 'attack', 'defense', 'count'];
// No `count`: a boss is never drawn from the random spawn table (src/core spawns
// it from its own level-5 branch), so a count column would have no meaning.
const BOSSES_HEADERS = ['id', 'name', 'glyph', 'maxHp', 'attack', 'defense'];
const ITEMS_HEADERS = ['id', 'name', 'glyph', 'slot'];
const LOOT_HEADERS = ['enemy', 'item', 'chance'];

// OPTIONAL columns: the progression/combat stats that were added to the
// spreadsheet later. The tests/fixtures/*.xlsx workbooks were authored before
// these columns existed and cannot be regenerated here, so a sheet WITHOUT them
// must keep loading — the reader then omits the key and schema.js defaults it to
// 0. A column that IS present is read strictly, so a typo fails at its cell
// instead of silently becoming a zero.
const PLAYER_OPTIONAL_HEADERS = ['maxMana', 'critChance', 'critDamage', 'luck', 'dodge', 'intelligence'];
const ARCHETYPE_OPTIONAL_HEADERS = ['maxMana', 'xp', 'critChance', 'critDamage', 'dodge', 'intelligence'];
const ITEM_OPTIONAL_HEADERS = ['attack', 'defense', 'maxHp', 'maxMana', 'critChance', 'critDamage', 'luck', 'dodge', 'intelligence'];

// `spritePath` is a PATH, not a stat, so it gets its own optional-string reader
// (see readOptionalStringCell) rather than joining the int lists above. It is
// optional for the same reason they are: a workbook authored before sprites
// existed must keep loading, and the renderer falls back to the glyph.
const SPRITE_HEADER = 'spritePath';

// ------------------------------------------------------------------ ZIP -----

/**
 * Normalize the accepted byte inputs so callers need not convert. A Node
 * `Buffer` IS a `Uint8Array`, so it flows through the first branch untouched.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} input
 * @returns {Uint8Array}
 */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new Error(
    `${WORKBOOK_PATH}: expected workbook bytes (Uint8Array or ArrayBuffer), got ${typeof input}`,
  );
}

/**
 * Inflate one raw-deflate (ZIP method 8) entry with the platform stream.
 * @param {Uint8Array} compressed
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(compressed) {
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read every entry of a ZIP archive into `name -> Uint8Array`.
 * Supports stored (method 0) and deflated (method 8) entries; sizes come from
 * the central directory, so optional data descriptors are irrelevant.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} input
 * @returns {Promise<Map<string, Uint8Array>>}
 */
async function unzip(input) {
  const bytes = toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset) => view.getUint16(offset, true);
  const u32 = (offset) => view.getUint32(offset, true);
  const text = (start, end) => new TextDecoder().decode(bytes.subarray(start, end));

  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (u32(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(`${WORKBOOK_PATH}: not a ZIP archive (no end-of-central-directory record)`);
  }

  const count = u16(eocd + 10);
  let cursor = u32(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i += 1) {
    if (u32(cursor) !== 0x02014b50) {
      throw new Error(`${WORKBOOK_PATH}: corrupt ZIP central directory at byte ${cursor}`);
    }
    const method = u16(cursor + 10);
    const compressedSize = u32(cursor + 20);
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    const name = text(cursor + 46, cursor + 46 + nameLength);

    if (u32(localOffset) !== 0x04034b50) {
      throw new Error(`${WORKBOOK_PATH}: corrupt ZIP local header for "${name}"`);
    }
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) {
      data = compressed.slice();
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      throw new Error(
        `${WORKBOOK_PATH}: unsupported ZIP compression method ${method} for "${name}"`,
      );
    }
    entries.set(name, data);

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// ------------------------------------------------------------------ XML -----

/** Decode a UTF-8 byte slice into a string (no `Buffer.toString`). */
const decodeUtf8 = (bytes) => new TextDecoder().decode(bytes);

/** Decode the five predefined XML entities plus numeric character references. */
function decodeXml(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, (match, entity) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(
          entity[1] === 'x' || entity[1] === 'X'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10),
        );
    }
  });
}

/** Parse the attributes of an XML start tag into a plain object. */
function parseAttributes(text) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

/** Concatenate every `<t>...</t>` run in `xml` (rich-text runs included). */
function collectTextRuns(xml) {
  let out = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    out += decodeXml(match[1]);
  }
  return out;
}

/** The raw text of the first `<v>...</v>` in `xml`, or '' when absent. */
function extractValue(xml) {
  const match = xml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  return match ? decodeXml(match[1]) : '';
}

/** Column index of a cell reference like "C2" -> 2 (zero-based). */
function columnIndexFromRef(ref) {
  const letters = ref.match(/^[A-Za-z]+/);
  if (!letters) return null;
  let index = 0;
  for (const ch of letters[0].toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * Parse a sheet into rows of `{ column, ref, value }` cells, where `value` is a
 * string (numbers keep their textual form and are parsed later).
 */
function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowAttrs = parseAttributes(rowMatch[1]);
    const inner = rowMatch[2] ?? '';
    const rowNumber = rowAttrs.r ? Number(rowAttrs.r) : rows.length + 1;

    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    let fallbackColumn = 0;
    while ((cellMatch = cellRe.exec(inner)) !== null) {
      const attrs = parseAttributes(cellMatch[1]);
      const body = cellMatch[2] ?? '';
      // The column comes from `r`, never from position, so a row with skipped
      // cells stays aligned with the header row.
      const column = attrs.r ? columnIndexFromRef(attrs.r) : fallbackColumn;
      if (column === null) {
        throw new Error(`${WORKBOOK_PATH}: cell without a usable "r" reference in row ${rowNumber}`);
      }
      fallbackColumn = column + 1;
      cells.push({
        column,
        ref: attrs.r ?? null,
        value: readCellValue(attrs, body, sharedStrings, rowNumber, column),
      });
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
}

function readCellValue(attrs, body, sharedStrings, rowNumber, column) {
  const type = attrs.t;
  if (type === 's') {
    const raw = extractValue(body);
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) {
      throw new Error(
        `${WORKBOOK_PATH}: shared string index ${JSON.stringify(raw)} out of range at ` +
          `${cellRef(column, rowNumber)}`,
      );
    }
    return sharedStrings[index];
  }
  if (type === 'inlineStr') {
    // One or more <t> runs inside <is>; concatenate them all.
    return collectTextRuns(body);
  }
  if (type === 'str') {
    return extractValue(body);
  }
  // No `t` (or "n"): a number sits in <v>.
  return extractValue(body);
}

/** "D3" for column 3, row 3 — used in error messages. */
function cellRef(column, row) {
  let n = column + 1;
  let letters = '';
  while (n > 0) {
    n -= 1;
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return `${letters}${row}`;
}

/** Resolve a relationship target (relative to `baseDir`) into an archive path. */
function resolveTarget(baseDir, target) {
  const segments = (target.startsWith('/') ? [] : baseDir.split('/')).concat(target.split('/'));
  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/**
 * Map each sheet NAME to its worksheet archive path via workbook.xml and
 * workbook.xml.rels. Sheet order is never assumed to match file order.
 * @returns {Map<string, string>}
 */
function sheetPaths(entries) {
  const workbook = entries.get('xl/workbook.xml');
  if (!workbook) throw new Error(`${WORKBOOK_PATH}: missing xl/workbook.xml`);
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  if (!rels) throw new Error(`${WORKBOOK_PATH}: missing xl/_rels/workbook.xml.rels`);

  const targetById = new Map();
  const relRe = /<Relationship\b([^>]*?)\/?>/g;
  let relMatch;
  while ((relMatch = relRe.exec(decodeUtf8(rels))) !== null) {
    const attrs = parseAttributes(relMatch[1]);
    if (attrs.Id && attrs.Target) {
      targetById.set(attrs.Id, resolveTarget('xl', attrs.Target));
    }
  }

  const paths = new Map();
  const sheetRe = /<sheet\b([^>]*?)\/?>/g;
  let sheetMatch;
  while ((sheetMatch = sheetRe.exec(decodeUtf8(workbook))) !== null) {
    const attrs = parseAttributes(sheetMatch[1]);
    const relId = attrs['r:id'];
    if (!attrs.name || !relId || !targetById.has(relId)) {
      throw new Error(`${WORKBOOK_PATH}: sheet "${attrs.name ?? '?'}" has no resolvable target`);
    }
    paths.set(attrs.name, targetById.get(relId));
  }

  return paths;
}

function readSharedStrings(entries) {
  const part = entries.get('xl/sharedStrings.xml');
  if (!part) return [];
  const xml = decodeUtf8(part);
  const strings = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let match;
  while ((match = siRe.exec(xml)) !== null) {
    strings.push(match[1] === undefined ? '' : collectTextRuns(match[1]));
  }
  return strings;
}

// -------------------------------------------------------- sheet reading -----

function cellMap(row) {
  const map = new Map();
  for (const cell of row.cells) map.set(cell.column, cell.value);
  return map;
}

/** A row is data only if it carries at least one non-empty cell. */
function isBlankRow(row) {
  return row.cells.every((cell) => cell.value.trim() === '');
}

/**
 * Map header names to column indexes from row 1, failing on a missing/renamed
 * required header.
 */
function headerColumns(sheetName, headerRow, required) {
  const columns = new Map();
  for (const cell of headerRow.cells) {
    columns.set(cell.value.trim(), cell.column);
  }
  for (const name of required) {
    if (!columns.has(name)) {
      throw new Error(
        `${sheetName}!1: missing required column ${JSON.stringify(name)} ` +
          `(row 1 headers: ${[...columns.keys()].map((h) => JSON.stringify(h)).join(', ')})`,
      );
    }
  }
  return columns;
}

/**
 * Read a stat cell as an integer, reporting the sheet, cell and offending value.
 * A numeric cell arrives as "20"; a cell Excel stored as text arrives as "six".
 */
function readIntCell(sheetName, columns, row, columnName, cellMapForRow) {
  const column = columns.get(columnName);
  const ref = `${sheetName}!${cellRef(column, row.rowNumber)}`;
  const raw = cellMapForRow.get(column);
  const value = raw === undefined ? '' : raw;
  if (!/^-?\d+$/.test(value.trim())) {
    throw new Error(`${ref}: ${columnName} must be an integer, got ${JSON.stringify(value)}`);
  }
  return Number(value.trim());
}

function readStringCell(sheetName, columns, row, columnName, cellMapForRow) {
  const column = columns.get(columnName);
  const ref = `${sheetName}!${cellRef(column, row.rowNumber)}`;
  const raw = cellMapForRow.get(column);
  const value = raw === undefined ? '' : raw;
  if (value.trim() === '') {
    throw new Error(`${ref}: ${columnName} must not be empty`);
  }
  return value.trim();
}

/**
 * Read an OPTIONAL integer column, or `undefined` when the sheet has no such
 * column at all.
 *
 * "No column" means the author did not declare this stat (an older workbook),
 * which is not a data error. "A column with a typo" still is, and is reported by
 * cell exactly like a required column — the distinction is the whole reason this
 * helper exists rather than defaulting a bad cell to 0.
 */
function readOptionalIntCell(sheetName, columns, row, columnName, cellMapForRow) {
  if (!columns.has(columnName)) return undefined;
  return readIntCell(sheetName, columns, row, columnName, cellMapForRow);
}

/**
 * Read an OPTIONAL string column, or `undefined` when the sheet declares no
 * such column OR the cell is empty.
 *
 * `spritePath` is authored last and filled in by hand, so an empty cell is the
 * NORMAL state, not an error: it means "no sprite, draw the glyph". A cell that
 * does carry a value is trimmed, like every other string cell here.
 */
function readOptionalStringCell(sheetName, columns, row, columnName, cellMapForRow) {
  if (!columns.has(columnName)) return undefined;
  const raw = cellMapForRow.get(columns.get(columnName));
  const value = raw === undefined ? '' : raw;
  return value.trim() === '' ? undefined : value.trim();
}

/**
 * `{ spritePath }` spread into a row object when the column exists and the cell
 * is filled, `{}` otherwise — so an absent/empty path OMITS the key entirely,
 * exactly like optionalStats does for the int columns.
 */
function optionalSprite(sheetName, columns, row, cellMapForRow) {
  const spritePath = readOptionalStringCell(sheetName, columns, row, SPRITE_HEADER, cellMapForRow);
  return spritePath === undefined ? {} : { spritePath };
}

/**
 * Collect the optional columns a sheet happens to declare, in the given order.
 * Absent columns are simply omitted from the result, which is what lets
 * schema.js default them.
 */
function optionalStats(sheetName, columns, row, cellMapForRow, names) {
  const stats = {};
  for (const name of names) {
    const value = readOptionalIntCell(sheetName, columns, row, name, cellMapForRow);
    if (value !== undefined) stats[name] = value;
  }
  return stats;
}

function readPlayer(rows) {
  if (rows.length === 0) throw new Error(`${PLAYER_SHEET}: sheet is empty`);
  const columns = headerColumns(PLAYER_SHEET, rows[0], PLAYER_HEADERS);
  const dataRows = rows.slice(1).filter((row) => !isBlankRow(row));

  if (dataRows.length === 0) {
    throw new Error(`${PLAYER_SHEET}!2: expected a data row for the player`);
  }
  if (dataRows.length > 1) {
    throw new Error(`${PLAYER_SHEET}!${dataRows[1].rowNumber}: expected exactly one player row`);
  }

  const row = dataRows[0];
  const cells = cellMap(row);
  return {
    id: readStringCell(PLAYER_SHEET, columns, row, 'id', cells),
    kind: readStringCell(PLAYER_SHEET, columns, row, 'kind', cells),
    name: readStringCell(PLAYER_SHEET, columns, row, 'name', cells),
    glyph: readStringCell(PLAYER_SHEET, columns, row, 'glyph', cells),
    maxHp: readIntCell(PLAYER_SHEET, columns, row, 'maxHp', cells),
    attack: readIntCell(PLAYER_SHEET, columns, row, 'attack', cells),
    defense: readIntCell(PLAYER_SHEET, columns, row, 'defense', cells),
    ...optionalStats(PLAYER_SHEET, columns, row, cells, PLAYER_OPTIONAL_HEADERS),
    ...optionalSprite(PLAYER_SHEET, columns, row, cells),
  };
}

/**
 * The shared body of the `enemies` and `bosses` sheets: check the header, drop
 * blank rows, and read one archetype per data row (id/name/glyph/maxHp/attack/
 * defense plus whatever optional stat columns the sheet declares), reporting a
 * duplicate id at its cell.
 *
 * Returns the per-row records so a caller that needs an EXTRA column (the
 * enemies `count`) can read it from the same cells instead of re-walking the
 * sheet. Every error names the sheet it belongs to, because the two sheets are
 * read by the same code.
 *
 * @returns {{entries: {id: string, row: object, cells: Map<number, string>, archetype: object}[], columns: Map<string, number>}}
 */
function readArchetypeRows(sheetName, rows, headers) {
  if (rows.length === 0) throw new Error(`${sheetName}: sheet is empty`);
  const columns = headerColumns(sheetName, rows[0], headers);
  const dataRows = rows.slice(1).filter((row) => !isBlankRow(row));

  const entries = [];
  const seenRows = new Map();

  for (const row of dataRows) {
    const cells = cellMap(row);
    const id = readStringCell(sheetName, columns, row, 'id', cells);
    if (seenRows.has(id)) {
      throw new Error(
        `${sheetName}!${cellRef(columns.get('id'), row.rowNumber)}: duplicate id ` +
          `${JSON.stringify(id)} (first seen at row ${seenRows.get(id)})`,
      );
    }
    seenRows.set(id, row.rowNumber);

    entries.push({
      id,
      row,
      cells,
      archetype: {
        name: readStringCell(sheetName, columns, row, 'name', cells),
        glyph: readStringCell(sheetName, columns, row, 'glyph', cells),
        maxHp: readIntCell(sheetName, columns, row, 'maxHp', cells),
        attack: readIntCell(sheetName, columns, row, 'attack', cells),
        defense: readIntCell(sheetName, columns, row, 'defense', cells),
        ...optionalStats(sheetName, columns, row, cells, ARCHETYPE_OPTIONAL_HEADERS),
        ...optionalSprite(sheetName, columns, row, cells),
      },
    });
  }

  return { entries, columns };
}

function readEnemies(rows) {
  const { entries, columns } = readArchetypeRows(ENEMIES_SHEET, rows, ENEMIES_HEADERS);

  // Built through an entries array + Object.fromEntries, like schema.js: a row
  // whose id is "__proto__" must become a real key, not mutate the prototype.
  const archetypeEntries = entries.map((entry) => [entry.id, entry.archetype]);
  const spawn = entries.map((entry) => ({
    archetype: entry.id,
    count: readIntCell(ENEMIES_SHEET, columns, entry.row, 'count', entry.cells),
  }));

  if (spawn.length === 0) {
    throw new Error(`${ENEMIES_SHEET}!2: expected at least one enemy row`);
  }

  return { archetypes: Object.fromEntries(archetypeEntries), spawn };
}

function readBosses(rows) {
  const { entries } = readArchetypeRows(BOSSES_SHEET, rows, BOSSES_HEADERS);

  if (entries.length === 0) {
    throw new Error(`${BOSSES_SHEET}!2: expected at least one boss row`);
  }

  return {
    archetypes: Object.fromEntries(entries.map((entry) => [entry.id, entry.archetype])),
  };
}

/**
 * The equipment catalog. Identity columns (id/name/glyph/slot) are required; the
 * bonus columns are OPTIONAL in the same sense the stat columns are, so a
 * minimal `id,name,glyph,slot` sheet is readable and the missing bonuses default
 * to 0 in schema.js.
 *
 * A present-but-empty sheet is an error (matching `bosses`): "no `items` sheet"
 * already means "no catalog", so an empty sheet is an author mistake, not a
 * second way to say the same thing.
 */
function readItems(rows) {
  if (rows.length === 0) throw new Error(`${ITEMS_SHEET}: sheet is empty`);
  const columns = headerColumns(ITEMS_SHEET, rows[0], ITEMS_HEADERS);
  const dataRows = rows.slice(1).filter((row) => !isBlankRow(row));

  const entries = [];
  const seenIds = new Map();

  for (const row of dataRows) {
    const cells = cellMap(row);
    const id = readStringCell(ITEMS_SHEET, columns, row, 'id', cells);
    if (seenIds.has(id)) {
      throw new Error(
        `${ITEMS_SHEET}!${cellRef(columns.get('id'), row.rowNumber)}: duplicate id ` +
          `${JSON.stringify(id)} (first seen at row ${seenIds.get(id)})`,
      );
    }
    seenIds.set(id, row.rowNumber);

    entries.push([
      id,
      {
        name: readStringCell(ITEMS_SHEET, columns, row, 'name', cells),
        glyph: readStringCell(ITEMS_SHEET, columns, row, 'glyph', cells),
        slot: readStringCell(ITEMS_SHEET, columns, row, 'slot', cells),
        ...optionalStats(ITEMS_SHEET, columns, row, cells, ITEM_OPTIONAL_HEADERS),
        ...optionalSprite(ITEMS_SHEET, columns, row, cells),
      },
    ]);
  }

  if (entries.length === 0) {
    throw new Error(`${ITEMS_SHEET}!2: expected at least one item row`);
  }

  return { definitions: Object.fromEntries(entries) };
}

/**
 * The loot table: one row per (enemy archetype, item) pair with a drop chance.
 * All three columns are required — a row without a chance would mean nothing,
 * and a row without an item has nothing to drop.
 */
function readLoot(rows) {
  if (rows.length === 0) throw new Error(`${LOOT_SHEET}: sheet is empty`);
  const columns = headerColumns(LOOT_SHEET, rows[0], LOOT_HEADERS);
  const dataRows = rows.slice(1).filter((row) => !isBlankRow(row));

  if (dataRows.length === 0) {
    throw new Error(`${LOOT_SHEET}!2: expected at least one loot row`);
  }

  return dataRows.map((row) => {
    const cells = cellMap(row);
    return {
      enemy: readStringCell(LOOT_SHEET, columns, row, 'enemy', cells),
      item: readStringCell(LOOT_SHEET, columns, row, 'item', cells),
      chance: readIntCell(LOOT_SHEET, columns, row, 'chance', cells),
    };
  });
}

/**
 * The biome tile sheet: one row per tile look (`pared1` = wall, `piso1` =
 * floor), each with an optional `spritePath`. A FLAT `id -> path` map, not a
 * nested roster: an entry carries nothing but the path, so a wrapper object
 * would be ceremony.
 *
 * Unlike `items`/`bosses`, rows WITHOUT a filled path are not an error and their
 * key is simply omitted: the paths are authored by hand after the sheet exists,
 * so "the sheet is there but nothing is filled in yet" is the expected state,
 * and the renderer falls back to the colored tiles.
 */
function readBiomas(rows) {
  if (rows.length === 0) throw new Error(`${BIOMAS_SHEET}: sheet is empty`);
  const columns = headerColumns(BIOMAS_SHEET, rows[0], ['id']);
  const dataRows = rows.slice(1).filter((row) => !isBlankRow(row));

  const entries = [];
  const seenIds = new Map();
  for (const row of dataRows) {
    const cells = cellMap(row);
    const id = readStringCell(BIOMAS_SHEET, columns, row, 'id', cells);
    if (seenIds.has(id)) {
      throw new Error(
        `${BIOMAS_SHEET}!${cellRef(columns.get('id'), row.rowNumber)}: duplicate id ` +
          `${JSON.stringify(id)} (first seen at row ${seenIds.get(id)})`,
      );
    }
    seenIds.set(id, row.rowNumber);

    const spritePath = readOptionalStringCell(BIOMAS_SHEET, columns, row, SPRITE_HEADER, cells);
    if (spritePath !== undefined) entries.push([id, spritePath]);
  }

  return Object.fromEntries(entries);
}

// ------------------------------------------------------------ entry point ---

function sheetRows(entries, paths, name, sharedStrings) {
  const path = paths.get(name);
  if (!path) throw new Error(`${WORKBOOK_PATH}: no sheet named ${JSON.stringify(name)}`);
  const part = entries.get(path);
  if (!part) {
    throw new Error(
      `${WORKBOOK_PATH}: sheet ${JSON.stringify(name)} points at missing part "${path}"`,
    );
  }
  return parseSheet(decodeUtf8(part), sharedStrings);
}

/**
 * Read the player, enemy, boss, item and loot blocks out of an .xlsx workbook.
 *
 * Pure and read-only: no filesystem, no DOM, no global state, so the same call
 * serves the browser adapter and the dev conversion tool.
 *
 * Sheet shape: `player` and `enemies` are REQUIRED; `bosses`, `items`, `loot`
 * and `biomas` are OPTIONAL. An optional key is therefore CONDITIONAL on the
 * returned object:
 * it is present when the workbook declares that sheet, and OMITTED entirely when
 * it does not. Optionality is expressed as "the section may be absent" — a
 * workbook authored before those sheets existed stays readable — and schema.js
 * treats an absent section as an empty roster/catalog/table.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes the workbook bytes
 * @returns {Promise<{player: object, enemies: object, bosses?: object, items?: object, loot?: object[], biomas?: object}>} the validated-later objects
 * @throws {Error} naming the workbook, sheet and cell when the archive is malformed
 */
export async function readStats(bytes) {
  const entries = await unzip(bytes);
  const paths = sheetPaths(entries);
  const sharedStrings = readSharedStrings(entries);

  const player = readPlayer(sheetRows(entries, paths, PLAYER_SHEET, sharedStrings));
  const enemies = readEnemies(sheetRows(entries, paths, ENEMIES_SHEET, sharedStrings));

  // The optional keys are OMITTED entirely (not present as `undefined`) when the
  // workbook declares no such sheet: an absent key is what tells schema.js (and
  // the conversion tool) that this workbook has no such section, which is a
  // different thing from a present-but-empty one.
  const stats = { player, enemies };
  if (paths.has(BOSSES_SHEET)) {
    stats.bosses = readBosses(sheetRows(entries, paths, BOSSES_SHEET, sharedStrings));
  }
  if (paths.has(ITEMS_SHEET)) {
    stats.items = readItems(sheetRows(entries, paths, ITEMS_SHEET, sharedStrings));
  }
  if (paths.has(LOOT_SHEET)) {
    stats.loot = readLoot(sheetRows(entries, paths, LOOT_SHEET, sharedStrings));
  }
  if (paths.has(BIOMAS_SHEET)) {
    stats.biomas = readBiomas(sheetRows(entries, paths, BIOMAS_SHEET, sharedStrings));
  }

  return stats;
}
