/**
 * The five worn slots and the stat bonuses an item grants.
 *
 * Bonuses are applied to the LIVE entity on equip and taken back on unequip
 * rather than kept as a separate "base + gear" pair. That is the smallest model
 * that keeps every existing reader (combat, the panel) reading plain fields:
 * `player.attack` IS the effective attack. The arithmetic is additive and
 * exactly reversed, so a level-up gain made while an item is worn survives the
 * item coming off — `attack` 4 -> equip +2 (6) -> level-up +1 (7) -> unequip
 * -2 (5) — which is the base plus the one point that was spent.
 *
 * A slot holds an item ID (or null); the item definition lives in the frozen
 * catalog at `game._data.items.definitions`. Nothing here touches the DOM.
 */

import { ITEM_SLOTS } from '../data/index.js';

/**
 * The stat fields an item may grant, in the order the data declares them. Used
 * both to apply/remove bonuses and by the panel to describe an item.
 */
export const ITEM_BONUS_KEYS = Object.freeze([
  'attack',
  'defense',
  'maxHp',
  'maxMana',
  'critChance',
  'critDamage',
  'luck',
  'dodge',
  'intelligence',
]);

/** @returns {object} a fresh equipment set: one empty slot per known slot. */
export function createEquipment() {
  return Object.fromEntries(ITEM_SLOTS.map((slot) => [slot, null]));
}

/**
 * Move an item from the bag into its slot, swapping out whatever was worn there
 * (the displaced item returns to the bag). Fails when the item is unknown, has
 * no equippable slot, or is not in the bag — in every case nothing changes.
 * @returns {boolean} whether the item was equipped
 */
export function equipItem(game, itemId) {
  const definition = game._data.items.definitions[itemId];
  if (!definition || !ITEM_SLOTS.includes(definition.slot)) return false;

  const player = game.player;
  if (!Array.isArray(player.inventory) || !player.equipment) return false;
  const index = player.inventory.indexOf(itemId);
  if (index < 0) return false;

  player.inventory.splice(index, 1);
  const displaced = player.equipment[definition.slot];
  if (displaced) {
    // Take the displaced item's bonuses off FIRST, or swapping a weapon would
    // stack the outgoing item's bonus on top of the incoming one's forever.
    const displacedDefinition = game._data.items.definitions[displaced];
    if (displacedDefinition) applyBonuses(player, displacedDefinition, -1);
    player.inventory.push(displaced);
  }

  applyBonuses(player, definition, 1);
  player.equipment[definition.slot] = itemId;
  return true;
}

/**
 * Return the item in `slot` to the bag and take back its bonuses. No-op when the
 * slot is empty or unknown.
 * @returns {boolean} whether an item was unequipped
 */
export function unequipItem(game, slot) {
  const player = game.player;
  if (!ITEM_SLOTS.includes(slot)) return false;
  if (!Array.isArray(player.inventory) || !player.equipment) return false;

  const itemId = player.equipment[slot];
  if (!itemId) return false;
  const definition = game._data.items.definitions[itemId];
  if (!definition) return false;

  player.equipment[slot] = null;
  applyBonuses(player, definition, -1);
  player.inventory.push(itemId);
  return true;
}

/**
 * Add (`sign` 1) or remove (`sign` -1) every bonus an item grants.
 *
 * A bonus to a pool ceiling moves the live pool with it: equipping +3 max HP
 * also grants those 3 HP, and unequipping can never leave `hp > maxHp` (it is
 * clamped). Non-pool stats are plain adds.
 */
function applyBonuses(player, definition, sign) {
  for (const key of ITEM_BONUS_KEYS) {
    const value = definition[key] || 0;
    if (value) player[key] = (player[key] || 0) + sign * value;
  }
  if (definition.maxHp) {
    player.hp = sign > 0 ? player.hp + definition.maxHp : Math.min(player.hp, player.maxHp);
  }
  if (definition.maxMana) {
    const mana = player.mana || 0;
    player.mana = sign > 0 ? mana + definition.maxMana : Math.min(mana, player.maxMana);
  }
}
