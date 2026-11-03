/**
 * Hostile AI, per AGENTS.md: attack when adjacent, otherwise take one BFS step
 * toward the player. No other behaviours are invented here.
 *
 * Pure decision function: it returns an intent and never mutates state, which
 * keeps enemy behaviour trivially testable and easy to debug.
 */

import { DIRECTIONS, isAdjacent, nextStepToward } from '../core/pathfinding.js';
import { entityAt } from './entity.js';

/**
 * @param {object} game
 * @param {object} enemy
 * @returns {{type:'attack', dx:number, dy:number}
 *          |{type:'move', dx:number, dy:number}
 *          |{type:'wait'}}
 */
export function planEnemyAction(game, enemy) {
  const target = game.player;
  if (!target.alive) return { type: 'wait' };
  if (enemy.x < target.x) enemy.facing = -1;
  else if (enemy.x > target.x) enemy.facing = 1;
  else if (typeof enemy.facing !== 'number') enemy.facing = 1;

  if (isAdjacent(enemy, target)) {
    return { type: 'attack', dx: target.x - enemy.x, dy: target.y - enemy.y };
  }

  const blocked = (x, y) => {
    const occupant = entityAt(game.entities, x, y);
    return occupant !== null && occupant !== enemy;
  };

  const step = nextStepToward(game.map, enemy, target, blocked);
  if (!step) return { type: 'wait' };

  return { type: 'move', dx: step.x - enemy.x, dy: step.y - enemy.y };
}

/**
 * Which of the four orthogonal neighbours of `entity` hold a hostile.
 * Kept here (not in the renderer) because it is a rules query.
 */
export function adjacentHostiles(game, entity, isHostile) {
  const found = [];
  for (const dir of DIRECTIONS) {
    const occupant = entityAt(game.entities, entity.x + dir.x, entity.y + dir.y);
    if (occupant && isHostile(entity, occupant)) found.push({ dir, occupant });
  }
  return found;
}
