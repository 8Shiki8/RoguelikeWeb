// Manual headless-Chrome CDP script. NOT part of `node --test` (it drives a live page over the DevTools protocol).
/**
 * End-to-end browser check via Chrome DevTools Protocol (no extra deps: global
 * fetch + global WebSocket in Node 22).
 *
 * Verifies: ES module loading, data fetch (the authored workbook by default, or
 * `?source=json` for the generated files), canvas pixel output, DOM panel wiring,
 * that a real keydown advances exactly one turn, and that the default (workbook)
 * source really spawns the level-5 boss.
 *
 * Pass the page URL as argv[2] to point at a different source, e.g.
 *   node tests/browser-e2e.mjs "http://127.0.0.1:8123/?seed=1&source=json"
 *
 * `sprites=off` is part of the default URL on purpose: the pixel probes below
 * (exact floor/wall colors, glyph pixels) measure the GLYPH FALLBACK, and a
 * sprite that finished loading at an arbitrary time would make them flaky.
 */
const CDP_PORT = 9223;
const URL = process.argv[2] || 'http://127.0.0.1:8123/?seed=1&sprites=off';

async function waitForTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP target never appeared');
}

const target = await waitForTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(label, expression) {
  const msg = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (msg.result?.exceptionDetails) {
    throw new Error(`${label}: ${msg.result.exceptionDetails.exception?.description ?? 'exception'}`);
  }
  return msg.result?.result?.value;
}

// The start screen gates the run: prove the run has NOT started yet, then click
// Start and let the boot poll below confirm the run appears only afterwards.
const startScreen = await evaluate(
  'start-screen',
  `new Promise((resolve) => {
     const started = Date.now();
     (function poll() {
       const button = document.getElementById('start-button');
       if (!button) {
         if (Date.now() - started > 8000) return resolve({ error: 'no start button' });
         return setTimeout(poll, 50);
       }
       const screen = document.getElementById('start');
       const rect = screen.getBoundingClientRect();
       const style = getComputedStyle(screen);
       const before = {
         display: style.display,
         visible: !screen.hidden && style.display !== 'none',
         coversViewport:
           Math.round(rect.width) === window.innerWidth && Math.round(rect.height) === window.innerHeight,
         coversViewport_px: [Math.round(rect.width), Math.round(rect.height)],
         viewport_px: [window.innerWidth, window.innerHeight],
         title: document.querySelector('#start h1')?.textContent ?? null,
         buttonText: button.textContent.trim(),
         buttonVisible: button.getBoundingClientRect().width > 0,
         // GOTCHA: an element with id="game" makes window.game BE the canvas
         // element before any run exists, so truthiness alone proves nothing.
         // Only a real run has .player.
         windowGameBefore: {
           exists: !!window.game,
           isCanvas: window.game instanceof HTMLCanvasElement,
           tagName: window.game?.tagName ?? null,
           hasPlayer: !!window.game?.player,
         },
         runNotStartedYet: !window.game?.player,
       };
       button.click();
       resolve({ before, clicked: true });
     })();
   })`,
);

// Give the module time to boot.
await evaluate(
  'boot',
  `new Promise((resolve) => {
     const started = Date.now();
     (function poll() {
       // Wait for a real run: window.game is the #game canvas element until then.
       if (window.game?.player || Date.now() - started > 8000) return resolve(!!window.game?.player);
       setTimeout(poll, 50);
     })();
   })`,
);

