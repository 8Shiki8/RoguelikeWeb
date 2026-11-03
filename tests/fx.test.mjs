/**
 * Stage 4: presentation feedback — synthesized sound and canvas effects.
 *
 * Both modules are deliberately DOM-free and Canvas-free so they can be pinned
 * here in Node:
 *   - `src/render/effects.js` is a state machine; these tests drive it with real
 *     engine-shaped events and read the timed state back (plus a recording fake
 *     ctx for the overlay pass, and a throwing Proxy to prove reduced motion
 *     draws nothing at all).
 *   - `src/audio/sfx.js` splits a PURE event -> sound-name mapping from the
 *     WebAudio wrapper, so the mapping is asserted exactly as `messages.js`'
 *     event -> text mapping is.
 *
 * The contract that matters for the game as a whole: effects never mutate game
 * state and never advance a turn, so nothing here may change a run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { FLOATER_GROW, NEON, createEffects, floaterScale } from '../src/render/effects.js';
import { createSfx, soundsFor } from '../src/audio/sfx.js';
import { GameStatus, applyLevelUpPoint, createGame, playerAction } from '../src/core/game.js';
import { DATA_VERSION, validateGameData } from '../src/data/index.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));

const CONFIG = readJson('data/config.json');
/** The real shipped data, so the determinism test drives the actual engine. */
const GAME_DATA = validateGameData({
  dataVersion: DATA_VERSION,
  map: CONFIG.map,
  view: CONFIG.view,
  seed: CONFIG.seed ?? null,
  player: readJson('data/player.json'),
  enemies: readJson('data/enemies.json'),
  bosses: readJson('data/bosses.json'),
  items: readJson('data/items.json'),
  loot: readJson('data/loot.json'),
});

// ---------- fixtures ----------

const hero = (x = 2, y = 3) => ({
  id: 'player:1',
  kind: 'player',
  name: 'Hero',
  glyph: '@',
  x,
  y,
  hp: 80,
  maxHp: 80,
  alive: true,
});

const foe = (id = 'enemy:9', x = 3, y = 3) => ({
  id,
  kind: 'enemy',
  name: 'Rat',
  glyph: 'r',
  x,
  y,
  hp: 5,
  maxHp: 5,
  alive: true,
});

/** A game shell with only what the effects module reads: `player` and `map`. */
const shell = (player = hero()) => ({ player, map: { width: 20, height: 20 } });

const hitEvent = (actor, target, extra = {}) => ({
  type: 'attack',
  actor,
  target,
  damage: 4,
  crit: false,
  dodged: false,
  killed: false,
  hp: target.hp,
  maxHp: target.maxHp,
  ...extra,
});

/** A ctx that records every method call and property write the overlay makes. */
function recordingCtx() {
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };
  const ctx = {
    calls,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    arc: record('arc'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillRect: record('fillRect'),
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    createRadialGradient: () => ({ addColorStop() {} }),
    globalAlpha: 1,
    strokeStyle: '#000',
    lineWidth: 1,
    lineJoin: 'round',
    textAlign: 'center',
    textBaseline: 'middle',
  };
  // The overlay writes its LOOK as properties (painted font size, blend mode,
  // glow), which a method recorder cannot see; turning the interesting ones into
  // setters logging to the same list lets a test read back what was painted.
  for (const name of [
    'font',
    'fillStyle',
    'globalCompositeOperation',
    'shadowBlur',
    'shadowColor',
    'globalAlpha',
    'lineCap',
    'strokeStyle',
  ]) {
    let value = '';
    Object.defineProperty(ctx, name, {
      get: () => value,
      set: (next) => {
        value = next;
        calls.push([name, next]);
      },
      enumerable: true,
      configurable: true,
    });
  }
  ctx.named = (name) => calls.filter((c) => c[0] === name);
  return ctx;
}

// ---------- effects: a landed hit ----------

test('a landed hit bursts particles, a damage number and a flash', () => {
  const fx = createEffects();
  const target = foe();
  const actor = hero();
  fx.emit([hitEvent(actor, target)], shell(actor));

  const s = fx.stats();
  assert.ok(s.particles > 0, 'blood/spark particles were spawned');
  assert.equal(s.floaters, 1, 'exactly one damage number');
  assert.deepEqual(s.labels, ['-4']);
  assert.equal(s.flashes, 1, 'the struck entity flashes');
  assert.equal(s.motions, 2, 'the attacker lunges and the target is knocked back');
  assert.equal(fx.idle(), false);
});

test('a critical hit throws more juice and tints the screen than a plain hit', () => {
  const plain = createEffects();
  const plainTarget = foe();
  const plainActor = hero();
  plain.emit([hitEvent(plainActor, plainTarget)], shell(plainActor));

  const crit = createEffects();
  const critTarget = foe();
  const critActor = hero();
  crit.emit([hitEvent(critActor, critTarget, { crit: true, damage: 9 })], shell(critActor));

  assert.ok(crit.stats().particles > plain.stats().particles, 'a crit bursts harder');
  assert.deepEqual(crit.stats().labels, ['-9']);
  assert.ok(crit.stats().rings > plain.stats().rings, 'a crit adds a shockwave');
  assert.equal(plain.stats().tint, false);
  assert.equal(crit.stats().tint, true, 'a crit flashes the screen');
});

