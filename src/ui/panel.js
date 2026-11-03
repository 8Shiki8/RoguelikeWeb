/**
 * DOM layer: the right-hand stats panel and the message log beneath the canvas.
 * Both are pure readers of game state (see src/core/game.js).
 */

import { formatLog, formatStatus } from './messages.js';
import { ITEM_BONUS_KEYS } from '../core/equipment.js';
import { ITEM_SLOTS } from '../data/index.js';

/**
 * @param {HTMLElement} root
 * @returns {{render: (game: object) => void}}
 */
export function createPanel(root) {
  root.innerHTML = `
    <header class="panel__head">
      <span class="panel__title">Run</span>
      <span class="badge" data-role="status">—</span>
      <button class="audio" type="button" data-role="audio" aria-pressed="false" title="Sound on (P)">🔊</button>
    </header>

    <dl class="stats">
      <div class="stats__row"><dt>Turn</dt><dd data-role="turn">0</dd></div>
      <div class="stats__row"><dt>Level</dt><dd data-role="level">1</dd></div>
      <div class="stats__row"><dt>XP</dt><dd data-role="xp">0</dd></div>
      <div class="stats__row"><dt>Seed</dt><dd data-role="seed">—</dd></div>
      <div class="stats__row"><dt>Map</dt><dd data-role="map">—</dd></div>
    </dl>

    <section class="block">
      <header class="block__head">
        <span data-role="hero-name">—</span>
        <span class="mono" data-role="hero-hp">0/0</span>
      </header>
      <div class="bar"><div class="bar__fill" data-role="hero-hpbar"></div></div>
      <div class="pool">
        <span class="pool__label">MP</span>
        <span class="mono" data-role="hero-mana">0/0</span>
      </div>
      <div class="bar bar--mana"><div class="bar__fill bar__fill--mana" data-role="hero-manabar"></div></div>
      <dl class="stats stats--tight">
        <div class="stats__row"><dt>ATK</dt><dd data-role="hero-atk">0</dd></div>
        <div class="stats__row"><dt>DEF</dt><dd data-role="hero-def">0</dd></div>
        <div class="stats__row"><dt>Crit</dt><dd data-role="hero-crit">0%</dd></div>
        <div class="stats__row"><dt>Crit dmg</dt><dd data-role="hero-critdmg">+0%</dd></div>
        <div class="stats__row"><dt>Dodge</dt><dd data-role="hero-dodge">0%</dd></div>
        <div class="stats__row"><dt>Luck</dt><dd data-role="hero-luck">0</dd></div>
        <div class="stats__row"><dt>Int</dt><dd data-role="hero-int">0</dd></div>
      </dl>
    </section>

    <section class="block">
      <h2 class="section-title">Target</h2>
      <ul class="foes" data-role="target"></ul>
    </section>

    <section class="block">
      <h2 class="section-title">Equipment</h2>
      <ul class="gear" data-role="equipment"></ul>
    </section>

    <section class="block">
      <h2 class="section-title">Bag <span class="count" data-role="bag-count">0</span></h2>
      <ul class="bag" data-role="inventory"></ul>
    </section>

    <p class="hint">
      <strong>Move</strong> arrows / WASD / hjkl<br>
      <strong>Wait</strong> space or .<br>
      <strong>New run</strong> R<br>
      <strong>Sound</strong> P<br>
      <span data-role="levelup-hint" style="display:none"></span>
    </p>
  `;

  const refs = {
    status: pick(root, 'status'),
    audio: pick(root, 'audio'),
    turn: pick(root, 'turn'),
    level: pick(root, 'level'),
    xp: pick(root, 'xp'),
    seed: pick(root, 'seed'),
    map: pick(root, 'map'),
    heroName: pick(root, 'hero-name'),
    heroHp: pick(root, 'hero-hp'),
    heroHpBar: pick(root, 'hero-hpbar'),
    heroMana: pick(root, 'hero-mana'),
    heroManaBar: pick(root, 'hero-manabar'),
    heroAtk: pick(root, 'hero-atk'),
    heroDef: pick(root, 'hero-def'),
    heroCrit: pick(root, 'hero-crit'),
    heroCritDmg: pick(root, 'hero-critdmg'),
    heroDodge: pick(root, 'hero-dodge'),
    heroLuck: pick(root, 'hero-luck'),
    heroInt: pick(root, 'hero-int'),
    target: pick(root, 'target'),
    equipment: pick(root, 'equipment'),
    inventory: pick(root, 'inventory'),
    bagCount: pick(root, 'bag-count'),
    levelupHint: pick(root, 'levelup-hint'),
  };

  function render(game) {
    const { player } = game;
    refs.status.textContent = formatStatus(game);
    refs.status.dataset.state = game.status;
    refs.turn.textContent = String(game.turn);
    refs.level.textContent = String(game.level || 1);
    refs.xp.textContent = `${player.xp || 0}/${player.xpToNext || 50}`;
    refs.seed.textContent = String(game.seed);
    refs.map.textContent = `${game.map.width}x${game.map.height}`;

    refs.heroName.textContent = player.name;
    refs.heroHp.textContent = `${player.hp}/${player.maxHp}`;
    refs.heroHpBar.style.width = `${percent(player.hp, player.maxHp)}%`;
    refs.heroHpBar.dataset.state = player.hp / player.maxHp <= 0.34 ? 'low' : 'ok';
    refs.heroMana.textContent = `${player.mana || 0}/${player.maxMana || 0}`;
    refs.heroManaBar.style.width = `${percent(player.mana, player.maxMana)}%`;
    refs.heroAtk.textContent = String(player.attack);
    refs.heroDef.textContent = String(player.defense);
    refs.heroCrit.textContent = `${player.critChance || 0}%`;
    refs.heroCritDmg.textContent = `+${player.critDamage || 0}%`;
    refs.heroDodge.textContent = `${player.dodge || 0}%`;
    refs.heroLuck.textContent = String(player.luck || 0);
    refs.heroInt.textContent = String(player.intelligence || 0);

    renderTarget(refs.target, game.target);
    renderEquipment(refs.equipment, game);
    renderInventory(refs.inventory, refs.bagCount, game);

    // The reopen affordance: the level-up dialog may be postponed, so the panel
    // keeps showing how many points are waiting and the key that brings it back.
    const pending = player.pointsUnspent || 0;
    refs.levelupHint.style.display = pending > 0 ? 'block' : 'none';
    refs.levelupHint.textContent = pending > 0 ? `Level up: ${pending} points — N to spend` : '';
  }

  return { render, refs };
}

