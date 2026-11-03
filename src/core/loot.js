/**
 * Which items an archetype drops when it dies.
 *
 * A pure function of the loot table (no game, no DOM), so the drop rule is
 * testable on its own. Two things are deliberate:
 *
 *   - The wildcard row (`enemy === ANY_ENEMY`) applies to EVERY archetype, the
 *     same promise the validator makes when it accepts that token.
 *   - `luck` is added to a row's chance in PERCENTAGE POINTS (luck 5 turns a 10%
 *     row into a 15%), clamped to the 1..100 domain the data uses, so a lucky
 *     hero finds more without a row ever exceeding certainty.
 *
 * Rows are rolled independently: a rat can drop both its own boots and the
 * shared wildcard belt. A table with no matching row does NOT draw from the rng,
 * which keeps a stream stable for archetypes that cannot drop anything.
 */

import { ANY_ENEMY } from '../data/index.js';

const MIN_CHANCE = 1;
const MAX_CHANCE = 100;

/**
 * @param {{enemy:string, item:string, chance:number}[]} lootTable the validated loot rows
 * @param {string|null} archetypeId the dead entity's archetype id
 * @param {number} luck the looter's luck, in percentage points
 * @param {{int:(min:number, max:number)=>number}} rng the run's seeded rng
 * @returns {string[]} the item ids that drop, in table order (may be empty)
 */
export function rollLoot(lootTable, archetypeId, luck, rng) {
  if (!Array.isArray(lootTable) || lootTable.length === 0) return [];

  const bonus = Number.isFinite(luck) ? luck : 0;
  const drops = [];
  for (const row of lootTable) {
    if (row.enemy !== ANY_ENEMY && row.enemy !== archetypeId) continue;
    const chance = Math.max(MIN_CHANCE, Math.min(MAX_CHANCE, row.chance + bonus));
    if (rng.int(MIN_CHANCE, MAX_CHANCE) <= chance) drops.push(row.item);
  }
  return drops;
}