test('a blow on the player shakes the screen and tints it red', () => {
  const fx = createEffects();
  const target = hero();
  const actor = foe();
  fx.emit([hitEvent(actor, target, { damage: 6 })], shell(target));

  assert.equal(fx.stats().shaking, true);
  assert.equal(fx.stats().tint, true);
  assert.notEqual(fx.shakeOffset(), null);
  assert.deepEqual(fx.stats().labels, ['-6']);
});

test('a dodged blow shows MISS and spawns no damage number', () => {
  const fx = createEffects();
  const target = foe();
  const actor = hero();
  fx.emit([hitEvent(actor, target, { dodged: true, damage: 0 })], shell(actor));

  assert.deepEqual(fx.stats().labels, ['MISS']);
  assert.equal(fx.stats().flashes, 0, 'nothing was struck, so nothing flashes');
  assert.equal(fx.stats().tint, false);
});

test('a killing blow leaves a corpse that dissolves to nothing', () => {
  const fx = createEffects();
  const target = foe();
  const actor = hero();
  target.alive = false; // the engine marks it dead before emitting the event
  fx.emit([hitEvent(actor, target, { killed: true })], shell(actor));

  assert.equal(fx.stats().corpses, 1);
  const fresh = fx.visualFor(target);
  assert.ok(fresh.alpha > 0, 'the corpse starts visible');
  assert.ok(fresh.alpha <= 1);

  // Long enough for the 450ms dissolve to finish.
  fx.update(0.5, shell(actor));
  assert.equal(fx.stats().corpses, 0);
  assert.equal(fx.visualFor(target).alpha, 0, 'a settled corpse draws nothing');
});

// ---------- effects: movement, pickups, milestones ----------

test('a player step puffs dust, a wait does nothing at all', () => {
  const fx = createEffects();
  const actor = hero();
  fx.emit([{ type: 'move', actor, to: { x: 3, y: 3 } }], shell(actor));
  assert.ok(fx.stats().particles > 0);
  assert.equal(fx.idle(), false);

  fx.reset();
  fx.emit([{ type: 'wait' }], shell(actor));
  assert.equal(fx.idle(), true, 'waiting is visually silent');
});

test('an enemy step is silent so the screen does not fidget every turn', () => {
  const fx = createEffects();
  const actor = foe();
  fx.emit([{ type: 'move', actor, to: { x: 4, y: 3 } }], shell(hero()));
  assert.equal(fx.idle(), true);
});

test('picking an item up names it on screen and rings the tile', () => {
  const fx = createEffects();
  const player = hero();
  fx.emit([{ type: 'pickup', item: 'rusty-sword', name: 'Rusty Sword' }], shell(player));

  assert.deepEqual(fx.stats().labels, ['Rusty Sword']);
  assert.ok(fx.stats().rings > 0);
  assert.ok(fx.stats().particles > 0);
});

test('levelling up bursts gold at the hero', () => {
  const fx = createEffects();
  const player = hero();
  fx.emit([{ type: 'levelup', level: 2 }], shell(player));

  assert.deepEqual(fx.stats().labels, ['LEVEL UP']);
  assert.ok(fx.stats().rings > 0);
  assert.ok(fx.stats().particles > 20);
  assert.equal(fx.stats().tint, true);
});

test('victory and defeat tint the screen differently and defeat also shakes', () => {
  const win = createEffects();
  win.emit([{ type: 'gameover', victory: true, winner: 'player' }], shell(hero()));
  assert.equal(win.stats().tint, true);
  assert.equal(win.stats().shaking, false);

  const lose = createEffects();
  lose.emit([{ type: 'gameover', victory: false, winner: 'rat' }], shell(hero()));
  assert.equal(lose.stats().tint, true);
  assert.equal(lose.stats().shaking, true);
});

test('unknown events and empty batches are ignored without throwing', () => {
  const fx = createEffects();
  fx.emit([], shell());
  fx.emit([{ type: 'does-not-exist' }], shell());
  fx.emit(null, shell());
  fx.emit({ type: 'move', actor: hero(), to: { x: 3, y: 3 } }, shell());
  assert.ok(fx.stats().particles > 0, 'a lone event object is accepted');
});

// ---------- effects: decay, caps and reset ----------

test('effects decay to idle once their timers run out', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target, { crit: true })], shell(actor));
  assert.equal(fx.idle(), false);

  for (let i = 0; i < 60; i += 1) fx.update(0.1, shell(actor));
  assert.equal(fx.idle(), true, 'nothing is left animating');
  assert.deepEqual(fx.stats(), {
    particles: 0,
    floaters: 0,
    labels: [],
    scales: [],
    rings: 0,
    arcs: 0,
    ghosts: 0,
    combo: 0,
    flashes: 0,
    motions: 0,
    corpses: 0,
    shaking: false,
    tint: false,
    lowHp: false,
    hitStop: false,
    slowMo: false,
    timeScale: 1,
    tintAlpha: 0,
  });
});

test('a nudge decays smoothly back to the entity home cell', () => {
  const fx = createEffects();
  const target = foe();
  const actor = hero();
  fx.emit([hitEvent(actor, target)], shell(actor));

  const first = fx.visualFor(target);
  assert.notEqual(first.dx, 0);
  fx.update(0.08, shell(actor));
  const later = fx.visualFor(target);
  assert.ok(Math.abs(later.dx) < Math.abs(first.dx), 'the knockback eases out');
  fx.update(0.2, shell(actor));
  assert.equal(fx.visualFor(target).dx, 0);
  assert.equal(fx.visualFor(target).scale, 1);
});

