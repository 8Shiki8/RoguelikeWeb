/**
 * The level-up dialog: a modal overlay opened from main.js when a level-up
 * arrives. Like the panel, it is a pure reader of game state (see
 * src/core/game.js): it renders what it is given and mutates nothing. The
 * open/closed flag, the hotkeys and every point spend live in main.js.
 */

import { LEVEL_STATS } from '../core/game.js';

/**
 * @param {HTMLElement} root the `#levelup` element from index.html
 * @returns {{render: (game: object, options: {open: boolean}) => void, refs: object}}
 */
export function createLevelUpDialog(root) {
  if (!root) throw new Error('Level-up dialog root is missing');
  const points = pick(root, 'points');
  const grid = pick(root, 'levelup-buttons');
  const hint = pick(root, 'levelup-keys');

  // The dialog markup is static in index.html, but a new run re-enters this
  // factory over the same elements: clear the grid so buttons never stack up.
  grid.replaceChildren();

  // One button per distributable stat — generated from the core's LEVEL_STATS so
  // the dialog can never drift from what applyLevelUpPoint accepts. `data-stat`
  // is what the click handler reads; `data-role` is kept for E2E selectors.
  const buttons = LEVEL_STATS.map((stat) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.role = `btn-${stat.key}`;
    button.dataset.stat = stat.key;
    button.title = `${stat.label}: +${stat.amount} per point${stat.cap == null ? '' : `, up to ${stat.cap}`}`;
    grid.append(button);
    return { stat, button };
  });

  hint.textContent = `${LEVEL_STATS.map((s) => `${s.hotkey.toUpperCase()}=${s.short}`).join(', ')}  ·  Esc/Later to postpone`;

  function render(game, { open }) {
    root.hidden = !open;
    const player = game && game.player ? game.player : null;
    points.textContent = String(player ? player.pointsUnspent || 0 : 0);
    // Each label previews the live value and what the point would add, clamped
    // to the cap so the preview can never promise past it.
    for (const { stat, button } of buttons) {
      const current = player ? player[stat.key] || 0 : 0;
      const next = stat.cap == null ? current + stat.amount : Math.min(stat.cap, current + stat.amount);
      button.textContent = `${stat.short} ${current} → ${next} (${stat.hotkey.toUpperCase()})`;
    }
  }

  return { render, refs: { root, points, grid, hint } };
}

function pick(root, role) {
  const element = root.querySelector(`[data-role="${role}"]`);
  if (!element) throw new Error(`Level-up element "${role}" is missing`);
  return element;
}
