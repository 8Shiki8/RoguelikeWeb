/**
 * Canvas 2D presentation layer.
 *
 * Pure drawing: it reads game state (plus the presentation-only effects state)
 * and never mutates it, and it advances no turns. Drawn glyphs/tiles are the
 * FALLBACK: when the authored data carries a `spritePath` (entities, items) or
 * a biome tile path (`data.biomas`), and the image is loaded, the sprite is
 * drawn instead — otherwise exactly the shape drawn before sprites existed.
 *
 * `fx` is optional: without it the renderer draws the plain static frame, which
 * is what keeps it usable on its own. So is `sprites` (see createRenderer).
 */

import { Tile, tileAt } from '../map/tiles.js';

export const PALETTE = Object.freeze({
  background: '#0b0d12',
  floor: '#161b25',
  floorAlt: '#131822',
  wall: '#2b3446',
  wallEdge: '#3b4761',
  player: '#7cf0ff',
  enemy: '#ff7a7a',
  stairs: '#ffd166',
  item: '#c9a0ff',
  glyph: '#e6edf6',
  hpTrack: '#2a1418',
  hpLost: '#4a2229',
  hpFill: '#ff5d5d',
  flash: '#ffffff',
});

const GLYPH_FONT = '"Cascadia Mono", Consolas, "Courier New", monospace';
const STAIRS_GLYPH = '>';
const TAU = Math.PI * 2;
/** Padding around the scene so a screen shake never reveals a stale edge. */
const SHAKE_PAD = 16;
/** The neutral per-entity visual used when no effects system is present. */
const STATIC_VISUAL = Object.freeze({ dx: 0, dy: 0, scale: 1, flash: 0, alpha: 1 });

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{tileSize:number, cols?:number, rows?:number, sprites?:{get:(path:string)=>HTMLImageElement|null}|null}} options
 *   `sprites` is the cache from src/render/sprites.js. Omitted/`null` means
 *   "always draw the glyphs", which is how the tests and the no-sprite path run.
 *   When `cols`/`rows` are provided the renderer draws a fixed window centred on
 *   the player instead of the entire map; otherwise it falls back to the old
 *   "draw the whole map" behaviour so existing callers keep working.
 */
export function createRenderer(canvas, { tileSize, cols = null, rows = null, sprites = null } = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context is unavailable');
  let deviceScale = 1;

  let viewCols = cols;
  let viewRows = rows;
  let camX = 0;
  let camY = 0;

  function applyPixelPerfect() {
    ctx.imageSmoothingEnabled = false;
  }

  function resize(mapOrSize = null) {
    try {
      deviceScale = Math.min(window.devicePixelRatio || 1, 2);
      let cw = viewCols;
      let ch = viewRows;
      if (cw == null && mapOrSize && typeof mapOrSize.width === 'number') {
        cw = mapOrSize.width;
      }
      if (ch == null && mapOrSize && typeof mapOrSize.height === 'number') {
        ch = mapOrSize.height;
      }
      if (cw == null) cw = 1;
      if (ch == null) ch = 1;
      canvas.width = Math.round(cw * tileSize * deviceScale);
      canvas.height = Math.round(ch * tileSize * deviceScale);
      canvas.style.width = cw * tileSize + 'px';
      canvas.style.height = ch * tileSize + 'px';
      ctx.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
      applyPixelPerfect();
    } catch (e) {
      console.error('resize failed', e);
    }
  }

  function updateCamera(map, game) {
    if (!map) return;
    const cw = viewCols ?? map.width;
    const ch = viewRows ?? map.height;
    if (viewCols == null || viewRows == null) {
      camX = 0;
      camY = 0;
      return;
    }
    const entities = game && game.entities ? game.entities : map._entities || [];
    const player = Array.isArray(entities) ? entities.find((e) => e.kind === 'player') : game && game.player;
    const cx = player ? player.x + 0.5 : (cw - 1) / 2;
    const cy = player ? player.y + 0.5 : (ch - 1) / 2;
    camX = Math.floor(cx - cw / 2);
    camY = Math.floor(cy - ch / 2);
    camX = Math.max(0, Math.min(Math.max(0, map.width - cw), camX));
    camY = Math.max(0, Math.min(Math.max(0, map.height - ch), camY));
  }

  function viewRect(map) {
    const cw = viewCols ?? map.width;
    const ch = viewRows ?? map.height;
    return { x: camX, y: camY, w: cw, h: ch, px: camX * tileSize, py: camY * tileSize };
  }

  function draw(game, fx = null) {
    const map = game && game.map;
    if (!map) return;
    const cw = viewCols ?? map.width;
    const ch = viewRows ?? map.height;
    const w = cw * tileSize;
    const h = ch * tileSize;

    applyPixelPerfect();
    ctx.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
    const offset = fx ? fx.shakeOffset() : null;
    if (offset) ctx.translate(offset.x, offset.y);

    updateCamera(map, game);
    const vr = viewRect(map);
    ctx.fillStyle = PALETTE.background;
    ctx.fillRect(-SHAKE_PAD, -SHAKE_PAD, w + SHAKE_PAD * 2, h + SHAKE_PAD * 2);

    ctx.save();
    ctx.translate(-vr.px, -vr.py);
    drawTiles(ctx, map, tileSize, game._data && game._data.biomas, sprites);
    drawStairs(ctx, map, tileSize);
    drawGroundItems(ctx, game, tileSize, sprites);

    const entities = game.entities || [];
    for (let i = 0; i < entities.length; i += 1) {
      const entity = entities[i];
      const visual = fx ? fx.visualFor(entity) : STATIC_VISUAL;
      if (!entity.alive && visual.alpha <= 0) continue;
      drawEntity(ctx, entity, tileSize, visual, sprites);
    }
    if (fx) fx.overlay(ctx, game, tileSize, vr);
    ctx.restore();

    ctx.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
  }

  return { resize, draw, camera: () => ({ x: camX, y: camY, cols: viewCols, rows: viewRows }) };
}