test('an untouched living entity draws at full opacity with no offset', () => {
  const fx = createEffects();
  assert.deepEqual(fx.visualFor(foe()), { dx: 0, dy: 0, scale: 1, flash: 0, alpha: 1 });
});

test('the particle list is capped so one huge turn cannot grow it forever', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  for (let i = 0; i < 80; i += 1) fx.emit([hitEvent(actor, target, { crit: true })], shell(actor));
  assert.ok(fx.stats().particles <= 700);
});

test('reset clears every layer', () => {
  const fx = createEffects();
  const actor = hero();
  fx.emit([hitEvent(actor, foe(), { crit: true, killed: true })], shell(actor));
  fx.reset();
  assert.equal(fx.idle(), true);
  assert.deepEqual(fx.stats().labels, []);
});

// ---------- effects: low health and reduced motion ----------

test('low health keeps the vignette animating', () => {
  const fx = createEffects();
  const player = hero();
  player.hp = 10; // 12.5% of 80
  fx.update(0.016, shell(player));

  assert.equal(fx.stats().lowHp, true);
  assert.equal(fx.idle(), false, 'the beating vignette is an animation of its own');

  player.hp = 60;
  fx.update(0.016, shell(player));
  assert.equal(fx.stats().lowHp, false);
  assert.equal(fx.idle(), true);
});

test('reduced motion emits nothing and draws nothing, ever', () => {
  const fx = createEffects({ reducedMotion: true });
  const actor = hero();
  const target = foe();

  fx.emit([hitEvent(actor, target, { crit: true, killed: true })], shell(actor));
  fx.emit([{ type: 'levelup', level: 2 }], shell(actor));
  fx.emit([{ type: 'gameover', victory: false }], shell(actor));

  assert.equal(fx.idle(), true);
  assert.equal(fx.stats().particles, 0);
  assert.equal(fx.stats().tint, false);
  assert.equal(fx.shakeOffset(), null);

  // A reduced-motion player at death's door still gets no pulse.
  const player = hero();
  player.hp = 5;
  fx.update(0.016, shell(player));
  assert.equal(fx.stats().lowHp, false, 'reduced motion suppresses the vignette too');

  // Any property access on the ctx would mean we tried to draw: that must not happen.
  const tripwire = new Proxy(
    {},
    {
      get() {
        throw new Error('overlay drew under reduced motion');
      },
    },
  );
  assert.doesNotThrow(() => fx.overlay(tripwire, shell(player), 30));
});

// ---------- effects: the overlay pass ----------

test('the overlay draws the damage number and the particles it holds', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target)], shell(actor));

  const ctx = recordingCtx();
  fx.overlay(ctx, shell(actor), 30);

  const texts = ctx.named('fillText').map((c) => c[1]);
  assert.ok(texts.includes('-4'), 'the damage number is painted');
  assert.ok(ctx.named('fillRect').length > 0, 'particles are painted as squares');
  assert.equal(ctx.named('save').length, ctx.named('restore').length, 'ctx state is balanced');
});

test('the overlay paints a full-screen tint while a crit flash is live', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target, { crit: true })], shell(actor));

  const ctx = recordingCtx();
  fx.overlay(ctx, shell(actor), 30);
  const w = 20 * 30;
  // It must OVERSHOOT the view: the renderer shakes via a translate before this
  // pass runs, so an edge-to-edge tint would leave an untinted band while shaking.
  assert.ok(
    ctx.named('fillRect').some((c) => c[1] < 0 && c[3] > w && c[4] > w),
    'the tint covers the whole view and past its edges',
  );

  fx.update(0.5, shell(actor));
  const after = recordingCtx();
  fx.overlay(after, shell(actor), 30);
  assert.equal(
    after.named('fillRect').some((c) => c[1] < 0 && c[3] > w && c[4] > w),
    false,
    'the tint is gone once it expires',
  );
});

// ---------- effects: the neon look and the floater growth ----------

test('the neon palette is frozen and is what actually reaches the canvas', () => {
  assert.ok(Object.isFrozen(NEON), 'the palette is a tunable constant, not a mutable');
  for (const [name, value] of Object.entries(NEON)) {
    assert.match(value, /^#[0-9a-f]{6}$/, `NEON.${name} must be a plain hex colour`);
  }
  // The saturated set the look was tuned to (asked-for: luminous, neon, striking).
  assert.equal(NEON.cyan, '#00f0ff');
  assert.equal(NEON.enemy, '#ff2d6b');
  assert.equal(NEON.crit, '#ffe600');
  assert.equal(NEON.item, '#b46bff');

  // Declaring a palette is worthless unless the emitters use it: paint a whiff
  // and a pickup, then read back the fillStyle each number was drawn with.
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target, { dodged: true, damage: 0 })], shell(actor));
  fx.emit([{ type: 'pickup', item: 'rusty-sword', name: 'Rusty Sword' }], shell(actor));

  const ctx = recordingCtx();
  fx.overlay(ctx, shell(actor), 30);
  const colorOf = (text) => {
    const index = ctx.calls.findIndex((c) => c[0] === 'fillText' && c[1] === text);
    for (let i = index - 1; i >= 0; i -= 1) {
      if (ctx.calls[i][0] === 'fillStyle') return ctx.calls[i][1];
    }
    return null;
  };

  assert.equal(colorOf('MISS'), NEON.miss, 'a whiff is painted in the cold miss blue');
  assert.equal(colorOf('Rusty Sword'), NEON.item, 'a pickup is painted in the neon violet');
});

