/**
 * Combat resolution as pure state transitions.
 *
 * The damage rule below is a PLACEHOLDER: the project spec has not defined
 * damage yet, so the prototype uses the simplest deterministic rule that can be
 * reasoned about and tuned. Replace `damageFor` when the spec lands.
 */

/** A hit always lands and always hurts at least this much. */
export const MIN_DAMAGE = 1;

/**
 * PLACEHOLDER damage rule: attack reduced by defense, floored at MIN_DAMAGE.
 * @returns {number}
 */
export function damageFor(attacker, defender) {
  return Math.max(MIN_DAMAGE, attacker.attack - defender.defense);
}

/**
 * Roll for a critical hit. `critChance` is an integer percentage (0..100), so 0
 * can never crit and 100 always does. A 0 chance deliberately does NOT draw from
 * the rng, which keeps the stream identical for attackers that cannot crit.
 * @param {object} attacker
 * @param {{int:(min:number, max:number)=>number}} rng
 * @returns {boolean}
 */
function rollCrit(attacker, rng) {
  const chance = attacker.critChance || 0;
  if (chance <= 0) return false;
  return rng.int(1, 100) <= chance;
}

/**
 * Damage of a critical hit: the base rule scaled by the attacker's `critDamage`
 * percentage bonus (50 means +50%), never below MIN_DAMAGE.
 * @returns {number}
 */
function criticalDamage(base, attacker) {
  const bonus = attacker.critDamage || 0;
  return Math.max(MIN_DAMAGE, Math.round(base * (1 + bonus / 100)));
}

/**
 * Roll for an evasion. `dodge` is an integer percentage (0..100), so 0 can never
 * dodge and 100 always does. Like the crit roll, a 0 chance deliberately does NOT
 * draw from the rng, which keeps the stream identical for defenders that cannot
 * dodge.
 * @param {object} defender
 * @param {{int:(min:number, max:number)=>number}} rng
 * @returns {boolean}
 */
function rollDodge(defender, rng) {
  const chance = defender.dodge || 0;
  if (chance <= 0) return false;
  return rng.int(1, 100) <= chance;
}

/**
 * Apply one attack. Mutates `defender` only.
 *
 * The critical and dodge rolls use the run's seeded rng (passed in — never
 * Math.random), so `?seed=` reproduces the crits and evasions as well as the
 * dungeon. Dodge is rolled FIRST (a clean evade cannot also be a crit), and
 * without an rng the attack is a plain, always-landing hit, which keeps the pure
 * damage rule usable on its own.
 *
 * @param {object} attacker
 * @param {object} defender
 * @param {{int:(min:number, max:number)=>number}} [rng]
 * @returns {{damage:number, killed:boolean, hp:number, maxHp:number, crit:boolean, dodged:boolean}}
 */
export function resolveAttack(attacker, defender, rng = null) {
  if (rng !== null && rollDodge(defender, rng)) {
    return { damage: 0, killed: false, hp: defender.hp, maxHp: defender.maxHp, crit: false, dodged: true };
  }
  const base = damageFor(attacker, defender);
  const crit = rng !== null && rollCrit(attacker, rng);
  const damage = crit ? criticalDamage(base, attacker) : base;
  defender.hp = Math.max(0, defender.hp - damage);
  if (defender.hp === 0) defender.alive = false;
  return { damage, killed: !defender.alive, hp: defender.hp, maxHp: defender.maxHp, crit, dodged: false };
}
