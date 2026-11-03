# AGENTS.md (RoguelikeWeb)

## Purpose
Compact, high-signal guidance for future OpenCode sessions. Focus on repo-specific facts.

## Project
- Root: D:\00 Informatica\Practicas\VIBE-CODING\RoguelikeWeb
- Tech: Vanilla JS, HTML5, CSS (ES modules). No build tool, no deps.
- Entry: index.html, src/main.js
- Structure: src/core, src/entities, src/map, src/render, src/ui, src/audio, data/ (JSON), tools/ (dev-only Node scripts, never imported by `src/`)

## Commands
- Static check (one file at a time: `node --check` does not expand globs, and neither does PowerShell):
  - `node --check src/main.js`
- Static check every ES module (PowerShell, from repo root):
  - `Get-ChildItem -Recurse src -Filter *.js | ForEach-Object { node --check $_.FullName }`
- Tests: `node --test` from the repo root (Node 22 built-in runner, zero dependencies).
  - Positional arguments are GLOB PATTERNS, not directories: `node --test tests/` fails with "Cannot find module ...\tests", and `node --test "tests/**"` wrongly executes the manual `tests/browser-e2e.mjs`. Run it bare, or with an explicit file glob.
  - Test files must be named `*.test.mjs` / `*-test.mjs`, or the runner silently skips them.
  - `tests/browser-e2e.mjs` is a manual headless-Chrome CDP script, not part of `node --test`. It cannot use `file://`; see the headless-Chrome command below.
- Stat data is authored in `player-enemies.xlsx` (repo root), then converted to JSON (dev-only, offline, zero deps):
  - `node tools/xlsx-to-json.mjs` — reads `player-enemies.xlsx`, writes `data/player.json` + `data/enemies.json` + `data/bosses.json` + `data/items.json` + `data/loot.json` + `data/biomas.json` (biomas is ALWAYS written, `{}` while no paths are filled in)
  - `node tools/xlsx-write.mjs` — the reverse: writes the workbook from those JSON files (it always emits the `biomas` rows `pared1`/`piso1`, empty until the paths exist)
- Run the manual browser E2E (PowerShell; Chrome is required, ports must be free):
  - `python -m http.server 8123 --bind 127.0.0.1` (in the repo root, background)
  - `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=9223 --remote-allow-origins=* --user-data-dir="<a path WITHOUT spaces>" --no-first-run --no-default-browser-check --disable-gpu --disable-extensions "http://127.0.0.1:8123/?seed=1&sprites=off"`
  - then `node tests/browser-e2e.mjs`. The script only PRINTS a JSON state dump; it asserts nothing, so read the output.
  - GOTCHA: every probe body is a template literal, so NO backtick may appear inside probe code — a stray `` `hidden` `` closes the string and `node --check` fails with `missing ) after argument list`. `node --test` never collects this file (not `*.test.mjs`), so always `node --check tests/*.mjs` before running it.
  - GOTCHA: dialog visibility is read as `!element.hidden`; `style.display` stays `''` on `#levelup`, so the old `style.display !== 'none'` check would always be true.
- Run the game: `file://` does NOT work (null origin blocks ES modules and `fetch`). Start `python -m http.server 8000` in the repo root and open `http://localhost:8000/`.
  - A run starts only after clicking **Start** on the `RogWeb` start screen (`#start` / `#start-button`).
  - `?seed=123` reproduces a dungeon, `R` starts a new run, `?sprites=off` disables sprite loading (glyph fallback only).
  - `window.game` exposes live state for console debugging; `window.__fx` (the effects system: `stats()`, `emit()`, `update()`, `idle()`) and `window.__audio` (`supported()`, `play()`, `setMuted()`) expose the stage-4 presentation layer the same way. All three are null/absent outside a run. GOTCHA: before a run starts, `window.game` IS the `<canvas id="game">` element (HTML ids become globals), so truthiness proves nothing — test `window.game?.player` to tell a real run from the canvas.