const initial = await evaluate(
  'initial-state',
  `(() => {
     if (!window.game) return { booted: false, fatal: document.getElementById('fatal')?.textContent ?? '' };
     const g = window.game;
     const role = (r) => document.querySelector('[data-role="' + r + '"]')?.textContent ?? null;
     const lastLog = document.querySelector('#log .log__line:last-child')?.textContent ?? null;
     return {
       booted: true,
       fatalVisible: document.getElementById('fatal')?.dataset.visible ?? 'no',
       // Which adapter actually served the run, and whether the workbook read
       // quietly fell back to data/*.json. Without these two the numbers below
       // are ambiguous: 40/40 and 20/20 mean different things.
       dataSource: new URLSearchParams(location.search).get('source') ?? '(no param -> workbook)',
       fallbackWarning: typeof lastLog === 'string' && lastLog.startsWith('Could not read'),
       seed: g.seed,
       turn: g.turn,
       status: g.status,
       player: { x: g.player.x, y: g.player.y, hp: g.player.hp, maxHp: g.player.maxHp, mana: g.player.mana, maxMana: g.player.maxMana },
       enemies: g.enemies.map((e) => ({ name: e.name, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp })),
       // The progression/equipment sections must reach the LIVE game from the
       // default (workbook) source; a section silently dropped by the adapter
       // still boots the game, so it is asserted here rather than assumed.
       equipment: g._data
         ? {
             itemCount: Object.keys(g._data.items.definitions).length,
             lootRows: g._data.loot.length,
             hasWildcard: g._data.loot.some((row) => row.enemy === '*'),
             lootItemsResolve: g._data.loot.every((row) => !!g._data.items.definitions[row.item]),
             itemSlots: [...new Set(Object.values(g._data.items.definitions).map((i) => i.slot))].sort(),
             playerCrit: g._data.player.critChance,
             playerMaxMana: g._data.player.maxMana,
             ratXp: g._data.enemies.archetypes.rat.xp,
           }
         : null,
       canvas: { width: document.getElementById('game').width, height: document.getElementById('game').height },
       items: {
         groundItems: g.groundItems.length,
         inventory: g.player.inventory.length,
         slots: Object.keys(g.player.equipment).length,
         bagRows: document.querySelectorAll('[data-role="inventory"] .bag__row').length,
         gearRows: document.querySelectorAll('[data-role="equipment"] .gear__row').length,
         hasEquipmentSection: !!document.querySelector('[data-role="equipment"]'),
       },
       panel: {
         turn: role('turn'),
         seed: role('seed'),
         map: role('map'),
         heroName: role('hero-name'),
         heroHp: role('hero-hp'),
         heroMana: role('hero-mana'),
         heroManaBarWidth: document.querySelector('[data-role="hero-manabar"]')?.style.width ?? null,
         atk: role('hero-atk'),
         def: role('hero-def'),
         foes: role('target'),
         status: role('status'),
         audioButton: !!document.querySelector('[data-role="audio"]'),
         logLines: document.querySelectorAll('#log .log__line').length,
         lastLog: document.querySelector('#log .log__line:last-child')?.textContent ?? null,
       },
     };
   })()`,
);

// Pixel-sampling helpers, injected into the page.
await evaluate(
  'install-probes',
  `window.__probe = (() => {
     const canvas = document.getElementById('game');
     const ctx = canvas.getContext('2d');
     const dpr = Math.min(window.devicePixelRatio || 1, 2);
     const tile = Number(getComputedStyle(canvas).width.replace('px','')) / window.game.map.width;
     const tileInt = Math.round(tile);
     const near = (px, [r, g, b], tol = 40) =>
       Math.abs(px[0] - r) <= tol && Math.abs(px[1] - g) <= tol && Math.abs(px[2] - b) <= tol;
     return {
       tileSize: tileInt,
       countCell: (cx, cy, rgb, tol) => {
         const d = ctx.getImageData(Math.round(cx * tileInt * dpr), Math.round(cy * tileInt * dpr), Math.round(tileInt * dpr), Math.round(tileInt * dpr)).data;
         let n = 0;
         for (let i = 0; i < d.length; i += 4) {
           if (near([d[i], d[i+1], d[i+2]], rgb, tol)) n++;
         }
         return n;
       },
       pixelAt: (px, py) => {
         const d = ctx.getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data;
         return [d[0], d[1], d[2]];
       },
       barPixels: (cx, cy) => {
         const d = ctx.getImageData(Math.round(cx * tileInt * dpr), Math.round((cy * tileInt - 5) * dpr), Math.round(tileInt * dpr), Math.round(4 * dpr)).data;
         let n = 0;
         for (let i = 0; i < d.length; i += 4) {
           if (d[i] > 150 && d[i+1] < 130) n++;
         }
         return n;
       },
     };
   })()`,
);