test('every floating number starts at its base size and grows to double', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit(
    [
      hitEvent(actor, target), // damage dealt
      hitEvent(target, actor, { damage: 6 }), // damage received (the hero is the target)
      hitEvent(target, actor, { dodged: true, damage: 0 }), // a whiff
      { type: 'pickup', item: 'rusty-sword', name: 'Rusty Sword' },
      { type: 'levelup', level: 2 },
    ],
    shell(actor),
  );

  const fresh = fx.stats();
  assert.equal(fresh.floaters, 5, 'damage dealt, damage taken, MISS, pickup and LEVEL UP all float');
  for (const label of ['-4', '-6', 'MISS', 'Rusty Sword', 'LEVEL UP']) {
    assert.ok(fresh.labels.includes(label), `expected the "${label}" floater`);
  }
  assert.ok(fresh.scales.every((s) => s === 1), 'at spawn every floater sits at its base size');

  fx.update(0.6, shell(actor));
  const grown = fx.stats().scales;
  assert.ok(grown.length > 0, 'floaters are still on screen');
  assert.ok(grown.every((s) => s > 1.4), 'and each one has visibly grown since spawn');

  // The curve is pinned at both ends: base -> base * (1 + FLOATER_GROW).
  assert.equal(FLOATER_GROW, 1, 'the growth is a doubling');
  assert.equal(floaterScale({ life: 1, max: 1 }), 1, 'full life is the untouched base size');
  assert.equal(floaterScale({ life: 0, max: 1 }), 2, 'end of life is exactly double');
});

test('the damage number is painted at its grown size', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target)], shell(actor));
  const fontPx = (ctx) => Number(/(\d+)px/.exec(ctx.named('font').at(-1)[1])[1]);

  const start = recordingCtx();
  fx.overlay(start, shell(actor), 30);
  const base = fontPx(start);

  fx.update(0.6, shell(actor)); // the 0.9s number now has 0.3s left
  const later = recordingCtx();
  fx.overlay(later, shell(actor), 30);
  const grown = fontPx(later);

  assert.ok(base > 0, 'the number is painted with a measurable font');
  assert.ok(grown > base * 1.5, `the painted size must grow on screen (${base}px -> ${grown}px)`);
});

test('particles, rings and numbers glow instead of being painted flat', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target, { crit: true })], shell(actor)); // adds a shockwave ring

  const ctx = recordingCtx();
  fx.overlay(ctx, shell(actor), 30);

  assert.ok(
    ctx.named('globalCompositeOperation').some((c) => c[1] === 'lighter'),
    'particles and rings are composited additively so overlaps bloom',
  );
  assert.ok(
    ctx.named('shadowBlur').some((c) => c[1] > 0),
    'the damage number is painted with a halo',
  );
});

test('a live particle is painted as a hot core inside a wider halo', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target)], shell(actor));

  const ctx = recordingCtx();
  fx.overlay(ctx, shell(actor), 30);

  const particles = fx.stats().particles;
  // Per particle: the halo, the hot core, and the dim second bloom copy.
  assert.ok(
    ctx.named('fillRect').length >= particles * 3,
    `every particle paints a halo, a core and a bloom copy (${ctx.named('fillRect').length} fills, ${particles} particles)`,
  );

  // Read back the widest rect painted per colour: the halo (the particle's own
  // colour) must be wider than the incandescent core.
  const widest = new Map();
  let lastFill = null;
  for (const call of ctx.calls) {
    if (call[0] === 'fillStyle') lastFill = call[1];
    if (call[0] === 'fillRect') widest.set(lastFill, Math.max(widest.get(lastFill) ?? 0, call[3]));
  }
  assert.ok(widest.has(NEON.bloom), 'the core is painted with the incandescent bloom colour');
  assert.ok(
    widest.get(NEON.enemy) > widest.get(NEON.bloom),
    'the halo wash is wider than the hot core',
  );
});

test('a crit streaks its debris, an ordinary wound does not', () => {
  const crit = createEffects();
  const critActor = hero();
  const critTarget = foe();
  crit.emit([hitEvent(critActor, critTarget, { crit: true, damage: 9 })], shell(critActor));

  const critCtx = recordingCtx();
  crit.overlay(critCtx, shell(critActor), 30);
  assert.ok(critCtx.named('lineTo').length > 0, 'a crit paints velocity-stretched streaks');
  assert.ok(critCtx.named('lineCap').some((c) => c[1] === 'round'), 'the streaks have round caps');
  assert.equal(
    critCtx.named('moveTo').length,
    critCtx.named('lineTo').length,
    'every streak starts where it ends',
  );
  assert.equal(critCtx.named('save').length, critCtx.named('restore').length, 'ctx state is balanced');

  const plain = createEffects();
  const plainActor = hero();
  const plainTarget = foe();
  plain.emit([hitEvent(plainActor, plainTarget)], shell(plainActor));
  const plainCtx = recordingCtx();
  plain.overlay(plainCtx, shell(plainActor), 30);
  assert.equal(plainCtx.named('lineTo').length, 0, 'a plain hit keeps its chunky bits');
});

