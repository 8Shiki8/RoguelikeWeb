import { createMap, setTile, Tile, isWalkable } from './tiles.js';
import { floodFill } from '../core/pathfinding.js';

export function centerOf(room) {
  return { x: Math.floor(room.x + room.w / 2), y: Math.floor(room.y + room.h / 2) };
}

const ROOM_MARGIN = 1;

// Two rooms must keep at least ROOM_MARGIN empty tiles between them, so the
// wall tile they would otherwise share stays intact.
function overlap(a, b) {
  return !(
    a.x + a.w + ROOM_MARGIN <= b.x ||
    b.x + b.w + ROOM_MARGIN <= a.x ||
    a.y + a.h + ROOM_MARGIN <= b.y ||
    b.y + b.h + ROOM_MARGIN <= a.y
  );
}

function carveRoom(map, room) {
  for (let y = room.y; y < room.y + room.h; y += 1) {
    for (let x = room.x; x < room.x + room.w; x += 1) {
      setTile(map, x, y, Tile.FLOOR);
    }
  }
}

function carveHcorr(map, x1, x2, y) {
  const x0 = Math.min(x1, x2);
  const x1b = Math.max(x1, x2);
  for (let x = x0; x <= x1b; x += 1) {
    setTile(map, x, y, Tile.FLOOR);
  }
}

function carveVcorr(map, y1, y2, x) {
  const y0 = Math.min(y1, y2);
  const y1b = Math.max(y1, y2);
  for (let y = y0; y <= y1b; y += 1) {
    setTile(map, x, y, Tile.FLOOR);
  }
}

function isConnected(map) {
  const walkable = [];
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (isWalkable(map, x, y)) {
        walkable.push({ x, y });
        y = map.height;
        break;
      }
    }
  }
  if (walkable.length === 0) return { connected: true, repaired: false };
  const start = walkable[0];
  const visited = floodFill(map, start);
  let totalWalkable = 0;
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (isWalkable(map, x, y)) totalWalkable += 1;
    }
  }
  let reached = 0;
  for (let i = 0; i < visited.length; i += 1) reached += visited[i];
  return { connected: reached === totalWalkable, repaired: false };
}

export function createDungeon(mapConfig, rng, opts = {}) {
  const width = mapConfig.width;
  const height = mapConfig.height;
  const minRooms = mapConfig.minRooms;
  const maxRooms = mapConfig.maxRooms;
  const minRoomSize = mapConfig.minRoomSize || 3;
  const maxRoomSize = mapConfig.maxRoomSize || 6;
  const attempts = mapConfig.roomPlacementAttempts || 200;

  const map = createMap(width, height, Tile.WALL);
  const rooms = [];

  if (opts.boss) {
    const entrance = { x: Math.floor(width * 0.18), y: Math.floor(height * 0.5), w: 5, h: 4 };
    const bossRoom = { x: Math.floor(width * 0.52), y: Math.floor(height * 0.4), w: 9, h: 8 };
    rooms.push(entrance, bossRoom);
    carveRoom(map, entrance);
    carveRoom(map, bossRoom);
    const c1 = centerOf(entrance);
    const c2 = centerOf(bossRoom);
    carveHcorr(map, c1.x, c2.x, c1.y);
    const conn = isConnected(map);
    map.rooms = rooms;
    map.connectivity = conn;
    map.stairs = null;
    map.layout = 'boss';
    return map;
  }

  let roomCountTarget = rng.int(minRooms, maxRooms);
  for (let i = 0; i < attempts && rooms.length < roomCountTarget; i += 1) {
    const w = rng.int(minRoomSize, maxRoomSize);
    const h = rng.int(minRoomSize, maxRoomSize);
    const x = rng.int(ROOM_MARGIN, width - w - ROOM_MARGIN - 1);
    const y = rng.int(ROOM_MARGIN, height - h - ROOM_MARGIN - 1);
    const room = { x, y, w, h };
    if (rooms.some((r) => overlap(r, room))) continue;
    rooms.push(room);
    carveRoom(map, room);
  }
  for (let i = 1; i < rooms.length; i += 1) {
    const a = centerOf(rooms[i - 1]);
    const b = centerOf(rooms[i]);
    if (rng.next() < 0.5) {
      carveHcorr(map, a.x, b.x, a.y);
      carveVcorr(map, a.y, b.y, b.x);
    } else {
      carveVcorr(map, a.y, b.y, a.x);
      carveHcorr(map, a.x, b.x, b.y);
    }
  }
  const conn = isConnected(map);
  map.rooms = rooms;
  map.connectivity = conn;
  map.stairs = null;
  if (rooms.length > 0) {
    let farIdx = Math.floor(rooms.length * 0.8);
    if (farIdx >= rooms.length) farIdx = rooms.length - 1;
    if (farIdx === 0 && rooms.length > 1) farIdx = rooms.length - 1;
    const far = rooms[farIdx];
    map.stairs = { x: centerOf(far).x, y: centerOf(far).y };
    setTile(map, map.stairs.x, map.stairs.y, Tile.FLOOR);
  }
  return map;
}

export function randomFloorInRoom(map, room, rng, isTaken = () => false) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const x = rng.int(room.x, room.x + room.w - 1);
    const y = rng.int(room.y, room.y + room.h - 1);
    if (isWalkable(map, x, y) && !isTaken(x, y)) return { x, y };
  }
  return null;
}

export { DIRECTIONS } from '../core/pathfinding.js';