const pixels = await evaluate(
  'pixel-sampling',
  `(() => {
     const g = window.game, p = window.__probe;
     const walls = [];
     for (let y = 0; y < g.map.height; y += 1) {
       for (let x = 0; x < g.map.width; x += 1) {
         if (g.map.tiles[y * g.map.width + x] === 0) walls.push([x, y]);
       }
     }
     // Floor samples must avoid entity cells, otherwise the actor halo is what
     // gets sampled instead of the tile.
     const emptyFloors = [];
     for (let y = 0; y < g.map.height && emptyFloors.length < 5; y += 1) {
       for (let x = 0; x < g.map.width && emptyFloors.length < 5; x += 1) {
         if (g.map.tiles[y * g.map.width + x] !== 1) continue;
         if (g.entities.some((e) => e.alive && e.x === x && e.y === y)) continue;
         emptyFloors.push([x, y]);
       }
     }
     const FLOOR = [22, 27, 37];
     const FLOOR_ALT = [19, 24, 34];
     const samples = emptyFloors.map(([x, y]) => {
       const expected = (x + y) % 2 === 0 ? FLOOR : FLOOR_ALT;
       const got = p.pixelAt(x * p.tileSize + p.tileSize / 2, y * p.tileSize + p.tileSize / 2);
       return { cell: [x, y], expected, got, exact: got.join() === expected.join() };
     });
     return {
       tileSize: p.tileSize,
       wallPixel: p.pixelAt(walls[0][0] * p.tileSize + p.tileSize / 2, walls[0][1] * p.tileSize + p.tileSize / 2),
       wallExact: p.pixelAt(walls[0][0] * p.tileSize + p.tileSize / 2, walls[0][1] * p.tileSize + p.tileSize / 2).join() === '43,52,70',
       floorSamples: samples,
       allFloorsExact: samples.every((s) => s.exact),
       goblinCellPixel: p.pixelAt(9 * p.tileSize + p.tileSize / 2, 3 * p.tileSize + p.tileSize / 2),
       playerGlyphPixels: p.countCell(g.player.x, g.player.y, [124, 240, 255], 60),
       enemyGlyphPixels: g.enemies.map((e) => p.countCell(e.x, e.y, [255, 122, 122], 60)),
       enemyBarPixels: g.enemies.map((e) => p.barPixels(e.x, e.y)),
       // The descender is drawn in the stairs colour ([255,209,102]); every one
       // of those pixels is, by construction, not floor. Reported as null on the
       // boss level, which has no stairs at all.
       stairs: g.map.stairs
         ? {
             cell: [g.map.stairs.x, g.map.stairs.y],
             nonFloorPixels: p.countCell(g.map.stairs.x, g.map.stairs.y, [255, 209, 102], 60),
           }
         : { cell: null, nonFloorPixels: null },
     };
   })()`,
);

// Real input: send a keydown and require exactly one turn to pass.
const afterInput = await evaluate(
  'keydown-turn',
  `(async () => {
     const g = window.game;
     const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
     const startTurn = g.turn;
     const attempts = [];
     for (const key of ['w', 'a', 's', 'd']) {
       const before = { turn: g.turn, x: g.player.x, y: g.player.y };
       press(key);
       await new Promise((r) => setTimeout(r, 30));
       attempts.push({ key, turnDelta: g.turn - before.turn, moved: g.player.x !== before.x || g.player.y !== before.y });
       if (g.turn - before.turn > 0) break;
     }
     const panelTurn = document.querySelector('[data-role="turn"]').textContent;
     return {
       startTurn,
       endTurn: g.turn,
       attempts,
       bodyTurn: g.turn,
       panelTurn,
       panelMatchesState: panelTurn === String(g.turn),
       playerNow: { x: g.player.x, y: g.player.y },
       logLines: document.querySelectorAll('#log .log__line').length,
       lastLog: document.querySelector('#log .log__line:last-child')?.textContent ?? null,
       heroHp: document.querySelector('[data-role="hero-hp"]').textContent,
     };
   })()`,
);

// Auto-repeat must NOT advance extra turns.
const repeatCheck = await evaluate(
  'keydown-repeat',
  `(() => {
     const g = window.game;
     const before = g.turn;
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', repeat: true, bubbles: true, cancelable: true }));
     return { before, after: g.turn, advanced: g.turn !== before };
   })()`,
);

