/**
 * Tile vocabulary and map queries.
 *
 * A map is a flat typed array so that it stays cheap to copy, flood-fill and
 * serialize. All coordinates are grid coordinates (columns, rows).
 */

export const Tile = Object.freeze({
  WALL: 0,
  FLOOR: 1,
});

const TILE_COUNT = Object.keys(Tile).length;

/** @returns {boolean} true when a tile value can be walked on. */
export function isWalkableTile(tile) {
  return tile === Tile.FLOOR;
}

/** @returns {boolean} true when (x, y) is inside the map bounds. */
export function inBounds(map, x, y) {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

/** @returns {number} the tile at (x, y); out of bounds reads as WALL. */
export function tileAt(map, x, y) {
  return inBounds(map, x, y) ? map.tiles[y * map.width + x] : Tile.WALL;
}

/** Writes a tile; out of bounds writes are ignored. */
export function setTile(map, x, y, tile) {
  if (inBounds(map, x, y)) {
    map.tiles[y * map.width + x] = tile;
  }
}

/** @returns {boolean} true when the cell exists and is walkable. */
export function isWalkable(map, x, y) {
  return inBounds(map, x, y) && isWalkableTile(tileAt(map, x, y));
}

/** @returns {{width: number, height: number, tiles: Uint8Array, rooms: Array}} */
export function createMap(width, height, fill = Tile.WALL) {
  const tiles = new Uint8Array(width * height);
  tiles.fill(fill);
  return { width, height, tiles, rooms: [] };
}

/** @returns {number} how many cells contain the given tile. */
export function countTiles(map, tile) {
  let total = 0;
  for (let i = 0; i < map.tiles.length; i += 1) {
    if (map.tiles[i] === tile) total += 1;
  }
  return total;
}

export { TILE_COUNT };