test('a shockwave ring is painted as a double wave with an incandescent edge', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target, { crit: true, damage: 9 })], shell(actor));
  const rings = fx.stats().rings;
  assert.ok(rings > 0, 'a crit throws a shockwave');

  const ctx = recordingCtx();
  fx.overlay(ctx, shell(actor), 30);
  assert.ok(
    ctx.named('arc').length >= rings * 2,
    'each ring paints its coloured band plus a leading edge',
  );
  assert.ok(
    ctx.named('strokeStyle').some((c) => c[1] === NEON.bloom),
    'the leading edge is incandescent',
  );
});

test('a particle stays bright into mid-life instead of fading linearly', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target)], shell(actor));

  // Only the alphas that precede a filled rect belong to the particle pass; the
  // floaters write theirs before `fillText`, so they cannot flatter the reading.
  const rectAlphas = (ctx) => {
    const out = [];
    let last = null;
    for (const call of ctx.calls) {
      if (call[0] === 'globalAlpha') last = call[1];
      if (call[0] === 'fillRect') out.push(last);
    }
    return out;
  };

  const birth = recordingCtx();
  fx.overlay(birth, shell(actor), 30);
  const birthAlpha = Math.max(...rectAlphas(birth));

  fx.update(0.225, shell(actor)); // about half of the 0.45s particle life
  const mid = recordingCtx();
  fx.overlay(mid, shell(actor), 30);
  const midAlpha = Math.max(...rectAlphas(mid));

  assert.ok(birthAlpha > 0.9, `a fresh burst is painted white-hot (${birthAlpha})`);
  // A linear fade would leave the core at 0.5 * opacity here; the bloom curve
  // holds it visibly higher, which is the whole point of the change.
  assert.ok(midAlpha > 0.55, `mid-life must still be bright (${midAlpha})`);
});

// ---------- effects: the time juice (hit-stop + slow-mo) ----------

test('a crit freezes the clock, eases it back, and never latches', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target, { crit: true, damage: 9 })], shell(actor));

  assert.equal(fx.timeScale(), 0, 'the hit-stop holds the clock still');
  assert.equal(fx.stats().hitStop, true);
  assert.equal(fx.idle(), false, 'a frozen frame is not idle: it must keep painting');

  fx.update(0.03, shell(actor));
  assert.equal(fx.timeScale(), 0, 'still frozen 30 ms into the 60 ms stop');

  fx.update(0.04, shell(actor));
  assert.equal(fx.timeScale(), 0.35, 'then the slow-mo takes over');

  for (let i = 0; i < 40; i += 1) fx.update(0.05, shell(actor));
  assert.equal(fx.timeScale(), 1, 'and it releases by itself');
  assert.equal(fx.stats().timeScale, 1);
  assert.equal(fx.idle(), true, 'nothing is left frozen or animating');
});

test('a plain hit does not stutter the clock', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target)], shell(actor));

  assert.equal(fx.timeScale(), 1);
  assert.equal(fx.stats().hitStop, false);
  assert.equal(fx.stats().slowMo, false);
});

test('a killing blow arms the freeze, and a frozen frame does not age the burst', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target, { killed: true, damage: 5 })], shell(actor));

  assert.equal(fx.timeScale(), 0, 'a kill freezes as well');
  assert.equal(fx.stats().corpses, 1);

  const particles = fx.stats().particles;
  const labels = fx.stats().labels.slice();
  fx.update(0.03, shell(actor)); // still inside the freeze
  assert.equal(fx.stats().particles, particles, 'a frozen frame ages nothing');
  assert.deepEqual(fx.stats().labels, labels);
  assert.equal(fx.stats().corpses, 1, 'but the corpse keeps dissolving in real time');
});

test('reduced motion never warps the clock', () => {
  const fx = createEffects({ reducedMotion: true });
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target, { crit: true, killed: true, damage: 9 })], shell(actor));

  assert.equal(fx.timeScale(), 1);
  assert.equal(fx.stats().hitStop, false);
  fx.update(0.05, shell(actor));
  assert.equal(fx.timeScale(), 1);
});

test('reset releases the freeze', () => {
  const fx = createEffects();
  const actor = hero();
  fx.emit([hitEvent(actor, foe(), { crit: true })], shell(actor));
  assert.equal(fx.timeScale(), 0);

  fx.reset();
  assert.equal(fx.timeScale(), 1);
  assert.equal(fx.idle(), true);
});

// ---------- effects: the extra stage-6 layers ----------

test('a landed blow leaves a blade arc and an afterimage trail behind it', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target)], shell(actor));

  assert.ok(fx.stats().arcs > 0, 'the swing throws an arc');
  assert.ok(fx.stats().ghosts > 0, 'the lunging actor drags a trail');

  const ctx = recordingCtx();
  fx.overlay(ctx, shell(actor), 30);
  const slices = ctx.named('arc').filter((c) => c[5] - c[4] < Math.PI * 2 - 0.01);
  assert.ok(slices.length > 0, 'the arc is painted as a SLICE, never a full ring');
  assert.ok(
    ctx.named('fillText').map((c) => c[1]).includes(actor.glyph),
    'the afterimage paints the actor glyph where the body just was',
  );
  assert.equal(ctx.named('save').length, ctx.named('restore').length, 'ctx state is balanced');
});