/**
 * The loaded sprite for an authored path, or null — the single gate every
 * fallback in this file goes through (no cache / disabled / still loading /
 * failed all collapse to null here).
 */
function spriteImage(sprites, path) {
  return sprites && path ? sprites.get(path) : null;
}

/**
 * Tiles first: the biome sprite replaces the tile's fill ENTIRELY when it is
 * loaded, the colored fallback is drawn when it is not. Wall and floor are
 * resolved once per frame (the cache makes each per-tile get() a map hit).
 */
function drawTiles(ctx, map, size, biomas, sprites) {
  const wallSprite = spriteImage(sprites, biomas ? biomas.pared1 : null);
  const floorSprite = spriteImage(sprites, biomas ? biomas.piso1 : null);

  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const tile = tileAt(map, x, y);
      const px = x * size;
      const py = y * size;

      if (tile === Tile.WALL) {
        if (wallSprite) {
          ctx.drawImage(wallSprite, px, py, size, size);
          continue;
        }
        ctx.fillStyle = PALETTE.wall;
        ctx.fillRect(px, py, size, size);
        ctx.fillStyle = PALETTE.wallEdge;
        ctx.fillRect(px, py, size, 2);
        continue;
      }

      if (floorSprite) {
        ctx.drawImage(floorSprite, px, py, size, size);
        continue;
      }
      ctx.fillStyle = (x + y) % 2 === 0 ? PALETTE.floor : PALETTE.floorAlt;
      ctx.fillRect(px, py, size, size);
    }
  }
}

