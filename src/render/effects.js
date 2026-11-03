/**
 * Presentation-only effects: particles, floating damage numbers, hit flashes,
 * shockwave rings, blade arcs, afterimages, screen shake and screen tints.
 *
 * This module is deliberately DOM-free and Canvas-free. It is a small state
 * machine that turns engine events into timed visual state; `canvas.js` reads
 * that state while drawing. That split buys two things:
 *   - the effect logic is unit-testable in Node (no canvas, no browser), and
 *   - the renderer stays a pure reader.
 *
 * It NEVER touches game state and NEVER advances a turn (AGENTS.md): every value
 * here decays from a RAF-driven `update(dt, game)` in main.js. That update also
 * owns the time juice (a hit-stop plus a slow-mo on crits and killing blows): it
 * spends their timers in REAL seconds and warps the presentation time itself, so
 * the freeze can never latch.
 *
 * Coordinates are in TILE units (floats), so the renderer multiplies by the tile
 * size and the whole look scales with the view. Randomness here is `Math.random`
 * on purpose — this is presentation, and it must not disturb the seeded engine
 * rng that makes `?seed=` reproducible.
 */

/** Below this hp ratio the hero edge-vignette starts to pulse. */
const LOW_HP = 0.34;
/** Hard cap so a pathological turn cannot grow the arrays without bound. */
const MAX_PARTICLES = 700;
const MAX_FLOATERS = 60;
/** Caps for the extra stage-6 layers: an afterimage trail and the blade arcs. */
const MAX_GHOSTS = 24;
const MAX_ARCS = 12;

/**
 * Alpha bloom curve exponent. A particle's alpha is `(life / max) ^ ALPHA_CURVE`,
 * so it is born white-hot and only falls off late; a plain linear fade is already
 * half-dim by mid-life, which is what made the old bursts read as dull.
 */
const ALPHA_CURVE = 0.6;
/**
 * Size decay floor: a particle keeps 35% of its size at the end of life and stays
 * near full size while the bloom curve is still high.
 */
const SIZE_FLOOR = 0.35;
/** Spark tail length as a fraction of a second of the particle's own velocity. */
const STREAK = 0.1;
/** How much larger the second, dimmer copy of a particle/ring is (fake bloom). */
const BLOOM_GROW = 2.4;
/** Alpha of that second copy: noticeable glare, never a flat wash. */
const BLOOM_ALPHA = 0.16;
/**
 * Shadow halo radius, allowed ONLY for the small crit/kill spark bursts. The
 * general particle loop (up to MAX_PARTICLES) must stay on plain additive fills:
 * a shadow per particle is the one thing that makes this layer expensive.
 */
const SPARK_GLOW = 6;

/**
 * The attack swoosh: an arc SLICE (radians) of a ring centred on the struck tile,
 * opening back toward the attacker. `SWOOSH_*` are tile units / radians.
 */
const SWOOSH_LIFE = 0.18;
const SWOOSH_RADIUS = 0.62;
const SWOOSH_SPREAD = Math.PI * 0.62;
const SWOOSH_WIDTH = 3;
/** The afterimage trail a lunging actor drags behind it: tile units, seconds. */
const GHOST_LIFE = 0.18;
const GHOST_STEPS = 3;
const GHOST_STEP = 0.16;
const GHOST_ALPHA = 0.42;
const GHOST_FONT = 0.74;
/** Consecutive landed blows inside this window escalate the burst, up to COMBO_MAX. */
const COMBO_MAX = 3;
const COMBO_WINDOW = 1.2;

/**
 * Time juice, in REAL seconds (never presentation time, so it always ends).
 * `HIT_STOP` is a full freeze, `SLOW_MO` is the slowdown that follows it.
 */
const HIT_STOP = 0.06;
const SLOW_MO = 0.12;
const SLOW_MO_SCALE = 0.35;

const TAU = Math.PI * 2;
/**
 * Full-screen fills overshoot by this much. The renderer applies the screen shake
 * as a translate BEFORE calling `overlay`, so a tint that stopped at the edges
 * would leave an untinted band exactly while the biggest hits are shaking.
 */
const EDGE_PAD = 16;

/**
 * The neon palette. Every VFX colour lives here so the look is tunable in one
 * place instead of being scattered as hex literals across the event handlers.
 */