// The panel must show the enemy the player attacks -- and only that one. This is
// the only place the DOM rendering of the target card can be checked: node tests
// have no DOM.
const panelTarget = await evaluate(
  'panel-target',
  `(() => {
     const g = window.game;
     const list = () => document.querySelector('[data-role="target"]');
     const role = (r) => document.querySelector('[data-role="' + r + '"]')?.textContent ?? null;
     const keys = { '0,-1': 'w', '1,0': 'd', '0,1': 's', '-1,0': 'a' };
     const emptyBefore = role('target');

     // Find a living enemy with a free walkable neighbour to stand on.
     let enemy = null;
     let key = null;
     for (const candidate of g.enemies.filter((e) => e.alive)) {
       for (const [dx, dy] of [[0,-1],[1,0],[0,1],[-1,0]]) {
         const x = candidate.x + dx;
         const y = candidate.y + dy;
         if (g.map.tiles[y * g.map.width + x] !== 1) continue;
         if (g.entities.some((e) => e.alive && e.x === x && e.y === y)) continue;
         g.player.x = x;
         g.player.y = y;
         enemy = candidate;
         // Step back TOWARD the enemy: the player stands at (enemy + dir), so the
         // bump direction is the negation of that offset.
         key = keys[-dx + ',' + -dy];
         break;
       }
       if (enemy) break;
     }
     if (!enemy) return { skipped: 'no free floor cell next to a living enemy' };

     enemy.maxHp = 100;
     enemy.hp = 100; // survive the hit, so the card must still be there afterwards
     window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

     const card = list().textContent;
     return {
       emptyBefore,
       key,
       attacked: enemy.name,
       targetIsAttacked: g.target === enemy,
       card,
       cardShowsName: card.includes(enemy.name),
       cardShowsHp: card.includes(enemy.hp + '/' + enemy.maxHp),
       cardCount: document.querySelectorAll('[data-role="target"] .foe').length,
     };
   })()`,
);

// Level-up must be REACHABLE and ESCAPABLE in the real page. It became reachable
// only once the authored data started carrying `xp` (the engine always awarded
// it, but the model silently dropped the field), so this pins the whole chain end
// to end: a kill crosses the threshold, the DIALOG opens over a paused run with
// 3 points, a partial spend keeps the pause, "Later" resumes play while keeping
// the pool, N reopens it (and must swallow movement while open), and draining the
// pool closes it for good. It must run BEFORE the boss probe, which leaves the
// run on level 5. The engine-level "last point resumes" rule is pinned in
// tests/engine.test.mjs; this probe owns the UI contract.
const levelUp = await evaluate(
  'level-up-probe',
  `(() => {
     const g = window.game;
     if (!g || !g.player) return { skipped: 'no run' };
     const role = (r) => document.querySelector('[data-role="' + r + '"]');
     const keys = { '0,-1': 'w', '1,0': 'd', '0,1': 's', '-1,0': 'a' };

     let enemy = null;
     let key = null;
     for (const candidate of g.enemies.filter((e) => e.alive)) {
       for (const [dx, dy] of [[0,-1],[1,0],[0,1],[-1,0]]) {
         const x = candidate.x + dx;
         const y = candidate.y + dy;
         if (g.map.tiles[y * g.map.width + x] !== 1) continue;
         if (g.entities.some((e) => e.alive && e.x === x && e.y === y)) continue;
         g.player.x = x;
         g.player.y = y;
         enemy = candidate;
         key = keys[-dx + ',' + -dy];
         break;
       }
       if (enemy) break;
     }
     if (!enemy) return { skipped: 'no enemy to kill for xp' };

     // Deterministic: one kill worth exactly the threshold, from a clean slate.
     g.player.xp = 0;
     g.player.pointsUnspent = 0;
     enemy.hp = 1;
     enemy.xp = g.player.xpToNext;
     const attackBefore = g.player.attack;
     window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

     // The dialog carries the hidden attribute (not an inline display), so
     // visibility is the attribute itself.
     const isOpen = () => !role('levelup').hidden;
     const press = (key) =>
       window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

     const afterKill = {
       enemyDied: !enemy.alive,
       status: g.status,
       playerLevel: g.player.level,
       xpAfter: g.player.xp,
       points: role('points').textContent,
       boxVisible: isOpen(),
       hintVisible: role('levelup-hint').style.display !== 'none',
       hint: role('levelup-hint').textContent,
       statButtons: document.querySelectorAll('[data-stat]').length,
       attackLabel: document.querySelector('[data-stat="attack"]').textContent,
     };

     // One point spent: the pause must SURVIVE until the pool is empty.
     document.querySelector('[data-stat="attack"]').click();
     const afterFirstSpend = {
       status: g.status,
       attackDelta: g.player.attack - attackBefore,
       points: role('points').textContent,
       boxVisible: isOpen(),
     };

     // "Later" postpones: play resumes at once and the leftover points are kept.
     document.querySelector('[data-role="levelup-later"]').click();
     const afterLater = {
       status: g.status,
       points: g.player.pointsUnspent,
       boxHidden: !isOpen(),
       hintVisible: role('levelup-hint').style.display !== 'none',
     };

     // N brings it back, and while it is open a movement key must be swallowed.
     press('n');
     let walkKey = null;
     for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
       const x = g.player.x + dx;
       const y = g.player.y + dy;
       if (g.map.tiles[y * g.map.width + x] !== 1) continue;
       if (g.entities.some((e) => e.alive && e.x === x && e.y === y)) continue;
       walkKey = keys[dx + ',' + dy];
       break;
     }
     const spot = { turn: g.turn };
     if (walkKey) press(walkKey);
     const whileOpen = {
       boxVisible: isOpen(),
       movementBlocked: walkKey === null ? 'skipped: no walkable neighbour' : g.turn === spot.turn,
     };

     // Escape is the other way out and must not spend anything.
     press('Escape');
     const afterEscape = { boxHidden: !isOpen(), status: g.status, points: g.player.pointsUnspent };

     // Drain the remaining pool: closing the last point closes the dialog.
     press('n');
     for (let i = 0; i < 2; i += 1) document.querySelector('[data-stat="attack"]').click();
     const afterSpend = {
       status: g.status,
       attackDelta: g.player.attack - attackBefore,
       points: g.player.pointsUnspent,
       boxHidden: !isOpen(),
       hintVisible: role('levelup-hint').style.display !== 'none',
     };

     // With nothing left to distribute, N must not reopen an empty dialog.
     press('n');
     const nOnEmpty = isOpen();
     return { afterKill, afterFirstSpend, afterLater, whileOpen, afterEscape, afterSpend, nOnEmpty };
   })()`,
);

