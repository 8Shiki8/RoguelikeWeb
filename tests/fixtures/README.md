# Test fixtures

## `invalid/*.json`

Hand-authored JSON bodies used to drive `validateGameData` down its rejection
paths. Plain text, readable in place.

## `*.xlsx` — the workbook fixtures

These are binary and opaque, so this file is the map. They exist because the
runtime can now read `player-enemies.xlsx` directly, and that reader has to cope
with two things:

1. **Excel's own idea of a workbook.** Excel re-saves using a shared string table
   (`t="s"`), split rich-text runs, and string cells (`t="str"`). The project's own
   writer (`tools/xlsx-write.mjs`) emits *inline* strings, so reading its output
   would prove nothing about the sharedStrings path. These fixtures are therefore
   authored **independently** of the project, from raw XML.
2. **Author mistakes.** The workbook is hand-edited, so a bad cell must be
   reported at the exact sheet and cell, not silently become a wrong stat.

| Fixture | What it is |
| --- | --- |
| `excel-shaped.xlsx` | The happy path. Shared strings, an XML entity (`Player &amp; Co` → `Player & Co`), a rich-text name (`Giant ` + `RAT` → `Giant RAT`), a `t="str"` glyph, bare numbers, a row whose cells are stored out of column order (E2 before A2), one entry deflated (method 8) and two stored (method 0). |
| `excel-shaped-inline.xlsx` | The **same values**, but every string is an inline string (`t="inlineStr"`, text inside `<is>`) and there is no `sharedStrings.xml` at all. This is the container style the project's own writer emits *and* the one openpyxl produces, so it models the `player-enemies.xlsx` actually on disk. Both styles must decode to identical objects. |
| `excel-shaped-bad-number.xlsx` | `player!G2` (`defense`) holds the text `nope`. |
| `excel-shaped-bad-header.xlsx` | The `player` sheet has no `defense` column. |
| `excel-shaped-missing-sheet.xlsx` | Only the `player` sheet exists. |
| `not-a-workbook.xlsx` | A valid ZIP (one deflated entry, one stored) with no workbook parts at all — a `.docx`-style archive. |

Values are deliberately different from `data/*.json` (`maxHp` 99, name
`Player & Co`) so that a successful read is *observable* rather than coincidental.

The `bosses`, `items` and `loot` sheets are all **optional** in the reader, and
none of these fixtures carry any of them: `readStats` therefore OMITS those keys
(rather than returning an empty section) for every workbook here, which is exactly
the behaviour `tests/xlsx.test.mjs` pins. A workbook without them is valid data —
`schema.js` normalizes each absent section to an empty roster/catalog/table.

The **stat columns are optional too** (`critChance`/`critDamage`/`luck` on the
player, `xp`/`critChance`/`critDamage` on enemies and bosses, and every bonus
column on an item). These fixtures were authored before those columns existed and
**cannot be regenerated here**, so a sheet without them must keep loading: the
reader omits the key and `schema.js` defaults it to 0. That is why the reader
(`src/data/xlsx.js`) reads those columns through `readOptionalIntCell` and why
adding a column never invalidates a workbook saved earlier. A column that IS
present is still read strictly, so a typo is reported at its cell.

`readStats('excel-shaped.xlsx')` must yield exactly:

```json
{
  "player": {
    "id": "player", "kind": "player", "name": "Player & Co", "glyph": "@",
    "maxHp": 99, "attack": 7, "defense": 2
  },
  "enemies": {
    "archetypes": {
      "rat":    { "name": "Giant RAT", "glyph": "r", "maxHp": 6,  "attack": 3, "defense": 0 },
      "goblin": { "name": "Goblin",    "glyph": "g", "maxHp": 10, "attack": 4, "defense": 1 }
    },
    "spawn": [ { "archetype": "rat", "count": 2 }, { "archetype": "goblin", "count": 1 } ]
  }
}
```

Note there is no `critChance`/`xp` in that output **on purpose**: the key is
omitted, not written as 0, because the sheet declares no such column.

## Regenerating them

They are produced by a dev-only Python script kept **outside this repository**,
because the project itself must stay zero-dependency and Python must never enter
it. The script is `build-excel-shaped-fixtures.py`; run:

```
python <path-to>/build-excel-shaped-fixtures.py <repo>/tests/fixtures
```

The fixtures are written deterministically (fixed ZIP date, fixed part order),
so regenerating produces byte-identical files and a diff here means the script
actually changed.