export const NEON = Object.freeze({
  /** Player: blood sprayed when the hero is hit, and the descend wash. */
  cyan: '#00f0ff',
  /** Foes: enemy blood, death bursts, and the tint when the hero is hurt. */
  enemy: '#ff2d6b',
  /** Goblin blood: an acid lime, so a second archetype reads apart from the rats. */
  bloodGoblin: '#b6ff3d',
  /** The boss's blood: a molten orange, warmer than any ordinary foe. */
  bloodBoss: '#ff8a1f',
  /** Crits, level-ups and victory: the payoff gold. */
  crit: '#ffe600',
  /** Pickups and drops. */
  item: '#b46bff',
  /** Movement dust. */
  dust: '#8fa6ff',
  /** MISS: a cold gray-blue that reads as "nothing happened". */
  miss: '#a8b8d8',
  /** Damage-taken floater on the hero. */
  hurt: '#ff6b9d',
  /** Plain damage dealt, and the reset tint. */
  white: '#ffffff',
  /**
   * The incandescent core of a hot particle and the leading edge of a ring: a
   * near-white that additive blending turns into glare. Never used as a tint.
   */
  bloom: '#eaffff',
});

/**
 * Per-archetype blood, keyed by the engine's `archetypeId`. The ids are the ones
 * shipped in `data/enemies.json` and `data/bosses.json`; an unknown id (a test
 * fixture, or a workbook that grows a creature before this map does) falls back
 * to NEON.enemy, so the default path never regresses.
 */
const BLOOD = Object.freeze({
  rat: NEON.enemy,
  goblin: NEON.bloodGoblin,
  boss: NEON.bloodBoss,
});

/** The blood colour of an entity's archetype, or NEON.enemy when it has none. */
const bloodFor = (entity) => BLOOD[entity.archetypeId] ?? NEON.enemy;