test('blood colour follows the archetype and falls back for unknown ids', () => {
  const paint = (archetypeId) => {
    const fx = createEffects();
    const actor = hero();
    const target = foe();
    if (archetypeId) target.archetypeId = archetypeId;
    fx.emit([hitEvent(actor, target)], shell(actor));
    const ctx = recordingCtx();
    fx.overlay(ctx, shell(actor), 30);
    return new Set(ctx.named('fillStyle').map((c) => c[1]));
  };

  assert.ok(paint('goblin').has(NEON.bloodGoblin), 'a goblin sprays acid-lime');
  assert.ok(paint('boss').has(NEON.bloodBoss), 'the boss sprays molten orange');
  assert.ok(paint('rat').has(NEON.enemy), 'the rat keeps the default red');
  assert.ok(
    paint('some-creature-nobody-authored').has(NEON.enemy),
    'an unknown id falls back rather than regressing to no colour',
  );
});

test('a chain of landed blows escalates the burst, and only the hero builds it', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  const counts = [];
  for (let i = 0; i < 3; i += 1) {
    fx.emit([hitEvent(actor, target)], shell(actor));
    counts.push(fx.stats().particles);
  }

  assert.equal(fx.stats().combo, 3, 'three landed blows fill the chain');
  assert.ok(
    counts[1] > counts[0] && counts[2] > counts[1],
    `every step widens the burst (${counts.join(' > ')})`,
  );

  fx.update(1.4, shell(actor));
  assert.equal(fx.stats().combo, 0, 'the chain lapses on its own once the window passes');

  const victim = createEffects();
  victim.emit(
    [
      hitEvent(target, actor, { damage: 3 }),
      hitEvent(target, actor, { damage: 3 }),
      hitEvent(target, actor, { damage: 3 }),
    ],
    shell(actor),
  );
  assert.equal(victim.stats().combo, 0, 'a hero taking three hits is not a payoff');
});

test('the hero taking a blow answers with a cyan shockwave', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(target, actor, { damage: 6 })], shell(actor));

  assert.ok(fx.stats().rings > 0, 'a wave rings off the hero');
  assert.equal(fx.stats().shaking, true, 'and the screen shakes');
  assert.equal(fx.stats().tint, true, 'and the screen reddens');

  const ctx = recordingCtx();
  fx.overlay(ctx, shell(actor), 30);
  assert.ok(
    ctx.named('strokeStyle').some((c) => c[1] === NEON.cyan),
    'the shockwave is painted in the player cyan',
  );
});

test('a pickup rings twice and the second wave rises off the tile', () => {
  const fx = createEffects();
  const actor = hero(4, 5);
  fx.emit([{ type: 'pickup', item: 'rusty-sword', name: 'Rusty Sword' }], shell(actor));
  assert.ok(fx.stats().rings >= 2, 'the claim throws a wave plus a rising ring');

  fx.update(0.2, shell(actor));
  const ctx = recordingCtx();
  fx.overlay(ctx, shell(actor), 30);
  const rows = new Set(ctx.named('arc').map((c) => c[2])); // the two centres, by row
  assert.ok(rows.size >= 2, 'the rising ring has climbed away from its tile');
});

test('a kill bursts blood plus a warm ember trickle, not just a fade', () => {
  const fx = createEffects();
  const actor = hero();
  const target = foe();
  fx.emit([hitEvent(actor, target, { killed: true, damage: 5 })], shell(actor));

  assert.equal(fx.stats().corpses, 1, 'the body still dissolves');
  assert.ok(fx.stats().particles >= 26, 'the kill burst plus the ember trickle');

  const ctx = recordingCtx();
  fx.overlay(ctx, shell(actor), 30);
  const paints = new Set(ctx.named('fillStyle').map((c) => c[1]));
  const warm = [...paints].filter((c) => ![NEON.enemy, NEON.bloom, NEON.white].includes(c));
  assert.ok(warm.length > 0, `the embers glow a warm colour of their own (${[...paints]})`);
  assert.equal(ctx.named('save').length, ctx.named('restore').length, 'ctx state is balanced');
});

test('every full-screen wash stays inside the exact-colour budget', () => {
  const actor = hero();
  const target = foe();
  const batches = [
    [hitEvent(actor, target, { crit: true })],
    [hitEvent(target, actor, { crit: true })],
    [hitEvent(target, actor, { damage: 6 })],
    [{ type: 'levelup', level: 2 }],
    [{ type: 'descend', depth: 2 }],
    [{ type: 'gameover', victory: true, winner: 'player' }],
    [{ type: 'gameover', victory: false, winner: 'rat' }],
  ];
  const alphas = batches.map((events) => {
    const fx = createEffects();
    fx.emit(events, shell(actor));
    return fx.stats().tintAlpha;
  });

  assert.ok(Math.max(...alphas) > 0, 'the events that flash still flash');
  // The headless E2E samples the exact centre pixel of the floors and of the
  // first wall, so any wash above what the look was tuned to turns them off
  // palette. Pinning the ceiling here catches it in milliseconds, not a run.
  assert.ok(Math.max(...alphas) <= 0.22, `the tint budget (${alphas.join(', ')})`);
});

// ---------- sound: the pure event -> sound mapping ----------

test('soundsFor maps steps, wall bumps and whiffs, and stays silent otherwise', () => {
  assert.deepEqual(soundsFor([{ type: 'wait' }]), []);
  assert.deepEqual(soundsFor([{ type: 'move', actor: { kind: 'enemy' } }]), []);
  assert.deepEqual(soundsFor([{ type: 'move', actor: { kind: 'player' } }]), ['step']);
  assert.deepEqual(soundsFor([{ type: 'blocked', actor: { kind: 'player' }, reason: 'wall' }]), ['bump']);
  // The core's only other blocked reasons are 'occupied' and 'empty'; both read as
  // a swing that hit nothing.
  assert.deepEqual(soundsFor([{ type: 'blocked', actor: { kind: 'player' }, reason: 'occupied' }]), ['whiff']);
  assert.deepEqual(soundsFor([{ type: 'blocked', actor: { kind: 'player' }, reason: 'empty' }]), ['whiff']);
});

