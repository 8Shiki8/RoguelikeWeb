/**
 * Synthesized sound effects — zero asset files, zero dependencies.
 *
 * Every sound is built from oscillators and short noise buffers through the
 * WebAudio API. The engine never sees any of this: `src/core` stays
 * presentation-free, and this module is imported only by `src/main.js`.
 *
 * Two pieces, on purpose:
 *   - `soundsFor(events)` is a PURE event -> sound-name mapping (no WebAudio at
 *     all), so `node --test` can pin the mapping without a browser, exactly like
 *     `src/ui/messages.js` pins the event -> text mapping.
 *   - `createSfx()` wraps a lazily-created AudioContext. Browsers refuse to start
 *     audio before a user gesture, so nothing is created until `unlock()` runs
 *     from the Start click; without WebAudio (e.g. in Node) every call is a safe
 *     no-op.
 */

/**
 * Map engine events to the sounds they should make, in order.
 *
 * `hurt*` is a blow LANDING ON the player, `hit`/`crit` a blow the player lands;
 * `death` is the player dying, `kill` an enemy dying. A dodge is silent on the
 * attacker's side and reads as a whoosh.
 *
 * The set of playable names is not declared here: it IS the recipe table inside
 * `createSfx()`, read back through `sfx.names`. A second hand-written list could
 * drift from the recipes it claims to describe.
 *
 * @param {object[]|object} events
 * @returns {string[]} sound names
 */
export function soundsFor(events) {
  const names = [];
  const list = Array.isArray(events) ? events : [events];
  for (const event of list) {
    if (!event || !event.type) continue;
    switch (event.type) {
      case 'move':
        if (event.actor && event.actor.kind === 'player') names.push('step');
        break;
      case 'blocked':
        names.push(event.reason === 'wall' ? 'bump' : 'whiff');
        break;
      case 'attack':
        if (event.dodged) {
          names.push('dodge');
        } else if (event.target && event.target.kind === 'player') {
          names.push(event.killed ? 'death' : event.crit ? 'hurtCrit' : 'hurt');
        } else {
          names.push(event.crit ? 'crit' : 'hit');
          if (event.killed) names.push('kill');
        }
        break;
      case 'pickup':
        names.push('pickup');
        break;
      case 'drop':
        names.push('drop');
        break;
      case 'equip':
        names.push('equip');
        break;
      case 'unequip':
        names.push('unequip');
        break;
      case 'levelup':
        names.push('levelup');
        break;
      case 'descend':
        names.push('descend');
        break;
      case 'gameover':
        names.push(event.victory ? 'victory' : event.winner === 'player' ? 'cleared' : 'gameover');
        break;
      default:
        break;
    }
  }
  return names;
}