/** Hex -> [r, g, b]. */
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** Linear mix of two hex colours; `t` is clamped to 0..1, and 0 returns `a`. */
function mixHex(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  const [ar, ag, ab] = hexRgb(a);
  const [br, bg, bb] = hexRgb(b);
  const ch = (x, y) => Math.round(x + (y - x) * k).toString(16).padStart(2, '0');
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

/** How much every floater grows over its life, as a multiple of its base size. */
export const FLOATER_GROW = 1;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
/** 1 at spawn -> 1 + FLOATER_GROW at the end of life. */
export const floaterScale = (f) => 1 + FLOATER_GROW * easeOutCubic(1 - f.life / f.max);

/**
 * @param {{reducedMotion?: boolean}} [options]
 *   `reducedMotion` mirrors `prefers-reduced-motion: reduce`: when true nothing
 *   is emitted at all, so the canvas stays a static, readable frame.
 */
export function createEffects({ reducedMotion = false } = {}) {
  let particles = [];
  let floaters = [];
  let rings = [];
  /** White hit flash per entity id: {life, max}. */
  let flashes = new Map();
  /** Positional nudge / scale pop per entity id: {dx, dy, life, max, pop}. */
  let motions = new Map();
  /** Death dissolve per entity id: {life, max}. */
  let corpses = new Map();
  let shake = { life: 0, max: 0, mag: 0 };
  let tint = { life: 0, max: 0, color: NEON.white, alpha: 0 };
  /** Seconds since creation, used for ambient pulses (the low-hp vignette). */
  let clock = 0;
  let lowHp = false;
  /**
   * Time juice (presentation only): remaining REAL seconds of the hit-stop and of
   * the slow-mo that follows it. They scale the KINETIC layers (particles, rings,
   * floaters, shake, tint). The entity-attached overlays (flash, nudge, corpse
   * dissolve) keep decaying in real time on purpose: they are pinned to the
   * discrete turn that produced them, not to a cinematic clock.
   */
  let hitStop = 0;
  let slowMo = 0;

  /** Afterimage trail of a lunging actor: {x, y, glyph, color, life, max}. */
  let ghosts = [];
  /** Blade arcs of a landed blow: {x, y, angle, spread, radius, width, color, life, max}. */
  let arcs = [];
  /** Combo escalation: a chain counter plus the presentation seconds left in it. */
  let comboLevel = 0;
  let comboTimer = 0;

  // ---------- spawning helpers ----------

  function spawnParticles(x, y, options) {
    const {
      count = 8,
      color = NEON.white,
      speed = 3,
      life = 0.45,
      size = 0.15,
      angle = 0,
      spread = TAU,
      gravity = 0,
      drag = 3,
      opacity = 0.95,
      /** `'square'` (default) keeps the classic chunky bit; `'spark'` streaks. */
      shape = 'square',
    } = options;

    for (let i = 0; i < count; i += 1) {
      const a = angle + (Math.random() - 0.5) * spread;
      const v = speed * (0.4 + Math.random() * 0.85);
      particles.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life,
        max: life,
        size: size * (0.6 + Math.random() * 0.8),
        color,
        gravity,
        drag,
        opacity,
        shape,
      });
    }
    if (particles.length > MAX_PARTICLES) {
      particles = particles.slice(particles.length - MAX_PARTICLES);
    }
  }

  function spawnFloater(x, y, text, options = {}) {
    const { color = NEON.white, size = 0.34, life = 0.9, vy = -1.5 } = options;
    floaters.push({ x, y, text, color, size, vy, life, max: life });
    if (floaters.length > MAX_FLOATERS) {
      floaters = floaters.slice(floaters.length - MAX_FLOATERS);
    }
  }

  function spawnRing(x, y, options = {}) {
    const { color = NEON.white, life = 0.35, radius = 0.9, width = 2, vy = 0 } = options;
    // `vy` lifts the ring off the tile (the pickup flourish): every other ring
    // stays put on the tile it was thrown from.
    rings.push({ x, y, color, life, max: life, radius, width, start: 0.12, vy });
  }

  function spawnArc(x, y, options = {}) {
    const {
      color = NEON.white,
      life = SWOOSH_LIFE,
      radius = SWOOSH_RADIUS,
      spread = SWOOSH_SPREAD,
      width = SWOOSH_WIDTH,
      angle = 0,
    } = options;
    arcs.push({ x, y, angle, spread, radius, width, color, life, max: life });
    if (arcs.length > MAX_ARCS) {
      arcs = arcs.slice(arcs.length - MAX_ARCS);
    }
  }

  /**
   * Lay a short afterimage under a lunging actor: copies of its glyph, stepped
   * back along the lunge so the body reads as having arrived from there.
   */
  function spawnGhosts(entity, dx, dy, color) {
    if (!entity || !entity.glyph) return;
    const len = Math.hypot(dx, dy) || GHOST_STEP;
    const ux = dx / len;
    const uy = dy / len;
    for (let i = 0; i < GHOST_STEPS; i += 1) {
      const back = (i + 1) * GHOST_STEP;
      ghosts.push({
        x: entity.x - ux * back,
        y: entity.y - uy * back,
        glyph: entity.glyph,
        color,
        life: GHOST_LIFE * (1 - i * 0.18),
        max: GHOST_LIFE,
      });
    }
    if (ghosts.length > MAX_GHOSTS) {
      ghosts = ghosts.slice(ghosts.length - MAX_GHOSTS);
    }
  }

  function flashEntity(entity, life = 0.16) {
    if (!entity) return;
    flashes.set(entity.id, { life, max: life });
  }

  function nudge(entity, options = {}) {
    if (!entity) return;
    const { dx = 0, dy = 0, life = 0.2, pop = 0, trail = false, color = NEON.white } = options;
    motions.set(entity.id, { dx, dy, life, max: life, pop });
    // Only a lunge asks for a trail; a knockback or a sidestep just moves.
    if (trail) spawnGhosts(entity, dx, dy, color);
  }

  function addShake(mag, life) {
    // Keep the strongest request rather than stacking, so a burst of hits in one
    // enemy phase does not rattle the screen off its axis.
    if (mag * life <= shake.mag * shake.life) return;
    shake = { life, max: life, mag };
  }

  function addTint(color, alpha, life) {
    tint = { color, alpha, life, max: life };
  }

  /**
   * One more landed blow in the chain. Hits that arrive inside COMBO_WINDOW of
   * PRESENTATION time escalate the counter; `update` spends the window, and the
   * level drops back to 0 the moment it lapses. A whiff never calls this.
   */
  function bumpCombo() {
    comboTimer = COMBO_WINDOW;
    comboLevel = Math.min(COMBO_MAX, comboLevel + 1);
    return comboLevel;
  }

  /**
   * Arm the full freeze plus the slow-mo that follows it. A kill during an
   * ongoing freeze extends it instead of shortening it, so a burst of blows in
   * one enemy phase cannot thrash the clock.
   */
  function armTimeJuice() {
    hitStop = Math.max(hitStop, HIT_STOP);
    slowMo = Math.max(slowMo, SLOW_MO);
  }

  /**
   * Consume `dt` of REAL time from the hit-stop/slow-mo and return how much
   * PRESENTATION time this frame is worth. Spending real seconds here is what
   * keeps a freeze from latching: `update` is handed the unscaled frame dt, so a
   * frozen frame still ages its own timer.
   */
  function advanceJuice(dt) {
    let rest = dt;
    if (hitStop > 0) {
      const frozen = Math.min(rest, hitStop);
      hitStop -= frozen;
      rest -= frozen;
      if (hitStop > 0) return 0; // still frozen: presentation time stands still
    }
    if (slowMo > 0) {
      const slow = Math.min(rest, slowMo);
      slowMo -= slow;
      return slow * SLOW_MO_SCALE + (rest - slow);
    }
    return rest;
  }

  /**
   * The presentation time scale, for main.js and the debug probe: 0 during a
   * hit-stop, the slow-mo factor while the slowdown runs, 1 once fully settled.
   */
  function timeScale() {
    if (reducedMotion) return 1;
    if (hitStop > 0) return 0;
    if (slowMo > 0) return SLOW_MO_SCALE;
    return 1;
  }

  // ---------- events -> effects ----------

  function attackFx(event) {
    const { actor, target } = event;
    const tx = target.x;
    const ty = target.y;
    const lx = Math.sign(tx - actor.x) || 1;
    const ly = Math.sign(ty - actor.y) || 0;
    const aimed = Math.atan2(ty - actor.y, tx - actor.x) || 0;

    if (event.dodged) {
      spawnFloater(tx, ty - 0.15, 'MISS', { color: NEON.miss, size: 0.3, life: 0.7 });
      spawnRing(tx, ty, { color: NEON.miss, life: 0.3, radius: 0.7, width: 2 });
      // A quick sidestep, perpendicular to the incoming blow.
      nudge(target, { dx: -ly * 0.26, dy: lx * 0.26, life: 0.22, pop: 0.05 });
      return;
    }

    const crit = Boolean(event.crit);
    const onPlayer = target.kind === 'player';
    const blood = onPlayer ? NEON.cyan : bloodFor(target);

    // Time juice: a crit or a killing blow gets a full freeze plus a slow-mo. A
    // plain hit does not — otherwise every exchange would stutter.
    if (crit || event.killed) armTimeJuice();

    // Combo escalation: a landed blow chains onto the previous one when it arrives
    // inside the window. Each step widens the burst and walks its colour from the
    // creature's blood toward the payoff gold. At level 1 nothing shifts, so a
    // lone hit looks exactly as it always did. Only the HERO's blows build the
    // chain: a foe landing three hits in a row must not paint the hero's own hurt
    // burst in the payoff gold.
    const combo = onPlayer ? 1 : bumpCombo();
    const heat = (combo - 1) / (COMBO_MAX - 1);
    const swing = heat > 0 ? mixHex(blood, NEON.crit, heat) : blood;
    const boost = 1 + (combo - 1) * 0.45;

    // The blade arc: a slice of a ring centred on the target whose opening faces
    // back down the blow, so it reads as a swing rather than as an explosion.
    spawnArc(tx, ty, {
      angle: aimed + Math.PI,
      spread: SWOOSH_SPREAD * (crit ? 1.25 : 1),
      radius: SWOOSH_RADIUS * (crit ? 1.2 : 1),
      color: swing,
      life: SWOOSH_LIFE,
    });

    // Attacker lunges in (dragging an afterimage behind it); the target is knocked
    // back and pops.
    nudge(actor, {
      dx: lx * 0.16,
      dy: ly * 0.16,
      life: 0.16,
      pop: 0.06,
      trail: true,
      color: actor.kind === 'player' ? NEON.cyan : bloodFor(actor),
    });
    nudge(target, { dx: lx * 0.22, dy: ly * 0.22, life: 0.2, pop: crit ? 0.45 : 0.28 });
    flashEntity(target, crit ? 0.24 : 0.16);

    spawnFloater(tx, ty - 0.22, `-${event.damage}`, {
      color: crit ? NEON.crit : onPlayer ? NEON.hurt : NEON.white,
      size: crit ? 0.5 : 0.34,
      life: crit ? 1.1 : 0.85,
    });
    spawnParticles(tx, ty, {
      count: Math.round((crit ? 18 : 10) * boost),
      color: swing,
      speed: crit ? 5.2 : 3.4,
      life: 0.45,
      size: 0.15 * (1 + (combo - 1) * 0.12),
      angle: aimed,
      spread: crit ? TAU * 0.8 : 1.6,
      gravity: 6,
      drag: 3,
      // A crit streaks; an ordinary wound keeps the chunky bits.
      shape: crit ? 'spark' : 'square',
    });

    if (crit) {
      spawnRing(tx, ty, { color: NEON.crit, life: 0.4, radius: 1.1, width: 3 });
      spawnParticles(tx, ty, {
        count: 10,
        color: NEON.crit,
        speed: 5.4,
        life: 0.5,
        size: 0.12,
        gravity: 2,
        drag: 2.4,
        opacity: 0.9,
        shape: 'spark',
      });
      addTint(NEON.crit, 0.13, 0.22);
    }

    if (onPlayer) {
      addShake(crit ? 7 : 4, crit ? 0.32 : 0.22);
      addTint(NEON.enemy, crit ? 0.2 : 0.11, 0.24);
      // Taking a blow is its own shockwave: a cyan wave off the hero plus a few
      // embers that drift up, so a hurt hero reads as loudly as a struck foe.
      spawnRing(tx, ty, {
        color: NEON.cyan,
        life: crit ? 0.5 : 0.38,
        radius: crit ? 1.5 : 1.1,
        width: crit ? 3 : 2,
      });
      spawnParticles(tx, ty, {
        count: crit ? 12 : 7,
        color: NEON.cyan,
        speed: crit ? 3.4 : 2.2,
        life: 0.5,
        size: 0.12,
        gravity: -2.6,
        drag: 2.2,
        shape: 'spark',
      });
    }

    // Any death dissolves the corpse, the hero's included: `endRun()` holds the
    // screen briefly, and a hard cut to nothing would waste it. The shockwave and
    // the burst belong to a fallen foe, so they stay enemy-only.
    if (event.killed) {
      corpses.set(target.id, { life: 0.45, max: 0.45 });
      if (!onPlayer) {
        spawnRing(tx, ty, { color: blood, life: 0.45, radius: 1.35, width: 2 });
        spawnParticles(tx, ty, {
          count: 20,
          color: blood,
          speed: 4.6,
          life: 0.6,
          size: 0.17,
          gravity: 5,
          drag: 2,
          shape: 'spark',
        });
      }
      // Embers glow off the corpse tile from the instant it falls — a one-shot at
      // kill time, never driven by the dissolve timer, so the fade is never the
      // only thing a body does. Warm, so it reads as embers and not as more blood.
      spawnParticles(tx, ty, {
        count: 6,
        color: mixHex(blood, NEON.crit, 0.55),
        speed: 1.1,
        life: 0.85,
        size: 0.1,
        gravity: -2.4,
        drag: 1.5,
        opacity: 0.9,
        shape: 'spark',
      });
    }
  }

  function applyEvent(event, game) {
    switch (event.type) {
      case 'move': {
        if (event.actor.kind === 'player') {
          spawnParticles(event.to.x, event.to.y, {
            count: 4,
            color: NEON.dust,
            speed: 1.2,
            life: 0.35,
            size: 0.11,
            gravity: -0.8,
            drag: 4,
            opacity: 0.5,
          });
        }
        break;
      }

      case 'attack':
        attackFx(event);
        break;

      case 'pickup': {
        const p = game && game.player;
        const x = p ? p.x : 0;
        const y = p ? p.y : 0;
        spawnRing(x, y, { color: NEON.item, life: 0.4, radius: 0.9, width: 2 });
        // A second, slower ring lifts off the tile as the item is claimed.
        spawnRing(x, y, { color: NEON.item, life: 0.55, radius: 1.1, width: 2, vy: -0.5 });
        spawnParticles(x, y, {
          count: 12,
          color: NEON.item,
          speed: 2.6,
          life: 0.55,
          size: 0.12,
          gravity: -2,
          drag: 2,
        });
        // A few white-hot sparkles ride the same burst, so the pickup glitters.
        spawnParticles(x, y, {
          count: 7,
          color: NEON.bloom,
          speed: 3.1,
          life: 0.45,
          size: 0.09,
          gravity: -3.4,
          drag: 2.2,
          shape: 'spark',
        });
        spawnFloater(x, y - 0.28, event.name ?? 'Item', { color: NEON.item, size: 0.26, life: 0.9 });
        break;
      }

      case 'drop': {
        const a = event.actor;
        spawnParticles(a.x, a.y, {
          count: 6,
          color: NEON.item,
          speed: 1.7,
          life: 0.45,
          size: 0.1,
          gravity: 4,
          drag: 3,
          opacity: 0.8,
        });
        break;
      }

      case 'levelup': {
        const p = game && game.player;
        if (!p) break;
        spawnRing(p.x, p.y, { color: NEON.crit, life: 0.6, radius: 1.7, width: 3 });
        spawnParticles(p.x, p.y, {
          count: 30,
          color: NEON.crit,
          speed: 5,
          life: 0.9,
          size: 0.14,
          gravity: -1.5,
          drag: 1.6,
        });
        spawnFloater(p.x, p.y - 0.45, 'LEVEL UP', { color: NEON.crit, size: 0.42, life: 1.3 });
        addTint(NEON.crit, 0.15, 0.4);
        break;
      }

      case 'descend': {
        const p = game && game.player;
        addTint(NEON.cyan, 0.15, 0.35);
        if (p) {
          spawnParticles(p.x, p.y, {
            count: 24,
            color: NEON.cyan,
            speed: 2.6,
            life: 0.7,
            size: 0.12,
            gravity: 3,
            drag: 2,
          });
        }
        break;
      }

      case 'gameover': {
        const p = game && game.player;
        if (event.victory) {
          addTint(NEON.crit, 0.18, 0.6);
          if (p) {
            spawnParticles(p.x, p.y, {
              count: 40,
              color: NEON.crit,
              speed: 6,
              life: 1.1,
              size: 0.15,
              gravity: -1.2,
              drag: 1.4,
            });
          }
        } else {
          addTint(NEON.enemy, 0.22, 0.7);
          addShake(8, 0.4);
        }
        break;
      }

      default:
        break;
    }
  }

  function emit(events, game) {
    if (reducedMotion) return;
    const list = Array.isArray(events) ? events : [events];
    for (const event of list) {
      if (event && event.type) applyEvent(event, game);
    }
  }

  // ---------- advancing ----------

  function decayMap(map, dt) {
    for (const [id, value] of map) {
      value.life -= dt;
      if (value.life <= 0) map.delete(id);
    }
  }

  function update(dt, game) {
    clock += dt;
    lowHp =
      !reducedMotion &&
      Boolean(game && game.player && game.player.maxHp > 0) &&
      game.player.hp / game.player.maxHp <= LOW_HP;

    if (reducedMotion) return;

    // Presentation time for this frame: the hit-stop/slow-mo warp it, while their
    // own timers are spent in real time (see advanceJuice), so they always end.
    const pdt = advanceJuice(dt);

    for (const p of particles) {
      const k = Math.exp(-p.drag * pdt);
      p.vx *= k;
      p.vy = p.vy * k + p.gravity * pdt;
      p.x += p.vx * pdt;
      p.y += p.vy * pdt;
      p.life -= pdt;
    }
    particles = particles.filter((p) => p.life > 0);

    for (const f of floaters) {
      f.vy *= Math.exp(-1.8 * pdt);
      f.y += f.vy * pdt;
      f.life -= pdt;
    }
    floaters = floaters.filter((f) => f.life > 0);

    for (const r of rings) {
      r.y += (r.vy ?? 0) * pdt;
      r.life -= pdt;
    }
    rings = rings.filter((r) => r.life > 0);

    for (const s of arcs) s.life -= pdt;
    arcs = arcs.filter((s) => s.life > 0);

    for (const g of ghosts) g.life -= pdt;
    ghosts = ghosts.filter((g) => g.life > 0);

    // The combo window is spent in PRESENTATION time, so the escalation reads the
    // same whether the blows landed at full speed or inside a slow-mo.
    if (comboTimer > 0) {
      comboTimer -= pdt;
      if (comboTimer <= 0) {
        comboTimer = 0;
        comboLevel = 0; // the chain lapsed
      }
    }

    // Entity-attached overlays deliberately decay in REAL time: a hit flash or a
    // corpse dissolve must stay locked to the turn that produced it, and a freeze
    // that held a dead actor visible would read as a hang, not as impact.
    decayMap(flashes, dt);
    decayMap(motions, dt);
    decayMap(corpses, dt);

    if (shake.life > 0) shake.life -= pdt;
    if (tint.life > 0) tint.life -= pdt;
  }

  function idle() {
    return (
      particles.length === 0 &&
      floaters.length === 0 &&
      rings.length === 0 &&
      arcs.length === 0 &&
      ghosts.length === 0 &&
      flashes.size === 0 &&
      motions.size === 0 &&
      corpses.size === 0 &&
      shake.life <= 0 &&
      tint.life <= 0 &&
      hitStop <= 0 &&
      slowMo <= 0 &&
      comboTimer <= 0 &&
      !lowHp
    );
  }

  function reset() {
    particles = [];
    floaters = [];
    rings = [];
    arcs = [];
    ghosts = [];
    flashes = new Map();
    motions = new Map();
    corpses = new Map();
    shake = { life: 0, max: 0, mag: 0 };
    tint = { life: 0, max: 0, color: NEON.white, alpha: 0 };
    hitStop = 0;
    slowMo = 0;
    comboLevel = 0;
    comboTimer = 0;
    lowHp = false;
  }

  // ---------- readouts for the renderer ----------

  /** Screen-shake offset in CSS pixels, or null when settled. */
  function shakeOffset() {
    if (shake.life <= 0) return null;
    const t = shake.life / shake.max;
    const mag = shake.mag * t * t;
    return { x: (Math.random() - 0.5) * 2 * mag, y: (Math.random() - 0.5) * 2 * mag };
  }

  /**
   * Per-entity draw overrides. `alpha` is 1 for a living actor and the death
   * dissolve for a corpse, so the renderer can keep drawing a dead entity until
   * it has faded out (`game.entities` never drops the dead).
   */
  function visualFor(entity) {
    const motion = motions.get(entity.id);
    const flash = flashes.get(entity.id);
    const corpse = corpses.get(entity.id);
    const t = motion ? motion.life / motion.max : 0;
    const ease = t * t;
    const fade = entity.alive ? 1 : corpse ? corpse.life / corpse.max : 0;

    return {
      dx: motion ? motion.dx * ease : 0,
      dy: motion ? motion.dy * ease : 0,
      scale: (entity.alive ? 1 : 0.55 + 0.45 * fade) * (1 + (motion ? motion.pop : 0) * ease),
      flash: flash ? Math.pow(flash.life / flash.max, 1.5) : 0,
      alpha: fade,
    };
  }

  /** The overlay pass: blasts, debris, floating text, tints and the vignette. */
  function overlay(ctx, game, size, view = null) {
    if (reducedMotion || !game) return;

    if (tint.life > 0) {
      ctx.save();
      ctx.globalAlpha = tint.alpha * (tint.life / tint.max);
      ctx.fillStyle = tint.color;
      const w = view ? view.w * size : game.map.width * size;
      const h = view ? view.h * size : game.map.height * size;
      ctx.fillRect(-EDGE_PAD, -EDGE_PAD, w + EDGE_PAD * 2, h + EDGE_PAD * 2);
      ctx.restore();
    }

    drawVignette(ctx, game, size, view);

    // Afterimages of a lunging actor, painted UNDER the debris so the trail reads
    // as where the body just was rather than as something flying past it. Additive
    // like everything else here, so a smear brightens the smear of the next blow.
    if (ghosts.length > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.max(9, Math.round(size * GHOST_FONT))}px "Cascadia Mono", Consolas, "Courier New", monospace`;
      for (const g of ghosts) {
        ctx.globalAlpha = GHOST_ALPHA * (g.life / g.max);
        ctx.fillStyle = g.color;
        ctx.fillText(g.glyph, g.x * size + size / 2, g.y * size + size / 2);
      }
      ctx.restore();
    }

    // Afterimages of a lunging actor, painted UNDER the debris so the trail reads
    // as where the body just was rather than as something flying past it. Additive
    // like everything else here, so a smear brightens the smear of the next blow.
    if (ghosts.length > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.max(9, Math.round(size * GHOST_FONT))}px "Cascadia Mono", Consolas, "Courier New", monospace`;
      for (const g of ghosts) {
        ctx.globalAlpha = GHOST_ALPHA * (g.life / g.max);
        ctx.fillStyle = g.color;
        ctx.fillText(g.glyph, g.x * size + size / 2, g.y * size + size / 2);
      }
      ctx.restore();
    }

    ctx.save();
    ctx.lineJoin = 'round';
    // Additive blending is what gives the neon bloom: overlapping glows brighten
    // toward white instead of flat-painting over each other.
    ctx.globalCompositeOperation = 'lighter';
    for (const r of rings) {
      const t = 1 - r.life / r.max;
      const radius = (r.start + (r.radius - r.start) * t) * size;
      const cx = r.x * size + size / 2;
      const cy = r.y * size + size / 2;
      const fade = r.life / r.max;
      // The wide coloured band is the wave; the thin incandescent line riding just
      // inside it is its leading edge, which is what makes the pair read as energy
      // rather than as a thin pencil stroke.
      ctx.globalAlpha = fade * 0.85;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.stroke();

      ctx.globalAlpha = fade * 0.9;
      ctx.strokeStyle = NEON.bloom;
      ctx.lineWidth = Math.max(1, r.width * 0.4);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, radius - r.width * 0.5), 0, TAU);
      ctx.stroke();

      // Second, wider and dimmer copy of the coloured band: the same fake bloom
      // the particles get, so a shockwave glows instead of sitting flat.
      ctx.globalAlpha = fade * BLOOM_ALPHA;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, r.width * BLOOM_GROW);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.stroke();
    }

    // The blade arcs: a SLICE of a ring (`arc` between two angles, never a full
    // turn), tapering as it fades with a white-hot edge riding inside it. That is
    // what makes a landed blow read as a swing rather than as an explosion.
    for (const s of arcs) {
      const t = 1 - s.life / s.max;
      const cx = s.x * size + size / 2;
      const cy = s.y * size + size / 2;
      const fade = s.life / s.max;
      const radius = s.radius * (0.86 + 0.14 * t) * size;
      const a0 = s.angle - s.spread / 2;
      const a1 = s.angle + s.spread / 2;

      ctx.lineCap = 'round';
      ctx.globalAlpha = fade * 0.7;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(1, s.width * (1 - 0.4 * t));
      ctx.beginPath();
      ctx.arc(cx, cy, radius, a0, a1);
      ctx.stroke();

      ctx.globalAlpha = fade * 0.9;
      ctx.strokeStyle = NEON.bloom;
      ctx.lineWidth = Math.max(1, s.width * 0.4);
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.92, a0, a1);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    // Additive blending again: it is what makes the particle bursts bloom.
    ctx.globalCompositeOperation = 'lighter';
    // A minimal 2d-like context (the Node test fake) may not expose the path API;
    // a real canvas always does. A streak is a flourish on top of the core, so
    // skipping it costs length and nothing else.
    const canStreak = typeof ctx.moveTo === 'function' && typeof ctx.lineTo === 'function';
    for (const p of particles) {
      // Bright at birth, not a linear fade: `a` stays high for most of the life,
      // which is what keeps a fresh burst white-hot instead of immediately dull.
      const a = Math.pow(p.life / p.max, ALPHA_CURVE);
      const cx = p.x * size + size / 2;
      const cy = p.y * size + size / 2;
      // The size decays slowly on purpose: the bits must stay chunky for most of
      // their life rather than collapsing to a dot in the first frames.
      const s = Math.max(1, p.size * size * (SIZE_FLOOR + (1 - SIZE_FLOOR) * a));
      const spark = p.shape === 'spark';

      // Halo: a wide, dim wash of the particle's own colour, painted additively.
      ctx.globalAlpha = a * p.opacity * 0.35;
      ctx.fillStyle = p.color;
      const halo = s * 2.6;
      ctx.fillRect(cx - halo / 2, cy - halo / 2, halo, halo);

      if (spark) {
        // The velocity-stretched streak: its length is the particle's own speed,
        // so fast debris whips and slow embers barely smear.
        if (canStreak) {
          ctx.globalAlpha = a * p.opacity * 0.8;
          ctx.strokeStyle = p.color;
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(1, s * 0.55);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx - p.vx * size * STREAK, cy - p.vy * size * STREAK);
          ctx.stroke();
        }
        // Only the small crit/kill bursts carry a shadow halo; the general loop
        // (up to MAX_PARTICLES) stays on plain additive fills, which is cheap.
        // It is cleared inside the same iteration so it cannot bleed forward.
        ctx.shadowColor = p.color;
        ctx.shadowBlur = SPARK_GLOW;
      }

      // The incandescent core sits on top at (nearly) full alpha, so every bit has
      // a hot centre instead of being an evenly dim square.
      ctx.globalAlpha = Math.min(1, a * p.opacity);
      ctx.fillStyle = NEON.bloom;
      const core = Math.max(1, s * 0.45);
      ctx.fillRect(cx - core / 2, cy - core / 2, core, core);
      if (spark) ctx.shadowBlur = 0;
    }

    // Cheap second bloom pass: the same particles once more, larger and much
    // dimmer, all additively. Enough to fake a glow; `ctx.filter = 'blur(...)'`
    // is deliberately not used — it costs a full-surface blur every frame.
    for (const p of particles) {
      const a = Math.pow(p.life / p.max, ALPHA_CURVE);
      const cx = p.x * size + size / 2;
      const cy = p.y * size + size / 2;
      const s = Math.max(1, p.size * size * (SIZE_FLOOR + (1 - SIZE_FLOOR) * a));
      const glow = s * BLOOM_GROW;
      ctx.globalAlpha = a * p.opacity * BLOOM_ALPHA;
      ctx.fillStyle = p.color;
      ctx.fillRect(cx - glow / 2, cy - glow / 2, glow, glow);
    }
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of floaters) {
      const a = Math.min(1, f.life / f.max);
      const px = f.x * size + size / 2;
      const py = f.y * size + size / 2;
      ctx.globalAlpha = a;
      ctx.font = `bold ${Math.max(9, Math.round(f.size * size * floaterScale(f)))}px "Cascadia Mono", Consolas, "Courier New", monospace`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(4, 6, 10, 0.85)';
      ctx.strokeText(f.text, px, py);
      // The halo rides the fill only, so the dark outline stays crisp.
      ctx.shadowColor = f.color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, px, py);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  function drawVignette(ctx, game, size, view = null) {
    const player = game.player;
    if (!player || !player.maxHp) return;
    const ratio = player.hp / player.maxHp;
    if (ratio > LOW_HP) return;

    const intensity = 1 - ratio / LOW_HP;
    const pulse = 0.5 + 0.5 * Math.sin(clock * 6);
    const alpha = Math.min(0.5, (0.14 + intensity * 0.3) * intensity) * (0.68 + 0.32 * pulse);
    const w = view ? view.w * size : game.map.width * size;
    const h = view ? view.h * size : game.map.height * size;
    const grad = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.26,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.72,
    );
    grad.addColorStop(0, 'rgba(255, 40, 60, 0)');
    grad.addColorStop(1, `rgba(255, 40, 60, ${alpha.toFixed(3)})`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(-EDGE_PAD, -EDGE_PAD, w + EDGE_PAD * 2, h + EDGE_PAD * 2);
    ctx.restore();
  }

  /** Counts for tests and the debug probe (cheap, read-only). */
  function stats() {
    return {
      particles: particles.length,
      floaters: floaters.length,
      labels: floaters.map((f) => f.text),
      scales: floaters.map(floaterScale),
      rings: rings.length,
      arcs: arcs.length,
      ghosts: ghosts.length,
      combo: comboLevel,
      flashes: flashes.size,
      motions: motions.size,
      corpses: corpses.size,
      shaking: shake.life > 0,
      tint: tint.life > 0,
      lowHp,
      hitStop: hitStop > 0,
      slowMo: slowMo > 0,
      timeScale: timeScale(),
      /**
       * Peak alpha of the live full-screen wash, so a test can pin the hard
       * budget: the headless E2E's exact-colour probes only survive the washes
       * at the alphas the look was tuned to.
       */
      tintAlpha: tint.life > 0 ? tint.alpha : 0,
    };
  }

  return { emit, update, idle, reset, shakeOffset, visualFor, overlay, stats, timeScale };
}