// Floor items, the bag and the worn gear must work in the real page: the panel
// is rebuilt on every render, so a click has to survive that, and a ground item
// has to be drawn and collected. The whole probe stands the hero on a cell with
// a WALL neighbour, because a blocked wall move renders WITHOUT consuming a turn
// (so no foe moves mid-probe) -- that is the turn-free redraw this uses.
const items = await evaluate(
  'items-probe',
  `(() => {
     const g = window.game;
     if (!g || !g.player) return { skipped: 'no run' };
     const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
     const role = (r) => document.querySelector('[data-role="' + r + '"]');
     const dirs = [['d', 1, 0], ['a', -1, 0], ['s', 0, 1], ['w', 0, -1]];
     const occupied = (x, y) => g.entities.some((e) => e.alive && e.x === x && e.y === y);

     // A walkable cell with a wall neighbour AND a free (walkable, unoccupied,
     // loot-free) neighbour, so the probe can both block-and-redraw and step.
     let spot = null;
     for (let y = 1; y < g.map.height - 1 && !spot; y += 1) {
       for (let x = 1; x < g.map.width - 1 && !spot; x += 1) {
         if (g.map.tiles[y * g.map.width + x] !== 1 || occupied(x, y)) continue;
         if (g.groundItems.some((it) => it.x === x && it.y === y)) continue;
         const wall = dirs.find((d) => g.map.tiles[(y + d[2]) * g.map.width + (x + d[1])] !== 1);
         const free = dirs.find((d) =>
           g.map.tiles[(y + d[2]) * g.map.width + (x + d[1])] === 1 &&
           !occupied(x + d[1], y + d[2]) &&
           !g.groundItems.some((it) => it.x === x + d[1] && it.y === y + d[2]));
         if (wall && free) spot = { x, y, wall, free, fx: x + free[1], fy: y + free[2] };
       }
     }
     if (!spot) return { skipped: 'no cell with both a wall and a free neighbour' };
     g.player.x = spot.x;
     g.player.y = spot.y;

     // --- equip from the bag by clicking its row (blocked wall move redraws) ---
     g.player.inventory.push('rusty-sword');
     press(spot.wall[0]);
     const bagRow = document.querySelector('[data-role="inventory"] [data-item="rusty-sword"]');
     const attackBefore = g.player.attack;
     const bagCountBefore = role('bag-count').textContent;
     if (bagRow) bagRow.click();
     const afterEquip = {
       equipped: g.player.equipment.weapon,
       attackDelta: g.player.attack - attackBefore,
       bagHasItem: !!document.querySelector('[data-role="inventory"] [data-item="rusty-sword"]'),
       gearText: document.querySelector('[data-role="equipment"] [data-slot="weapon"]')?.textContent ?? null,
       bagCount: role('bag-count').textContent,
     };

     // --- unequip by clicking the worn slot ---
     const gearRow = document.querySelector('[data-role="equipment"] [data-slot="weapon"]');
     if (gearRow) gearRow.click();
     const afterUnequip = {
       equipped: g.player.equipment.weapon,
       attackRestored: g.player.attack === attackBefore,
       bagHasItem: !!document.querySelector('[data-role="inventory"] [data-item="rusty-sword"]'),
       bagCount: role('bag-count').textContent,
     };

     // --- a ground item is DRAWN in the item colour (redraw via a blocked move) ---
     g.groundItems.push({ item: 'sturdy-belt', x: spot.fx, y: spot.fy });
     press(spot.wall[0]);
     const draw = {
       cell: [spot.fx, spot.fy],
       itemPixels: window.__probe.countCell(spot.fx, spot.fy, [201, 160, 255], 60),
     };
     g.groundItems = g.groundItems.filter((it) => !(it.x === spot.fx && it.y === spot.fy));

     // --- step onto a ground item to pick it up ---
     const before = g.player.inventory.length;
     g.groundItems.push({ item: 'leather-gloves', x: spot.fx, y: spot.fy });
     press(spot.free[0]);
     const pickup = {
       key: spot.free[0],
       moved: g.player.x === spot.fx && g.player.y === spot.fy,
       picked: g.player.inventory.includes('leather-gloves'),
       inventoryDelta: g.player.inventory.length - before,
       groundLeft: g.groundItems.filter((it) => it.x === spot.fx && it.y === spot.fy).length,
       logPicked: [...document.querySelectorAll('#log .log__line')].some((p) => p.textContent.startsWith('You pick up')),
       bagRows: document.querySelectorAll('[data-role="inventory"] .bag__row').length,
     };

     return { bagCountBefore, afterEquip, afterUnequip, draw, pickup };
   })()`,
);

