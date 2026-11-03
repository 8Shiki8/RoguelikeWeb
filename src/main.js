import { LEVEL_STATS, createGame, isOver, playerAction, applyLevelUpPoint, deferLevelUp } from './core/game.js';
import { equipItem, unequipItem } from './core/equipment.js';
import { createRenderer } from './render/canvas.js';
import { createEffects } from './render/effects.js';
import { createSprites } from './render/sprites.js';
import { createSfx } from './audio/sfx.js';
import { createPanel, createLog } from './ui/panel.js';
import { createLevelUpDialog } from './ui/levelup.js';
import { loadGameData } from './data/index.js';
import { createRng } from './core/rng.js';

const DATA_URL = new URL('../data/', import.meta.url);
const EXCEL_URL = new URL('../player-enemies.xlsx', import.meta.url);

// hotkey -> stat key, straight from the single LEVEL_STATS table, so a stat added
// there gets its keyboard shortcut here for free.
const LEVEL_HOTKEYS = new Map(LEVEL_STATS.map((stat) => [stat.hotkey, stat.key]));

function getSeed() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('seed');
  if (raw != null) {
    const num = Number(raw);
    if (Number.isInteger(num) && num >= 0 && num <= 4294967295) return num >>> 0;
    const intVal = parseInt(raw, 10);
    if (!Number.isNaN(intVal)) return (intVal >>> 0);
    return (raw.split('').reduce((s, c) => (s * 131542391 + c.charCodeAt(0)) >>> 0, 123456789)) >>> 0;
  }
  const rng = createRng(Date.now());
  return rng.int(0, 0xffffffff);
}

async function loadData() {
  const params = new URLSearchParams(window.location.search);
  const source = params.get('source');
  if (source === 'json') {
    return await loadGameData('json');
  }
  try {
    return await loadGameData('excel');
  } catch (err) {
    const logEl = document.getElementById('log');
    if (logEl) {
      const p = document.createElement('p');
      p.className = 'log__line';
      p.textContent = err.message || String(err);
      logEl.prepend(p);
    }
    return await loadGameData('json');
  }
}

let game = null;
let renderer = null;
let panel = null;
let logEl = null;
let fx = null;
let levelUp = null;
/** The level-up dialog may be postponed, so its open state is tracked here. */
let levelUpOpen = false;
/** True between a run ending and the start screen returning (the outro plays). */
let ending = false;
let lastFrame = 0;

const sfx = createSfx();

/**
 * The sprite cache, built ONCE so images survive across runs. `?sprites=off`
 * disables it entirely and every draw falls back to the glyphs/tiles —
 * tests/browser-e2e.mjs appends that flag so its exact-pixel probes keep
 * measuring the deterministic fallback instead of racing async image loads.
 * The onReady repaint is required because the canvas only repaints on input/fx
 * activity: an image that finishes decoding after the first frame would
 * otherwise stay invisible until the next key press.
 */
const sprites = createSprites({
  enabled: new URLSearchParams(window.location.search).get('sprites') !== 'off',
  onReady: render,
});

/**
 * `prefers-reduced-motion: reduce` switches every animation off, so the canvas
 * stays a static, readable frame for players who ask for that. Synthesis is not
 * motion, so audio is unaffected — it has its own mute switch.
 */
const reducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function render() {
  if (renderer && game) renderer.draw(game, fx);
  if (panel && game) panel.render(game);
  if (levelUp && game) levelUp.render(game, { open: levelUpOpen });
  if (logEl) createLog(logEl).render(game);
}

function goToStart() {
  const start = document.getElementById('start');
  const app = document.querySelector('main#app');
  if (start) start.style.display = 'flex';
  if (app) app.style.display = 'none';
  game = null;
  renderer = null;
  window.__renderer = null;
  ending = false;
  // The dialog sits at z-index 2 over the start screen's z-index 1, so a run
  // ended (or restarted) while it was open must hide it explicitly.
  levelUpOpen = false;
  if (levelUp) levelUp.render(null, { open: false });
  if (fx) fx.reset();
  window.game = game;
  window.__fx = null;
  window.__audio = null;
}

/**
 * The run is over. Let the killing blow's effects (and the death or victory
 * sound) play out before the start screen takes over; a reduced-motion player
 * skips the wait rather than watching a frozen frame.
 */
function endRun() {
  if (ending) return;
  ending = true;
  window.setTimeout(goToStart, reducedMotion ? 0 : 900);
}