test('soundsFor distinguishes landing, critting, dodging and dying', () => {
  const player = { kind: 'player' };
  const enemy = { kind: 'enemy' };
  const swing = (target, extra = {}) => ({ type: 'attack', target, dodged: false, crit: false, killed: false, ...extra });

  assert.deepEqual(soundsFor([swing(enemy)]), ['hit']);
  assert.deepEqual(soundsFor([swing(enemy, { crit: true })]), ['crit']);
  assert.deepEqual(soundsFor([swing(enemy, { killed: true })]), ['hit', 'kill']);
  assert.deepEqual(soundsFor([swing(enemy, { crit: true, killed: true })]), ['crit', 'kill']);
  assert.deepEqual(soundsFor([swing(player)]), ['hurt'], 'a blow landing on the player is a hurt sound');
  assert.deepEqual(soundsFor([swing(player, { crit: true })]), ['hurtCrit']);
  assert.deepEqual(soundsFor([swing(player, { killed: true })]), ['death']);
  assert.deepEqual(soundsFor([swing(enemy, { dodged: true })]), ['dodge']);
});

test('soundsFor covers the run milestones', () => {
  assert.deepEqual(soundsFor([{ type: 'pickup', item: 'rusty-sword' }]), ['pickup']);
  assert.deepEqual(soundsFor([{ type: 'drop', actor: { kind: 'enemy' } }]), ['drop']);
  assert.deepEqual(soundsFor([{ type: 'levelup', level: 2 }]), ['levelup']);
  assert.deepEqual(soundsFor([{ type: 'descend', level: 2 }]), ['descend']);
  assert.deepEqual(soundsFor([{ type: 'gameover', victory: true }]), ['victory']);
  assert.deepEqual(soundsFor([{ type: 'gameover', victory: false, winner: 'player' }]), ['cleared']);
  assert.deepEqual(soundsFor([{ type: 'gameover', victory: false, winner: 'rat' }]), ['gameover']);
});

test('every sound the mapping can ask for has a synthesized recipe', () => {
  const player = { kind: 'player' };
  const enemy = { kind: 'enemy' };
  const everything = soundsFor([
    { type: 'move', actor: player },
    { type: 'blocked', reason: 'wall' },
    { type: 'blocked', reason: 'occupied' },
    { type: 'attack', target: enemy, dodged: false, crit: false, killed: false },
    { type: 'attack', target: enemy, dodged: false, crit: true, killed: false },
    { type: 'attack', target: enemy, dodged: false, crit: false, killed: true },
    { type: 'attack', target: enemy, dodged: true },
    { type: 'attack', target: player, dodged: false, crit: false, killed: false },
    { type: 'attack', target: player, dodged: false, crit: true, killed: false },
    { type: 'attack', target: player, dodged: false, crit: false, killed: true },
    { type: 'pickup' },
    { type: 'drop', actor: enemy },
    { type: 'levelup' },
    { type: 'descend' },
    { type: 'gameover', victory: true },
    { type: 'gameover', victory: false, winner: 'player' },
    { type: 'gameover', victory: false, winner: 'rat' },
  ]);

  // `play` refuses a name with no recipe, and the recipe table IS the playable set
  // (`sfx.names`), never a second hand-written list. Equip/unequip/ui are driven by
  // button clicks in the panel rather than by events, so they are not in `everything`.
  const recipes = createSfx().names;
  for (const name of everything) {
    assert.ok(recipes.includes(name), `${name} has no recipe`);
  }
  assert.deepEqual(
    [...new Set(everything)].sort(),
    recipes.filter((n) => n !== 'equip' && n !== 'unequip' && n !== 'ui').sort(),
    'the mapping covers the whole effect table, and the table has no dead entries',
  );
});

test('a non-array event batch is accepted by soundsFor', () => {
  assert.deepEqual(soundsFor({ type: 'levelup' }), ['levelup']);
  assert.deepEqual(soundsFor(null), []);
});

// ---------- sound: the WebAudio wrapper degrades safely ----------

test('without WebAudio every call is a safe no-op', () => {
  // Node 22 has no AudioContext, so this is exactly the headless path.
  const sfx = createSfx();
  assert.equal(sfx.supported(), false);
  assert.equal(sfx.unlock(), false);
  assert.equal(sfx.play('hit'), false);
  assert.equal(sfx.play('not-a-sound'), false);
  assert.equal(sfx.playEvents([{ type: 'attack', target: { kind: 'enemy' }, killed: true }]), 2, 'the mapping still counts');
});

test('the mute switch is remembered even with no audio backend', () => {
  const sfx = createSfx();
  assert.equal(sfx.isMuted(), false);
  assert.equal(sfx.setMuted(true), true);
  assert.equal(sfx.isMuted(), true);
  assert.equal(sfx.play('hit'), false, 'a muted engine stays silent');
  assert.equal(sfx.setMuted(false), false);
  assert.equal(sfx.isMuted(), false);
});

// ---------- the contracts the rest of the game relies on ----------