function pick(root, role) {
  const element = root.querySelector(`[data-role="${role}"]`);
  if (!element) throw new Error(`Panel element "${role}" is missing`);
  return element;
}

function renderTarget(list, target) {
  list.replaceChildren();

  const item = document.createElement('li');
  item.className = 'foe';

  if (!target || !target.alive) {
    item.className = 'foe foe--empty';
    item.textContent = 'No target';
    list.append(item);
    return;
  }

  const name = document.createElement('span');
  name.className = 'foe__name';
  name.textContent = `${target.glyph} ${target.name}`;

  const hp = document.createElement('span');
  hp.className = 'mono';
  hp.textContent = `${target.hp}/${target.maxHp}`;

  const bar = document.createElement('div');
  bar.className = 'bar bar--slim';
  const fill = document.createElement('div');
  fill.className = 'bar__fill';
  fill.style.width = `${percent(target.hp, target.maxHp)}%`;
  bar.append(fill);

  item.append(name, hp, bar);
  list.append(item);
}

function percent(value, max) {
  if (!max) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

/** The short label for each bonus stat, matching the hero stat rows above. */
const BONUS_LABELS = Object.freeze({
  attack: 'ATK',
  defense: 'DEF',
  maxHp: 'HP',
  maxMana: 'MP',
  critChance: 'CRIT',
  critDamage: 'CDMG',
  luck: 'LUCK',
  dodge: 'DODGE',
  intelligence: 'INT',
});

/** "ATK +2, LUCK +5" for a tooltip; the empty string for a plain item. */
function bonusText(definition) {
  return ITEM_BONUS_KEYS.filter((key) => definition[key])
    .map((key) => `${BONUS_LABELS[key]} +${definition[key]}`)
    .join(', ');
}

const slotLabel = (slot) => slot.charAt(0).toUpperCase() + slot.slice(1);

/**
 * One row per equipment slot, always in ITEM_SLOTS order so the layout does not
 * jump as items come and go. A filled slot is clickable (main.js reads
 * `data-slot` to unequip); an empty one is inert.
 */
function renderEquipment(list, game) {
  list.replaceChildren();
  const definitions = game._data?.items?.definitions ?? {};
  const equipment = game.player.equipment ?? {};

  for (const slot of ITEM_SLOTS) {
    const itemId = equipment[slot];
    const definition = itemId ? definitions[itemId] : null;

    const row = document.createElement('li');
    row.className = definition ? 'gear__row' : 'gear__row gear__row--empty';
    row.dataset.slot = slot;

    const name = document.createElement('span');
    name.className = 'gear__slot';
    name.textContent = slotLabel(slot);

    const value = document.createElement('span');
    value.className = 'gear__item';
    value.textContent = definition ? definition.name : '—';
    if (definition) row.title = `${definition.name} — ${bonusText(definition)} (click to unequip)`;

    row.append(name, value);
    list.append(row);
  }
}

/**
 * The carried items, each row clickable to equip (main.js reads `data-item`).
 * Names resolve through the frozen catalog, the same seam the canvas uses.
 */
function renderInventory(list, count, game) {
  list.replaceChildren();
  const definitions = game._data?.items?.definitions ?? {};
  const inventory = game.player.inventory ?? [];
  count.textContent = String(inventory.length);

  if (inventory.length === 0) {
    const row = document.createElement('li');
    row.className = 'bag__row bag__row--empty';
    row.textContent = 'Empty';
    list.append(row);
    return;
  }

  for (const itemId of inventory) {
    const definition = definitions[itemId];
    const row = document.createElement('li');
    row.className = 'bag__row';
    row.dataset.item = itemId;
    row.textContent = definition ? definition.name : itemId;
    if (definition) {
      row.title = `${slotLabel(definition.slot)} — ${bonusText(definition)} (click to equip)`;
    }
    list.append(row);
  }
}

export function createLog(root) {
  function render(game) {
    const lines = formatLog(game.log, 9);
    root.replaceChildren();
    for (const line of lines) {
      const row = document.createElement('p');
      row.className = 'log__line';
      row.textContent = line;
      root.append(row);
    }
    root.scrollTop = root.scrollHeight;
  }

  return { render };
}