function drawStairs(ctx, map, size) {
  if (!map.stairs) return;
  const px = map.stairs.x * size;
  const py = map.stairs.y * size;

  // A steady halo, so the way down reads as a landmark rather than as furniture.
  // It is deliberately NOT time-modulated: the canvas repaints on input and only
  // while effects are live, so a wall-clock pulse would sit frozen between turns
  // and then jump phase on every key press.
  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = PALETTE.stairs;
  ctx.beginPath();
  ctx.arc(px + size / 2, py + size / 2, size * 0.46, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.font = `${Math.floor(size * 0.78)}px ${GLYPH_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PALETTE.stairs;
  ctx.fillText(STAIRS_GLYPH, px + size / 2, py + size / 2 + 1);
}

/**
 * Loot on the floor, one sprite (or glyph) per drop, each over a faint steady
 * glow so it never disappears into the floor pattern. The sprite comes from the
 * item definition's authored `spritePath`; no path = the glyph, as always.
 */
function drawGroundItems(ctx, game, size, sprites) {
  const ground = game.groundItems;
  if (!ground || ground.length === 0) return;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const drop of ground) {
    const definition = game._data.items.definitions[drop.item];
    if (!definition) continue;
    const cx = drop.x * size + size / 2;
    const cy = drop.y * size + size / 2;

    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = PALETTE.item;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.4, 0, TAU);
    ctx.fill();

    const sprite = spriteImage(sprites, definition.spritePath);
    if (sprite) {
      // Inset to 80% of the tile so the drop reads as an object ON the floor,
      // not as a tile of its own.
      const s = size * 0.8;
      ctx.globalAlpha = 0.95;
      ctx.drawImage(sprite, cx - s / 2, cy - s / 2, s, s);
    } else {
      ctx.globalAlpha = 0.95;
      ctx.font = `${Math.floor(size * 0.66)}px ${GLYPH_FONT}`;
      ctx.fillStyle = PALETTE.item;
      ctx.fillText(definition.glyph, cx, cy + 1);
    }
    ctx.restore();
  }
}

function drawEntity(ctx, entity, size, visual, sprites) {
  const scale = visual.scale || 1;
  const px = entity.x * size + visual.dx * size;
  const py = entity.y * size + visual.dy * size;
  const cx = px + size / 2;
  const cy = py + size / 2 + 1;
  const isPlayer = entity.kind === 'player';
  const body = isPlayer ? PALETTE.player : PALETTE.enemy;
  const sprite = spriteImage(sprites, entity.spritePath);

  // Steady halo so actors read clearly against the tiles (not time-modulated: see
  // drawStairs). For sprites the halo adds a soft blur-like glow that makes
  // pixel art look fuzzy; skip it when drawing a sprite and rely on the sprite
  // itself + hit flash + health bars for readability.
  if (!sprite) {
    ctx.save();
    ctx.globalAlpha = visual.alpha * (isPlayer ? 0.2 : 0.18);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy - 1, size * 0.46 * scale, 0, TAU);
    ctx.fill();
    ctx.restore();
  } else {
    // Very subtle halo under sprites only when not flashing, to avoid the
    // "blurred outline" look reported with nearest-neighbor.
    if (visual.flash <= 0) {
      ctx.save();
      ctx.globalAlpha = visual.alpha * 0.08;
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy - 1, size * 0.42 * scale, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  ctx.save();
  ctx.globalAlpha = visual.alpha;
  if (entity.facing === -1 || entity.facing === 'left') {
    ctx.translate(cx, cy);
    ctx.scale(-1, 1);
    ctx.translate(-cx, -cy);
  }
  if (sprite) {
    // Scaled around the tile center, so a lunge/knockback grows the sprite the
    // same way it grew the glyph.
    const s = size * scale;
    const sx = px + (size - s) / 2;
    const sy = py + (size - s) / 2;
    if (visual.flash > 0) {
      // A glyph is whitened by over-painting it; a sprite cannot be, so the
      // flash is a brightness filter instead. Browsers without `ctx.filter`
      // simply draw the unfiltered sprite — the halo and the bar still
      // communicate the hit, and nothing throws.
      ctx.filter = 'brightness(3)';
    }
    ctx.drawImage(sprite, sx, sy, s, s);
  } else {
    ctx.font = `${Math.floor(size * 0.72 * scale)}px ${GLYPH_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = body;
    ctx.fillText(entity.glyph, cx, cy);

    // The hit flash whitens the glyph on top, so a blow always reads instantly.
    if (visual.flash > 0) {
      ctx.globalAlpha = Math.min(1, visual.alpha * (0.3 + visual.flash));
      ctx.fillStyle = PALETTE.flash;
      ctx.fillText(entity.glyph, cx, cy);
    }
  }
  ctx.restore();

  // Health bars above HOSTILES. A boss is `kind === 'boss'`, not `'enemy'`, and
  // was the one actor drawn without a bar.
  if (entity.alive && (entity.kind === 'enemy' || entity.kind === 'boss')) {
    drawHealthBar(ctx, entity, px, py, size);
  }
}

function drawHealthBar(ctx, entity, px, py, size) {
  const barWidth = size - 6;
  const barHeight = 3;
  const barX = px + 3;
  const barY = py - barHeight - 2;
  const ratio = entity.maxHp === 0 ? 0 : entity.hp / entity.maxHp;
  const filled = Math.max(1, Math.round(barWidth * ratio));

  ctx.fillStyle = PALETTE.hpTrack;
  ctx.fillRect(barX, barY, barWidth, barHeight);
  // The dim red behind the fill is the damage already taken: a readable trail
  // the eye catches without reading the numbers.
  if (filled < barWidth) {
    ctx.fillStyle = PALETTE.hpLost;
    ctx.fillRect(barX + filled, barY, barWidth - filled, barHeight);
  }
  ctx.fillStyle = PALETTE.hpFill;
  ctx.fillRect(barX, barY, filled, barHeight);
}
