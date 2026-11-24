// interiors.js — tile-map interiors for stations, caves and derelicts.
// Maps are arrays of mutable char rows. Pure module (no DOM).

import { RNG, clamp } from './core.js';

export const TILE_WALL = '#';
export const TILE_FLOOR = '.';
export const TILE_DOOR = '+';
export const TILE_AIRLOCK = 'A';   // step + interact -> EVA / exit
export const TILE_ARRIVE = 'D';    // docking arrival pad
export const TILE_TERMINAL = 'T';  // market terminal
export const TILE_FUEL = 'F';
export const TILE_REPAIR = 'R';
export const TILE_CRATE = 'c';
export const TILE_ORE = 'O';       // minable vein (caves)
export const TILE_TECH = 'X';      // salvage tech (derelicts)

export function isWalkable(ch) {
  return ch !== TILE_WALL && ch !== undefined;
}

class MapBuilder {
  constructor(w, h, fill = TILE_WALL) {
    this.w = w; this.h = h;
    this.rows = [];
    for (let y = 0; y < h; y++) this.rows.push(new Array(w).fill(fill));
  }
  set(x, y, ch) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.rows[y][x] = ch;
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return TILE_WALL;
    return this.rows[y][x];
  }
  fillRect(x0, y0, x1, y1, ch) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, ch);
  }
  // carve a room: floor inside, walls ring around it
  room(x0, y0, x1, y1) {
    for (let y = y0 - 1; y <= y1 + 1; y++) for (let x = x0 - 1; x <= x1 + 1; x++) {
      const border = (x === x0 - 1 || x === x1 + 1 || y === y0 - 1 || y === y1 + 1);
      this.set(x, y, border ? TILE_WALL : TILE_FLOOR);
    }
  }
  corridor(x0, y0, x1, y1) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        this.set(x, y, TILE_FLOOR);
  }
  door(x, y) { this.set(x, y, TILE_DOOR); }
  finalize(id, name) {
    return {
      id, name, w: this.w, h: this.h,
      rows: this.rows.map(r => r.join('')),
      spawn: { x: 2, y: 2 },
      airlocks: [], terminals: [], crates: [], ores: [], techs: [],
      _raw: this.rows,
    };
  }
}

function collectSpecial(map) {
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
    const ch = map._raw[y][x];
    if (ch === TILE_AIRLOCK) map.airlocks.push({ x, y });
    if (ch === TILE_TERMINAL) map.terminals.push({ x, y, kind: 'market' });
    if (ch === TILE_FUEL) map.terminals.push({ x, y, kind: 'fuel' });
    if (ch === TILE_REPAIR) map.terminals.push({ x, y, kind: 'repair' });
    if (ch === TILE_CRATE) map.crates.push({ x, y, looted: false });
    if (ch === TILE_ORE) map.ores.push({ x, y, left: 3 + Math.floor(Math.random() * 4) });
    if (ch === TILE_TECH) map.techs.push({ x, y, looted: false });
  }
}

export function buildStationInterior(station) {
  const rng = new RNG('interior:' + station.id);
  const W = 36, H = 24;
  const b = new MapBuilder(W, H);
  const cx = 18;

  // dock bay (south): floor y 16..21, walls y=15 & y=22
  b.room(cx - 6, H - 8, cx + 6, H - 3);
  // central corridor from hub down into the dock bay
  b.corridor(cx, 9, cx, H - 9);
  b.door(cx, H - 9);
  // hub (middle): floor x 13..23, y 8..12
  b.room(cx - 5, 8, cx + 5, 12);
  b.door(cx, 13);
  // west room: floor x 3..11, y 8..12  (shares wall with hub at x=12)
  b.room(3, 8, 11, 12);
  b.door(12, 10);
  // east room: floor x 25..33, y 8..12 (shares wall with hub at x=24)
  b.room(25, 8, W - 3, 12);
  b.door(24, 10);
  // north-west room: floor x 3..11, y 2..5 (connects down into west room)
  b.room(3, 2, 11, 5);
  b.door(6, 6); b.door(6, 7);
  // north-east room: floor x 25..33, y 2..5 (connects down into east room)
  b.room(25, 2, W - 3, 5);
  b.door(30, 6); b.door(30, 7);

  // arrival pad & airlock in dock bay
  b.set(cx, H - 4, TILE_ARRIVE);
  b.set(cx, H - 3, TILE_AIRLOCK);

  // terminals per services
  const svc = station.services;
  const spots = [
    [4, 9], [6, 9], [31, 9], [30, 9], [26, 9],
    [4, 3], [6, 3], [31, 3], [30, 3], [9, 10],
  ];
  let si = 0;
  const takeSpot = () => spots[si++ % spots.length];
  for (const s of svc) {
    const [sx, sy] = takeSpot();
    b.set(sx, sy, s === 'market' ? TILE_TERMINAL : s === 'fuel' ? TILE_FUEL : TILE_REPAIR);
  }
  // decor: crates in dock bay
  const nCrates = rng.int(2, 5);
  for (let i = 0; i < nCrates; i++) {
    const rx = rng.int(cx - 5, cx + 5), ry = rng.int(H - 7, H - 4);
    if (b.get(rx, ry) === TILE_FLOOR) b.set(rx, ry, TILE_CRATE);
  }
  const map = b.finalize(station.interiorId, station.name + ' — INTERIOR');
  map.spawn = { x: cx, y: H - 5 };
  map.stationId = station.id;
  collectSpecial(map);
  return map;
}