/** @returns {object} a safe, no-op-safe sound engine. */
export function createSfx() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let muted = false;
  let started = []; // timestamps of recently started voices, for a soft polyphony cap

  function supported() {
    return Boolean(globalThis.AudioContext || globalThis.webkitAudioContext);
  }

  function ensure() {
    if (ctx) return ctx;
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    return ctx;
  }

  /** Called from a user gesture (the Start click) to satisfy autoplay policy. */
  function unlock() {
    const c = ensure();
    if (!c) return false;
    if (c.state === 'suspended' && typeof c.resume === 'function') c.resume();
    return true;
  }

  function getNoise() {
    if (noiseBuffer) return noiseBuffer;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
    noiseBuffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  /** A pitched blip with an exponential envelope, optionally sweeping. */
  function tone({ freq, freqTo = 0, type = 'sine', dur = 0.12, gain = 0.3, delay = 0 }) {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** A filtered noise burst — the "body" of hits, whooshes and thuds. */
  function noise({ dur = 0.12, gain = 0.25, freq = 1400, freqTo = 0, q = 1, type = 'bandpass', delay = 0 }) {
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = getNoise();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    filter.Q.value = q;
    if (freqTo) filter.frequency.exponentialRampToValueAtTime(Math.max(40, freqTo), t0 + dur);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(amp).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /** One recipe per name: a small orchestration of tone()/noise(). */
  const RECIPES = {
    step: () => noise({ dur: 0.05, gain: 0.06, freq: 700, freqTo: 380, q: 0.8, type: 'lowpass' }),
    bump: () => {
      noise({ dur: 0.09, gain: 0.16, freq: 320, freqTo: 140, type: 'lowpass' });
      tone({ freq: 96, freqTo: 60, type: 'square', dur: 0.09, gain: 0.12 });
    },
    whiff: () => noise({ dur: 0.14, gain: 0.1, freq: 1800, freqTo: 500, q: 0.7 }),
    hit: () => {
      noise({ dur: 0.08, gain: 0.26, freq: 1700, freqTo: 500 });
      tone({ freq: 190, freqTo: 90, type: 'square', dur: 0.09, gain: 0.16 });
    },
    crit: () => {
      noise({ dur: 0.13, gain: 0.3, freq: 2600, freqTo: 700 });
      tone({ freq: 420, freqTo: 900, type: 'sawtooth', dur: 0.12, gain: 0.16 });
      tone({ freq: 900, freqTo: 1500, type: 'square', dur: 0.1, gain: 0.1, delay: 0.04 });
    },
    kill: () => {
      tone({ freq: 320, freqTo: 70, type: 'square', dur: 0.32, gain: 0.18 });
      noise({ dur: 0.34, gain: 0.22, freq: 1300, freqTo: 180 });
    },
    hurt: () => {
      tone({ freq: 220, freqTo: 110, type: 'sawtooth', dur: 0.18, gain: 0.2 });
      noise({ dur: 0.14, gain: 0.18, freq: 900, freqTo: 300, type: 'lowpass' });
    },
    hurtCrit: () => {
      tone({ freq: 300, freqTo: 90, type: 'sawtooth', dur: 0.3, gain: 0.24 });
      noise({ dur: 0.26, gain: 0.24, freq: 1500, freqTo: 260 });
      tone({ freq: 700, freqTo: 220, type: 'square', dur: 0.22, gain: 0.1, delay: 0.02 });
    },
    death: () => {
      tone({ freq: 260, freqTo: 40, type: 'sawtooth', dur: 0.7, gain: 0.26 });
      tone({ freq: 130, freqTo: 30, type: 'square', dur: 0.8, gain: 0.18, delay: 0.05 });
      noise({ dur: 0.6, gain: 0.16, freq: 900, freqTo: 120, type: 'lowpass' });
    },
    dodge: () => noise({ dur: 0.18, gain: 0.14, freq: 500, freqTo: 2600, q: 0.7 }),
    pickup: () => {
      tone({ freq: 660, type: 'triangle', dur: 0.09, gain: 0.2 });
      tone({ freq: 990, type: 'triangle', dur: 0.13, gain: 0.2, delay: 0.075 });
    },
    drop: () => tone({ freq: 300, freqTo: 180, type: 'triangle', dur: 0.12, gain: 0.14 }),
    equip: () => {
      tone({ freq: 520, freqTo: 700, type: 'triangle', dur: 0.1, gain: 0.18 });
      noise({ dur: 0.06, gain: 0.08, freq: 2600, q: 1.2 });
    },
    unequip: () => tone({ freq: 420, freqTo: 260, type: 'triangle', dur: 0.12, gain: 0.15 }),
    levelup: () => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone({ freq: f, type: 'triangle', dur: 0.22, gain: 0.2, delay: i * 0.085 }),
      );
    },
    descend: () => {
      tone({ freq: 700, freqTo: 140, type: 'triangle', dur: 0.5, gain: 0.18 });
      noise({ dur: 0.45, gain: 0.1, freq: 1600, freqTo: 200 });
    },
    victory: () => {
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) =>
        tone({ freq: f, type: 'triangle', dur: 0.34, gain: 0.2, delay: i * 0.12 }),
      );
      noise({ dur: 0.5, gain: 0.08, freq: 3000, freqTo: 1200, delay: 0.4 });
    },
    cleared: () => {
      [392, 523.25, 659.25].forEach((f, i) =>
        tone({ freq: f, type: 'triangle', dur: 0.26, gain: 0.18, delay: i * 0.1 }),
      );
    },
    gameover: () => {
      [330, 261.63, 196].forEach((f, i) =>
        tone({ freq: f, freqTo: f * 0.94, type: 'sawtooth', dur: 0.5, gain: 0.18, delay: i * 0.16 }),
      );
    },
    ui: () => tone({ freq: 880, type: 'square', dur: 0.05, gain: 0.1 }),
  };

  /**
   * Soft polyphony guard: a turn can land several blows, and stacking 20 voices
   * would clip. Past a dozen starts in 60 ms the extras are dropped, not queued.
   *
   * The window is WALL-CLOCK on purpose. `ctx.currentTime` does not advance while
   * the context is suspended (before the first resume, or in a headless browser
   * where a synthetic click is not a user activation); a frozen clock would make
   * every old timestamp look fresh and latch the guard on forever.
   */
  function overloaded() {
    const now = performance.now();
    started = started.filter((t) => now - t < 60);
    if (started.length >= 12) return true;
    started.push(now);
    return false;
  }

  function play(name) {
    const recipe = RECIPES[name];
    if (!recipe || muted) return false;
    const c = ensure();
    if (!c) return false;
    if (c.state === 'suspended' && typeof c.resume === 'function') c.resume();
    if (overloaded()) return false;
    try {
      recipe();
      return true;
    } catch {
      return false;
    }
  }

  function playEvents(events) {
    const names = soundsFor(events);
    for (const name of names) play(name);
    return names.length;
  }

  function setMuted(value) {
    muted = Boolean(value);
    if (master) master.gain.value = muted ? 0 : 0.5;
    return muted;
  }

  return {
    unlock,
    play,
    playEvents,
    setMuted,
    isMuted: () => muted,
    supported,
    /** The playable names, read straight off the recipe table. */
    names: Object.freeze(Object.keys(RECIPES)),
  };
}