test('the hero dissolves like any other corpse when the killing blow lands', () => {
  const fx = createEffects();
  const player = hero();
  const killer = foe();
  player.alive = false; // core/combat.js sets alive = false the moment hp reaches 0
  fx.emit([hitEvent(killer, player, { damage: 6, killed: true })], shell(player));

  assert.equal(fx.stats().corpses, 1, 'the hero is a corpse like anyone else');
  assert.ok(fx.visualFor(player).alpha > 0, 'the death dissolve starts visible');
  fx.update(0.5, shell(player));
  assert.equal(fx.visualFor(player).alpha, 0);
});

test('effects never write to game state', () => {
  const player = Object.freeze(hero());
  const legend = Object.freeze({ ...foe(), alive: false });
  const map = Object.freeze({ width: 20, height: 20, tiles: Object.freeze([]) });
  const game = Object.freeze({ player, map, entities: Object.freeze([player, legend]) });

  const fx = createEffects();
  // These modules are ES modules, so they run in strict mode: ANY write to a frozen
  // object throws. This passing is therefore the proof, not a smoke test.
  assert.doesNotThrow(() => {
    fx.emit(
      [
        { type: 'move', actor: player, to: { x: 3, y: 3 } },
        { type: 'blocked', actor: player, reason: 'wall' },
        hitEvent(player, legend, { crit: true, killed: true }),
        hitEvent(legend, player, { damage: 6 }),
        hitEvent(player, legend, { dodged: true, damage: 0 }),
        { type: 'pickup', item: 'rusty-sword', name: 'Rusty Sword' },
        { type: 'drop', actor: legend },
        { type: 'levelup', level: 2 },
        { type: 'descend', level: 3 },
        { type: 'gameover', victory: false, winner: 'rat' },
      ],
      game,
    );
    fx.update(0.05, game);
    for (const entity of game.entities) fx.visualFor(entity);
    fx.overlay(recordingCtx(), game, 30);
    fx.shakeOffset();
  });
});

test('an emit or update with no run yet is harmless', () => {
  const fx = createEffects();
  assert.doesNotThrow(() => {
    fx.emit([{ type: 'move', actor: hero(), to: { x: 3, y: 3 } }], null);
    fx.emit([{ type: 'levelup', level: 2 }], null);
    fx.emit([{ type: 'descend', level: 2 }], null);
    fx.emit([{ type: 'gameover', victory: true }], null);
    fx.update(0.05, null);
    fx.update(0.05, undefined);
    fx.overlay(recordingCtx(), null, 30);
  });
  assert.equal(fx.stats().lowHp, false);
});

test('the screen shake decays to nothing', () => {
  const fx = createEffects();
  const target = hero();
  const actor = foe();
  fx.emit([hitEvent(actor, target, { damage: 5 })], shell(target));

  assert.notEqual(fx.shakeOffset(), null);
  for (let i = 0; i < 20; i += 1) fx.update(0.05, shell(target));
  assert.equal(fx.shakeOffset(), null);
});

test('the floater list is capped alongside the particles', () => {
  const fx = createEffects();
  const player = hero();
  for (let i = 0; i < 100; i += 1) fx.emit([{ type: 'levelup', level: 2 }], shell(player));
  assert.equal(fx.stats().floaters, 60);
  assert.equal(fx.stats().particles, 700);
});

test('a seeded run is byte-identical with and without the effects layer attached', () => {
  // Drive the REAL engine through real turns, parking the hero next to a live foe
  // first so the turns actually order attacks — that is where the seeded crit and
  // loot rolls happen, and a stray rng draw or a mutated field would diverge here.
  //
  // Entity ids are deliberately excluded: they come from a process-global counter
  // (`enemy:4` in the second game where the first had `enemy:1`), so they are
  // unique but NOT reproducible. Everything that decides a run is compared.
  const snapshots = (withFx) => {
    const game = createGame({ data: GAME_DATA, seed: 20261017, level: 1 });
    const fx = withFx ? createEffects() : null;
    const out = [];
    for (let i = 0; i < 80; i += 1) {
      if (game.status === GameStatus.LEVEL_UP) {
        applyLevelUpPoint(game, 'attack'); // same choice in both runs
      } else {
        const victim = game.enemies.find((e) => e.alive);
        let action = { type: 'wait' };
        if (victim) {
          // The tile the foe stands on is walkable by definition, and moving into a
          // hostile is an attack (core/game.js resolveAction).
          game.player.x = victim.x - 1;
          game.player.y = victim.y;
          action = { type: 'move', dx: 1, dy: 0 };
        }
        const events = playerAction(game, action);
        if (fx) {
          fx.emit(events, game);
          fx.update(0.05, game);
        }
      }
      out.push({
        turn: game.turn,
        status: game.status,
        hp: game.player.hp,
        attack: game.player.attack,
        level: game.player.level,
        xp: game.player.xp,
        pos: `${game.player.x},${game.player.y}`,
        ground: game.groundItems.map((g) => `${g.item}@${g.x},${g.y}`),
        foes: game.enemies.map((e) => `${e.x},${e.y}:${e.hp}:${e.alive}`),
      });
    }
    return out;
  };

  const withFx = snapshots(true);
  assert.ok(
    withFx.filter((s) => s.status === 'playing').length > 4,
    'the run really did take several turns',
  );
  assert.ok(
    withFx.some((s) => s.foes.some((f) => f.endsWith(':false'))),
    'the run really did fight and kill',
  );
  assert.deepEqual(withFx, snapshots(false));
});