/**
 * The only animation loop, and it advances PRESENTATION ONLY: effects decay and
 * the canvas is repainted while anything is still moving. It never calls
 * playerAction, so turns stay strictly input-driven (AGENTS.md).
 */
function frame(now) {
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  if (fx) {
    // `fx.update` warps the presentation time itself when a hit-stop/slow-mo is
    // running (it reads `timeScale()` below for the repaint decision). Its own
    // timers are spent in real seconds, which is why the unscaled `dt` is what it
    // is handed: scaling the dt out here would stop those timers dead and the
    // freeze would latch for the rest of the run.
    const scale = fx.timeScale();
    fx.update(dt, game);
    // Repaint while anything is animating OR while the time is warped. A frame
    // drawn during a hit-stop IS the hit-stop: without it the loop would go quiet
    // and the frozen frame would be whatever happened to be painted last.
    if (game && renderer && (!fx.idle() || scale !== 1)) renderer.draw(game, fx);
  }
  requestAnimationFrame(frame);
}

/**
 * One switch for the panel button and the `P` shortcut, so neither can drift
 * from the other.
 */
function setMuted(value) {
  const muted = sfx.setMuted(value);
  const button = panel && panel.refs ? panel.refs.audio : null;
  if (button) {
    button.textContent = muted ? '🔇' : '🔊';
    button.setAttribute('aria-pressed', String(muted));
    button.title = muted ? 'Sound off (P)' : 'Sound on (P)';
  }
}

function attachAudioHandler(panelInst) {
  const button = panelInst.refs && panelInst.refs.audio;
  if (!button) return;
  button.addEventListener('click', () => setMuted(!sfx.isMuted()));
}

function startRun(data) {
  try {
    const seed = getSeed();
    game = createGame({ data, seed, level: 1 });
    fx = createEffects({ reducedMotion });
    const canvas = document.getElementById('game');
    const panelEl = document.getElementById('panel');
    const log = document.getElementById('log');
    logEl = log;
    if (canvas) {
      renderer = createRenderer(canvas, {
        tileSize: data.view.tileSize,
        cols: data.view.cols,
        rows: data.view.rows,
        sprites,
      });
      if (typeof renderer.resize === 'function') {
        renderer.resize(game.map);
      }
      window.__renderer = renderer;
    }
    // A fresh run starts with the dialog closed. It is built and wired only once:
    // #levelup is static markup in index.html, so re-running this per start would
    // stack a second click listener on the same root and spend two points a click.
    levelUpOpen = false;
    if (!levelUp) {
      levelUp = createLevelUpDialog(document.getElementById('levelup'));
      attachLevelUpHandlers(levelUp);
    }
    if (panelEl) {
      panel = createPanel(panelEl);
      attachItemHandlers(panel, game, render);
      attachAudioHandler(panel);
      setMuted(sfx.isMuted());
    }
    window.game = game;
    window.__fx = fx;
    window.__audio = sfx;
    render();
  } catch (e) {
    console.error('startRun failed', e);
    const fatal = document.getElementById('fatal');
    if (fatal) fatal.textContent = String(e.stack || e);
    throw e;
  }
}

function attachLevelUpHandlers(dialogInst) {
  const box = dialogInst.refs && dialogInst.refs.root;
  if (!box) return;
  // Delegated: one listener for the stat buttons (reading `data-stat`), the
  // Later button and the backdrop itself. The dialog builds its buttons from
  // LEVEL_STATS, so this never needs a per-stat branch.
  box.addEventListener('click', (event) => {
    if (!game) return;
    const target = event.target;
    const later = target && target.closest ? target.closest('[data-role="levelup-later"]') : null;
    // "Later", or a stray click on the backdrop, both postpone the pause.
    if (later || target === box) {
      postponeLevelUp();
      return;
    }
    const button = target && target.closest ? target.closest('[data-stat]') : null;
    if (button && applyLevelUpPoint(game, button.dataset.stat)) {
      sfx.play('ui');
      if (game.player.pointsUnspent === 0) levelUpOpen = false;
      render();
    }
  });
}

/**
 * "Later" / Escape: resume play and keep the pending points. The panel hint and
 * the N key bring the dialog back, so nothing is lost by walking away.
 */
function postponeLevelUp() {
  deferLevelUp(game);
  levelUpOpen = false;
  render();
}

