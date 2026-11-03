/**
 * Grid graph utilities: neighbourhoods, flood fill and BFS pathing.
 *
 * Deliberately free of any game rules: callers pass in the walkability
 * predicate so the same code serves connectivity checks and enemy AI.
 */

import { inBounds, isWalkable } from '../map/tiles.js';

/** The four orthogonal neighbours, in a stable order (N, E, S, W). */
export const DIRECTIONS = Object.freeze([
  Object.freeze({ x: 0, y: -1 }),
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: 0, y: 1 }),
  Object.freeze({ x: -1, y: 0 }),
]);

/** @returns {boolean} true when the two coordinates are orthogonally adjacent. */
export function isAdjacent(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

const key = (map, x, y) => y * map.width + x;

/**
 * Flood fill over walkable cells.
 * @returns {Uint8Array} one flag per cell (1 = reached).
 */
export function floodFill(map, start) {
  const visited = new Uint8Array(map.width * map.height);
  if (!isWalkable(map, start.x, start.y)) return visited;

  const queue = [start.x, start.y];
  visited[key(map, start.x, start.y)] = 1;

  for (let head = 0; head < queue.length; head += 2) {
    const cx = queue[head];
    const cy = queue[head + 1];
    for (const dir of DIRECTIONS) {
      const nx = cx + dir.x;
      const ny = cy + dir.y;
      if (!isWalkable(map, nx, ny)) continue;
      const index = key(map, nx, ny);
      if (visited[index]) continue;
      visited[index] = 1;
      queue.push(nx, ny);
    }
  }

  return visited;
}

/** @returns {number} how many walkable cells are reachable from `start`. */
export function countReachable(map, start) {
  const visited = floodFill(map, start);
  let total = 0;
  for (let i = 0; i < visited.length; i += 1) total += visited[i];
  return total;
}

/** @returns {string[]} the human readable list of unreachable walkable cells. */
export function findUnreachableCells(map, start) {
  const visited = floodFill(map, start);
  const unreachable = [];
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const index = key(map, x, y);
      if (map.tiles[index] === 1 && !visited[index]) unreachable.push(`${x},${y}`);
    }
  }
  return unreachable;
}

/**
 * Breadth-first search returning the FIRST step of the shortest path from
 * `from` to `target`, or null when no path exists.
 *
 * The target cell itself is treated as enterable even when `isBlocked` reports
 * it (a hostile target is attacked, never stepped onto) so that the path can
 * always be computed up to the target.
 *
 * @param {{width:number, height:number}} map
 * @param {{x:number, y:number}} from
 * @param {{x:number, y:number}} target
 * @param {(x:number, y:number) => boolean} isBlocked occupied-cell predicate
 * @returns {{x:number, y:number}|null}
 */
export function nextStepToward(map, from, target, isBlocked = () => false) {
  if (from.x === target.x && from.y === target.y) return null;
  if (!inBounds(map, target.x, target.y)) return null;

  const cellCount = map.width * map.height;
  const cameFrom = new Int32Array(cellCount).fill(-1);
  const visited = new Uint8Array(cellCount);
  const startIndex = key(map, from.x, from.y);
  const targetIndex = key(map, target.x, target.y);
  visited[startIndex] = 1;

  const queue = [from.x, from.y];
  const passable = (x, y) => {
    if (!isWalkable(map, x, y)) return false;
    if (x === target.x && y === target.y) return true;
    return !isBlocked(x, y);
  };

  for (let head = 0; head < queue.length; head += 2) {
    const cx = queue[head];
    const cy = queue[head + 1];
    if (cx === target.x && cy === target.y) {
      return reconstructFirstStep(cameFrom, startIndex, targetIndex, map);
    }
    for (const dir of DIRECTIONS) {
      const nx = cx + dir.x;
      const ny = cy + dir.y;
      if (!passable(nx, ny)) continue;
      const index = key(map, nx, ny);
      if (visited[index]) continue;
      visited[index] = 1;
      cameFrom[index] = key(map, cx, cy);
      queue.push(nx, ny);
    }
  }

  return null;
}

function reconstructFirstStep(cameFrom, startIndex, targetIndex, map) {
  let current = targetIndex;
  while (cameFrom[current] !== startIndex && cameFrom[current] !== -1) {
    current = cameFrom[current];
  }
  return { x: current % map.width, y: Math.floor(current / map.width) };
}