## Architecture (key)
- Canvas + DOM panel. Logic decoupled from render.
- Tiles (grid). Turn-based explicit: Player → Enemies (sequential). No real-time.
- Dungeon: 2 rooms variable + L-shape corridor, connectivity verified.
- IA hostil: attack adjacent, else BFS 1 step to player.
- Health bars above enemies. The right panel shows the player's stats plus ONLY the enemy the player last attacked (`game.target`); the canvas still draws every enemy.
- Bosses are their own section, not enemy archetypes: the workbook has a `player`/`enemies`/`bosses` sheet trio, `data/bosses.json` mirrors the third, and GameData exposes `bosses.archetypes`. The `bosses` sheet is the one OPTIONAL sheet — a workbook without it yields no `bosses` key, which `schema.js` normalizes to an empty roster (the shipped binary fixtures rely on this). The level-5 gate and the boss arena stay hardcoded in `src/core/game.js` / `src/map/dungeon.js`.
- Items/equipment (stage 3): enemies drop from the `loot` table (the player's `luck` adds percentage points, chance clamped 1..100, `*` = any archetype). A drop lands on `game.groundItems` (`{item,x,y}`) — NOT entities, so it never blocks movement or reads as hostile — and is picked up by stepping on the tile. The panel equips/unequips across 5 slots (`weapon`/`chest`/`belt`/`boots`/`gloves`). Bonuses mutate the LIVE entity (+ on equip, − on unequip, hp/mana clamped to the new ceiling), so every reader keeps seeing plain `player.attack`-style fields; level-up points spent while an item is worn survive unequipping. Logic is `src/core/loot.js` (pure roll) + `src/core/equipment.js`; enemies and the boss carry `archetypeId` for the loot lookup. `items`/`loot` sheets are OPTIONAL like `bosses`.

- Audio + VFX (stage 4): presentation ONLY, so nothing here touches `src/core`. `src/render/effects.js` is a DOM/Canvas-free state machine (particles, floating damage numbers, hit flashes, shockwave rings, lunge/knockback nudges, corpse dissolve, screen shake, screen tints, low-hp vignette) fed by `emit(events, game)` right after `playerAction` and decayed by `update(dt, game)`. `src/render/canvas.js` reads it (`draw(game, fx)`) and owns ALL painting; `fx` is optional there (absent = the plain static frame). `src/audio/sfx.js` splits a PURE `soundsFor(events)` mapping (pinned in Node, like `messages.js`' event→text mapping) from `createSfx()`, which synthesizes every sound from oscillators + one cached noise buffer — NO audio assets — and returns a safe no-op without WebAudio. `src/main.js` owns the ONLY RAF loop: it advances effects and repaints only while something is still animating, and it NEVER calls `playerAction` (turns stay input-driven). A run ending waits ~900ms so the death/victory FX play before the start screen returns (the hero dissolves like any other corpse — `combat.js` clears `alive`). `prefers-reduced-motion: reduce` makes `emit` a no-op and CSS drops every animation; sound is unaffected (its own mute: `P` or the panel button). Two gotchas: ambient scenery (stairs halo, loot glow, actor halos) is deliberately STATIC — the canvas repaints on input and only while effects are live, so a wall-clock pulse would sit frozen and then jump phase on every key press; and screen tint/vignette fills overshoot by `EDGE_PAD` because `canvas.js` applies the shake as a translate BEFORE the overlay pass. `createSfx()` drops voices past ~12 per 60ms, so an E2E probe must space `__audio.play()` calls (≥60ms) or it reports `false` for recipes that are fine. Stage 4 needed NO workbook/schema change.

- Level-up + neon look (stage 5): presentation again, and it needs NO workbook/schema change either. (a) VFX are NEON: `src/render/effects.js` exports one frozen `NEON` palette (the old VFX hex literals are gone) and paints particles/rings with additive `globalCompositeOperation = 'lighter'` plus a `shadowBlur` halo on the floaters, so overlapping glows bloom. Every floater — damage dealt, damage taken, MISS, pickup, LEVEL UP — grows from its base size to **2×** over its life (`FLOATER_GROW` + `floaterScale(f)`, folded into the font size and read back as `stats().scales`). TWO HARD LIMITS: `PALETTE` in `canvas.js` (tiles/entities/bars) stays untouched, and no tint alpha may grow — the headless E2E's exact-colour probes (`allFloorsExact`, `enemyBarPixels`) only survive the washes at the current alphas. (b) `POINTS_PER_LEVEL = 3` in `src/core/game.js`, pinned by a test so it cannot drift back to 1. The threshold still PAUSES the run (`status === 'level-up'`), but the pause is now POSTPONABLE: `deferLevelUp(game)` returns to PLAYING while keeping `pointsUnspent`, `applyLevelUpPoint` accepts points in EITHER status (so a postponed pool stays spendable mid-run) and only lifts the pause on the LAST point. (c) The prompt is a real overlay instead of a panel block: `src/ui/levelup.js` (`createLevelUpDialog(root)`) renders the static `#levelup` dialog from index.html, with one button per `LEVEL_STATS` entry showing a live `ATK 4 → 5 (A)` preview, a "Later" button, Escape and backdrop-click to postpone, and `N` to reopen while points remain. The invariant is **`status === 'level-up'` ⇒ dialog open**, so `main.js`'s `levelUpOpen` flag may only be cleared through `postponeLevelUp()` — a bare hide would leave the run paused with nothing on screen and movement dead. While the dialog is open movement is disabled and h/m/a/d/c/x/v/l/i spend points.

  Stage-5 GOTCHAS (all hit during implementation):
  - `#levelup` is STATIC markup, so `createLevelUpDialog` + `attachLevelUpHandlers` must be wired ONCE (`if (!levelUp)` inside `startRun`): re-running them per Start stacks a second click listener on the same root and every click then spends TWO points.
  - The dialog's hotkey legend is `data-role="levelup-keys"`, NOT `levelup-hint`. `levelup-hint` must stay unique to the panel's pending-points span, or the E2E's `hintVisible` silently checks the legend (no inline display) and passes no matter what.
  - Test fixtures: `stats()` includes `scales`, and the fx `recordingCtx` turns `font`/`fillStyle`/`globalCompositeOperation`/`shadowBlur`/`shadowColor` into recording SETTERS — a method-only recorder cannot see property writes, and that is exactly where the grown size, the additive blend and the glow live.

- Sprites (stage 6): presentation ONLY, and `src/core` reads nothing new — `createEntity` just carries `spritePath` (the four game.js call sites spread `...archetype`, so it flows with no rule change). `src/render/sprites.js` (`createSprites({enabled, onReady, createImage})`) is a path→Image cache; `canvas.js` draws a loaded sprite in place of the wall/floor fill, the actor glyph and the loot glyph, and falls back to exactly the old drawing on ANY miss (no path, still loading, load error, `sprites` absent, `?sprites=off`). Paths are authored in the workbook: an OPTIONAL `spritePath` column on `player`/`enemies`/`bosses`/`items` (empty cell = glyph) plus the OPTIONAL `biomas` sheet (`id` + `spritePath`, rows `pared1`=wall, `piso1`=floor), which becomes the flat `GameData.biomas` map (`{}` until filled). TWO GOTCHAS: the cache fires `onReady` after each load because the canvas repaints only on input/fx activity — without it a late image would stay invisible until the next key press; and a failed path is cached as failed (never retried, no repaint). A sprite's hit flash is `ctx.filter = 'brightness(3)'` (ignored where unsupported, never throws). `?sprites=off` kills the cache entirely and `tests/browser-e2e.mjs` appends it so the exact-pixel probes (`allFloorsExact`, `wallExact`, glyph counts) keep measuring the deterministic fallback. `tools/xlsx-write.mjs` refuses a biomas id outside `pared1`/`piso1` rather than silently dropping it.

## Editing workflow (source files)
Before modifying any source file, use BOTH references so nothing breaks:
- **Engram (memory):** `mem_search` / `mem_context` for prior decisions, bug fixes and conventions on this repo.
- **CodeGraph (structure):** `codegraph_explore` (MCP) or `codegraph explore "<symbol or file>"` (shell) to read the file's current source AND its callers/dependents in one call. Never edit blind from memory or from a stale read.
- Check the blast radius first: know every caller of the symbol you change, then re-verify after the edit (a "⚠ changed on disk" banner means the index lags — re-query or Read that file before continuing).
- Verify after editing: static check + `node --test` (see Commands).
- If `.codegraph/` is absent, skip CodeGraph entirely (indexing is the user's decision; mention `codegraph init`, don't run it).

## Constraints
- **No overengineering.** Make the smallest change that satisfies the request.
  No speculative abstraction, no extension point with a single caller, no
  config flag nobody asked for, no new dependency, and no rewriting working
  code to make it prettier.
  - This does NOT license removing approved design. Explicit decisions (the
    pluggable data-source seam, the validated frozen `GameData` model) are
    requirements, not speculation. The rule targets complexity nobody asked
    for, not complexity the brief required.
  - Prefer the boring, obvious solution over the clever, general one. If the
    simpler option is "less elegant", take it.
- Keep gameplay logic independent of Canvas/DOM/sprites.
- Do not advance turns from RAF.
- ES modules only.
- No external deps/engines unless explicitly approved.

## Conventions
- Modules under src/. Data in data/ (JSON).
- `data/player.json`, `data/enemies.json`, `data/bosses.json`, `data/items.json`, `data/loot.json` and `data/biomas.json` are GENERATED (from `player-enemies.xlsx`): hand edits there are lost on the next conversion. `data/config.json` is hand-authored. ROUND-TRIP WARNING: the writer rebuilds the workbook from these JSONs, so after filling sprite paths in Excel, run `xlsx-to-json` BEFORE any future `xlsx-write` run or the paths are wiped.
- Minimal changes; prefer incremental edits.

## Delegation
Delegate by activity to the matching subagent. The main agent keeps ownership of this file, `.opencode/agents/*`, `.opencode/skills/*`, cross-cutting edits, and final verification.

- Implementing or refactoring an approved feature under `src/` (gameplay, data, map, render, UI) -> `roguelike-programer`
- Test strategy, writing tests, fixtures for invalid or edge data, coverage gaps -> `test-engineer` (TEMPORARILY DISABLED: `disabled: true` in its agent frontmatter; while it is off, the main agent writes tests)
- Read-only review of a change (correctness, readability, architecture, performance, overengineering) -> `code-reviewer`
- Trust boundaries, input validation, data-handling risk -> `security-auditor`
- Locating code or surveying an area you do not know yet -> `explore`
- Multi-step research or work outside this repo's conventions -> `general`

Rules:
- One writer at a time. Never run two editing subagents on the same files concurrently.
- Hand over a closed brief: goal, files in scope, files out of scope, the exact verification command, and the required completion report.
- Only `roguelike-programer` and `test-engineer` may edit; `code-reviewer` and `security-auditor` are read-only. While `test-engineer` is disabled, the main agent takes its test edits.
- Subagents must not modify `AGENTS.md`, `.opencode/agents/*`, or `.opencode/skills/*`.
- A subagent's "tests pass" is not evidence. Read the diff and re-run the command yourself before reporting success.
- Do not delegate a one-line fix, or a survey whose context is already loaded.

## Tools/Agents
- See .opencode/agents/*.md and .opencode/skills/*.md.