// Stage 4: the presentation layer must be WIRED, not merely present. This drives
// a real attack through main.js and then reads the effects system back, proves
// it settles on demand, and checks the sound engine is live and mutable in the
// real page. It runs before the boss probe, which leaves the run on level 5.
const fxProbe = await evaluate(
  'fx-probe',
  `(async () => {
     const g = window.game;
     const fx = window.__fx;
     const audio = window.__audio;
     if (!g || !g.player) return { skipped: 'no run' };
     if (!fx) return { skipped: 'window.__fx is not exposed' };

     // --- sound engine: created, schedulable, mutable ---
     const button = document.querySelector('[data-role="audio"]');
     // The engine caps a dozen voices per 60 ms so a burst cannot stack, and the
     // probes before this one queue sounds too. So every play here is spaced past
     // that window; a tight loop would report false for a recipe that is fine.
     const gap = () => new Promise((resolve) => setTimeout(resolve, 90));
     await gap();
     const audioReport = {
       exposed: !!audio,
       supported: audio ? audio.supported() : null,
       unlocked: audio ? audio.unlock() : null,
       recipeCount: audio ? audio.names.length : null,
       played: audio ? audio.play('ui') : null,
       playedVaried: null,
       buttonExists: !!button,
       pressedBefore: button ? button.getAttribute('aria-pressed') : null,
       hintMentionsSound: (document.querySelector('.hint')?.textContent ?? '').includes('Sound'),
     };
     if (button) {
       button.click();
       audioReport.pressedAfterClick = button.getAttribute('aria-pressed');
       audioReport.mutedByClick = audio ? audio.isMuted() : null;
       audioReport.playWhileMuted = audio ? audio.play('ui') : null;
       audioReport.glyphWhenMuted = button.textContent;
       button.click(); // back on, so the run under test is not left muted
       audioReport.pressedRestored = button.getAttribute('aria-pressed');
     }
     // One recipe per synthesis path: a filtered noise burst, a tone + noise, and a
     // multi-tone chord. A broken recipe swallows its own exception and reports
     // false, so this is the only runtime proof that the whole table is playable.
     audioReport.playedVaried = [];
     for (const name of ['whiff', 'crit', 'kill', 'levelup']) {
       if (audio) audioReport.playedVaried.push(audio.play(name));
       await gap();
     }

     // A real attack: stand next to a live enemy and hit it. Top the hero up
     // first so the low-health vignette cannot muddy the settle check below.
     const keys = { '0,-1': 'w', '1,0': 'd', '0,1': 's', '-1,0': 'a' };
     let enemy = null;
     let key = null;
     for (const candidate of g.enemies.filter((e) => e.alive)) {
       for (const [dx, dy] of [[0,-1],[1,0],[0,1],[-1,0]]) {
         const x = candidate.x + dx;
         const y = candidate.y + dy;
         if (g.map.tiles[y * g.map.width + x] !== 1) continue;
         if (g.entities.some((e) => e.alive && e.x === x && e.y === y)) continue;
         g.player.x = x;
         g.player.y = y;
         enemy = candidate;
         key = keys[-dx + ',' + -dy];
         break;
       }
       if (enemy) break;
     }
     if (!enemy) return { audio: audioReport, skipped: 'no live enemy to strike' };

     g.player.hp = g.player.maxHp;
     enemy.maxHp = 100;
     enemy.hp = 100; // survive, so the burst is a hit and not a death
     const idleBefore = fx.idle();
     window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
     const after = fx.stats();

     // Fast-forward the presentation clock: the whole burst must decay to idle.
     for (let i = 0; i < 200; i += 1) fx.update(0.05, g);
     const settled = fx.idle();

     return {
       audio: audioReport,
       fx: {
         idleBefore,
         floaters: after.floaters,
         damageLabels: after.labels.filter((l) => /^-\\d+$/.test(l)),
         particles: after.particles,
         flashes: after.flashes,
         motions: after.motions,
         settled,
         statsAfterSettle: fx.stats(),
       },
     };
   })()`,
);


