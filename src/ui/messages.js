/**
 * Turns structured events from the rules engine into player-facing text.
 * Keeping this in the UI layer is what lets src/core stay DOM-free.
 */

const label = (actor) => (actor.kind === 'player' ? 'You' : `The ${actor.name}`);
const verb = (actor, singular, plural) => (actor.kind === 'player' ? singular : plural);

/**
 * @param {object} event
 * @returns {string|null} a log line, or null for events that are not text.
 */
export function formatEvent(event) {
  switch (event.type) {
    case 'run-start':
      return (
        `You enter a dungeon with ${event.enemyCount} hostile(s). ` +
        `Map ${event.map.width}x${event.map.height}, seed ${event.seed}.`
      );

    case 'move':
      return event.actor.kind === 'player'
        ? `You move to (${event.to.x}, ${event.to.y}).`
        : `${label(event.actor)} moves to (${event.to.x}, ${event.to.y}).`;

    case 'blocked':
      if (event.reason === 'wall') {
        return `${label(event.actor)} ${verb(event.actor, 'bump into a wall.', 'bumps into a wall.')}`;
      }
      if (event.reason === 'empty') {
        return `${label(event.actor)} ${verb(event.actor, 'swing at empty air.', 'swings at empty air.')}`;
      }
      return `${label(event.actor)} ${verb(event.actor, 'are blocked.', 'is blocked.')}`;

    case 'wait':
      return `${label(event.actor)} ${verb(event.actor, 'wait.', 'waits.')}`;

    case 'attack': {
      const targetLabel = label(event.target) === 'You' ? 'you' : label(event.target);
      // A dodge is a clean evade: no damage, so it must not be reported as a hit
      // for 0. Phrase it from the evader's side.
      if (event.dodged) {
        const owner = event.actor.kind === 'player' ? 'your' : `${label(event.actor)}'s`;
        return `${label(event.target)} ${verb(event.target, 'dodge', 'dodges')} ${owner} attack.`;
      }
      const crit = event.crit ? 'CRITICAL! ' : '';
      const hit = `${crit}${label(event.actor)} ${verb(event.actor, 'hit', 'hits')} ${targetLabel} ` +
        `for ${event.damage} damage (${event.hp}/${event.maxHp} HP).`;
      if (!event.killed) return hit;
      return `${hit} ${event.target.kind === 'player' ? 'You die.' : `${label(event.target)} dies.`}`;
    }

    case 'gameover':
      if (event.victory) return 'Boss defeated! Victory! Press R to return to start.';
      return event.winner === 'player'
        ? 'Dungeon cleared. Press R to descend into a new one.'
        : 'You died. Press R to start a new run.';
    case 'levelup':
      return `You leveled up to level ${event.level}!`;
    case 'descend':
      return `You descend to level ${event.level}.`;
    case 'level':
      return `Entered level ${event.level}.`;
    case 'drop':
      return `${label(event.actor)} ${verb(event.actor, 'drop', 'drops')} ${event.name}.`;
    case 'pickup':
      return `You pick up ${event.name}.`;

    default:
      return null;
  }
}

/**
 * @param {object[]} log engine log
 * @param {number} limit how many trailing lines to return
 * @returns {string[]}
 */
export function formatLog(log, limit = 8) {
  return log
    .map(formatEvent)
    .filter((line) => line !== null)
    .slice(-limit);
}

/** @returns {string} a short status line for the panel header. */
export function formatStatus(game) {
  switch (game.status) {
    case 'dead':
      return 'DEAD';
    case 'cleared':
      return 'CLEARED';
    case 'level-up':
      return 'LEVEL UP';
    case 'victory':
      return 'VICTORY';
    default:
      return 'EXPLORING';
  }
}