function attachItemHandlers(panelInst, gameRef, renderFn) {
  const equipment = panelInst.refs && panelInst.refs.equipment;
  const inventory = panelInst.refs && panelInst.refs.inventory;

  // Delegated: one listener per list, reading `data-slot` / `data-item`. The
  // panel rebuilds the rows on every render, so per-row listeners would leak.
  if (equipment) {
    equipment.addEventListener('click', (event) => {
      const row = event.target && event.target.closest ? event.target.closest('[data-slot]') : null;
      if (row && unequipItem(gameRef, row.dataset.slot)) {
        sfx.play('unequip');
        renderFn();
      }
    });
  }
  if (inventory) {
    inventory.addEventListener('click', (event) => {
      const row = event.target && event.target.closest ? event.target.closest('[data-item]') : null;
      if (row && equipItem(gameRef, row.dataset.item)) {
        sfx.play('equip');
        renderFn();
      }
    });
  }
}

function onKey(e) {
  // Holding a key fires one keydown per OS auto-repeat interval, and each of
  // those consumed a turn. Only deliberate presses may act.
  if (e.repeat) return;

  // Sound is toggleable at any time: mid-run, on the level-up prompt, even before
  // a run exists.
  if (e.key === 'p' || e.key === 'P') {
    setMuted(!sfx.isMuted());
    return;
  }

  if (!game || ending) return;

  // The level-up dialog can be postponed, so the panel hint offers N to reopen
  // it whenever points are still waiting.
  if ((e.key === 'n' || e.key === 'N') && game.player.pointsUnspent > 0) {
    // Pressing N while the dialog is OPEN must postpone it, not just hide it:
    // closing it any other way would leave status 'level-up' with nothing on
    // screen, and movement stays blocked until the dialog comes back.
    if (levelUpOpen) {
      postponeLevelUp();
    } else {
      levelUpOpen = true;
      render();
    }
    return;
  }

  // While the dialog is open movement is disabled: the shortcuts it promises
  // assign the pending points, Escape postpones, and nothing else may act.
  if (levelUpOpen) {
    if (e.key === 'Escape') {
      postponeLevelUp();
      return;
    }
    const stat = LEVEL_HOTKEYS.get(e.key.toLowerCase());
    if (stat && applyLevelUpPoint(game, stat)) {
      sfx.play('ui');
      if (game.player.pointsUnspent === 0) levelUpOpen = false;
      render();
    }
    return;
  }

  let action = null;
  switch (e.key) {
    case 'ArrowUp': case 'w': case 'W': case 'k': case 'K': action = { type: 'move', dx: 0, dy: -1 }; break;
    case 'ArrowDown': case 's': case 'S': case 'j': case 'J': action = { type: 'move', dx: 0, dy: 1 }; break;
    case 'ArrowLeft': case 'a': case 'A': case 'h': case 'H':
      if (game && game.player) game.player.facing = 1;
      action = { type: 'move', dx: -1, dy: 0 };
      break;
    case 'ArrowRight': case 'd': case 'D': case 'l': case 'L':
      if (game && game.player) game.player.facing = -1;
      action = { type: 'move', dx: 1, dy: 0 };
      break;
    case ' ': case '.': action = { type: 'wait' }; break;
    case 'r': case 'R': goToStart(); return;
    default: return;
  }
  const events = playerAction(game, action);
  // Presentation only: translate the turn's events into visuals and sound. The
  // core already resolved everything; these two readers cannot change the run.
  if (fx) fx.emit(events, game);
  sfx.playEvents(events);
  // A level-up just happened: open the dialog. This is the only gameplay path
  // that opens it, which keeps "status === 'level-up' ⇒ dialog open" true.
  if (events.some((event) => event.type === 'levelup')) levelUpOpen = true;
  render();
  if (isOver(game)) endRun();
}

async function init() {
  const data = await loadData();
  const startBtn = document.getElementById('start-button');
  const start = document.getElementById('start');
  const app = document.querySelector('main#app');
  if (start) start.style.display = 'flex';
  if (app) app.style.display = 'none';
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      try {
        if (start) start.style.display = 'none';
        if (app) app.style.display = 'grid';
        // The click is the user gesture browsers require before audio may start.
        sfx.unlock();
        sfx.play('ui');
        startRun(data);
      } catch (e) {
        console.error('start failed', e);
        const fatal = document.getElementById('fatal');
        if (fatal) fatal.textContent = String(e);
      }
    });
  }
  window.addEventListener('keydown', onKey);
  requestAnimationFrame(frame);
  window.game = game;
}

init();