export function buildCave(caveSeed, caveId) {
  const rng = new RNG('cave:' + caveSeed);
  const W = 34, H = 22;
  const b = new MapBuilder(W, H);
  // cellular automata caverns
  let cells = [];
  for (let y = 0; y < H; y++) { cells.push([]); for (let x = 0; x < W; x++) cells[y].push(rng.chance(0.45) ? 1 : 0); }
  for (let it = 0; it < 4; it++) {
    const next = cells.map(r => r.slice());
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += cells[y + dy][x + dx];
      next[y][x] = (cells[y][x] === 1 && n >= 4) || (cells[y][x] === 0 && n >= 6) ? 1 : 0;
    }
    cells = next;
  }
  // keep largest connected open region
  const seen = Array.from({ length: H }, () => new Array(W).fill(false));
  let best = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (cells[y][x] === 0 && !seen[y][x]) {
      const comp = [];
      const stack = [[x, y]];
      seen[y][x] = true;
      while (stack.length) {
        const [px, py] = stack.pop();
        comp.push([px, py]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && cells[ny][nx] === 0 && !seen[ny][nx]) {
            seen[ny][nx] = true; stack.push([nx, ny]);
          }
        }
      }
      if (comp.length > best.length) best = comp;
    }
  }
  const inBest = new Set(best.map(([x, y]) => x + ',' + y));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    b.set(x, y, inBest.has(x + ',' + y) ? TILE_FLOOR : TILE_WALL);
  }
  if (best.length === 0) { b.fillRect(1, 1, W - 2, H - 2, TILE_FLOOR); best.push([2, 2]); }
  // entrance & exit
  const [ex, ey] = best[0];
  b.set(ex, ey, TILE_AIRLOCK); // re-entry to surface
  // ore veins: wall tiles adjacent to floor
  const veinCandidates = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (b.get(x, y) !== TILE_WALL) continue;
    let adj = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isWalkable(b.get(x + dx, y + dy))) adj++;
    if (adj >= 1) veinCandidates.push([x, y, adj]);
  }
  const nVeins = clamp(Math.floor(best.length / 22), 4, 14);
  for (let i = 0; i < nVeins && veinCandidates.length; i++) {
    const idx = Math.floor(rng.next() * veinCandidates.length);
    const [vx, vy] = veinCandidates.splice(idx, 1)[0];
    b.set(vx, vy, TILE_ORE);
  }
  // a crate or two
  for (let i = 0; i < 2; i++) {
    const [px, py] = best[Math.floor(rng.next() * best.length)];
    if (b.get(px, py) === TILE_FLOOR) b.set(px, py, TILE_CRATE);
  }
  const map = b.finalize(caveId, 'CAVERN ' + caveId.split('_')[1]);
  map.spawn = { x: ex, y: ey };
  map.cave = true;
  map.exitTo = caveId;
  collectSpecial(map);
  for (const o of map.ores) { o.left = 3 + rng.int(0, 3); }
  return map;
}

export function buildDerelictInterior(der) {
  const rng = new RNG('derelict:' + der.seed);
  const W = 22, H = 14;
  const b = new MapBuilder(W, H);
  // spine corridor
  b.corridor(1, Math.floor(H / 2), W - 2, Math.floor(H / 2));
  // rooms off the spine
  const midY = Math.floor(H / 2);
  const roomXs = [2, 7, 12, 17];
  for (const rx of roomXs) {
    const above = rng.chance(0.5);
    const ry = above ? 2 : midY + 2;
    b.room(rx - 1, ry, rx + 2, ry + 3);
    b.door(rx, above ? ry + 4 : midY + 1);
  }
  // airlock arrival at west end
  b.set(1, midY, TILE_AIRLOCK);
  // crates & tech
  for (let i = 0; i < der.lootCrates; i++) {
    const rx = rng.int(2, W - 3), ry = rng.int(1, H - 2);
    if (b.get(rx, ry) === TILE_FLOOR) b.set(rx, ry, TILE_CRATE);
  }
  for (let i = 0; i < der.tech; i++) {
    const rx = rng.int(2, W - 3), ry = rng.int(1, H - 2);
    if (b.get(rx, ry) === TILE_FLOOR) b.set(rx, ry, TILE_TECH);
  }
  const map = b.finalize(der.interiorId, der.name + ' — WRECK');
  map.spawn = { x: 1, y: midY };
  map.derelict = true;
  map.exitTo = der.id;
  collectSpecial(map);
  return map;
}