// The boss is only reachable by descending four times. Drive the real page to
// level 5 from the DEFAULT source (the authored workbook) and prove the boss
// actually appears there -- the failure this probe exists for was level 5
// silently spawning nothing because the workbook had no `boss` archetype.
// This runs LAST: it leaves the run on level 5, so the level-1 probes above
// must have already taken their snapshots.
const boss = await evaluate(
  'boss-probe',
  `(() => {
     const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
     const steps = [];
     // Each wait is one consumed turn with the player standing ON the stairs,
     // which is what checkStairs needs -- a move would step OFF the marker first.
     for (let i = 0; i < 10; i += 1) {
       const g = window.game;
       if (!g || !g.player) { steps.push({ stopped: 'no run' }); break; }
       if (g.level >= 5) break;
       if (!g.map.stairs) { steps.push({ level: g.level, stopped: 'no stairs' }); break; }
       g.player.x = g.map.stairs.x;
       g.player.y = g.map.stairs.y;
       const from = g.level;
       press(' ');
       const now = window.game;
       steps.push({ from, to: now ? now.level : null });
       if (!now) { steps.push({ stopped: 'run ended' }); break; }
     }

     const g = window.game;
     const dataSource = new URLSearchParams(location.search).get('source') ?? '(no param -> workbook)';
     if (!g || !g.player) {
       return { reachedLevel5: false, level: null, dataSource, enemyCount: 0, kinds: [], cell: null, glyphPixels: null, steps };
     }
     const bossEnemy = g.enemies.find((e) => e.kind === 'boss') ?? null;
     return {
       reachedLevel5: g.level === 5,
       level: g.level,
       dataSource,
       enemyCount: g.enemies.length,
       kinds: g.enemies.map((e) => e.kind),
       cell: bossEnemy ? [bossEnemy.x, bossEnemy.y] : null,
       glyphPixels: bossEnemy ? window.__probe.countCell(bossEnemy.x, bossEnemy.y, [255, 122, 122], 60) : null,
       // The boss has kind 'boss', and the health bar used to be drawn only for
       // kind 'enemy', so a boss rendered with no bar. Sampling the 4px strip
       // above the boss cell is what makes that regression observable.
       barPixels: bossEnemy ? window.__probe.barPixels(bossEnemy.x, bossEnemy.y) : null,
       steps,
     };
   })()`,
);

console.log(JSON.stringify({ url: URL, startScreen, initial, pixels, afterInput, repeatCheck, panelTarget, levelUp, items, fx: fxProbe, boss }, null, 2));
ws.close();
