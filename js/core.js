// core.js — math, random, utilities. Pure module (no DOM access).

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(t) { return t * t * (3 - 2 * t); }
export function sign(v) { return v < 0 ? -1 : 1; }

// ---------- vec3 (plain {x,y,z} objects) ----------
export function v3(x = 0, y = 0, z = 0) { return { x, y, z }; }
export function vadd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
export function vsub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
export function vscale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
export function vdot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function vlen(a) { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
export function vdist(a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
export function vnorm(a) {
  const l = vlen(a);
  if (l < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}
export function vcross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
export function vlerp(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) }; }
export function vcopy(a) { return { x: a.x, y: a.y, z: a.z }; }
export function vReflect(a, n) { // reflect a about unit normal n
  const d = 2 * vdot(a, n);
  return { x: a.x - d * n.x, y: a.y - d * n.y, z: a.z - d * n.z };
}

// ---------- quaternion ----------
export function qident() { return { x: 0, y: 0, z: 0, w: 1 }; }
export function qaxis(ax, ay, az, ang) {
  const h = ang * 0.5, s = Math.sin(h);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(h) };
}
export function qmul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
export function qnorm(q) {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}
export function qconj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
export function qrot(q, v) {
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
// integrate orientation by angular velocity (rad/s, world-ish body frame) over dt
export function qintegrate(q, wx, wy, wz, dt) {
  const dq = { x: wx * dt * 0.5, y: wy * dt * 0.5, z: wz * dt * 0.5, w: 0 };
  // q' = q + 0.5*dt * (w_quat * q)
  const wq = qmul({ x: wx, y: wy, z: wz, w: 0 }, q);
  return qnorm({
    x: q.x + wq.x * dt * 0.5,
    y: q.y + wq.y * dt * 0.5,
    z: q.z + wq.z * dt * 0.5,
    w: q.w + wq.w * dt * 0.5,
  });
}
export function qslerp(a, b, t) {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bb = b;
  if (d < 0) { d = -d; bb = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }; }
  if (d > 0.9995) return qnorm({ x: lerp(a.x, bb.x, t), y: lerp(a.y, bb.y, t), z: lerp(a.z, bb.z, t), w: lerp(a.w, bb.w, t) });
  const th = Math.acos(clamp(d, -1, 1));
  const sa = Math.sin((1 - t) * th) / Math.sin(th);
  const sb = Math.sin(t * th) / Math.sin(th);
  return {
    x: a.x * sa + bb.x * sb,
    y: a.y * sa + bb.y * sb,
    z: a.z * sa + bb.z * sb,
    w: a.w * sa + bb.w * sb,
  };
}
export function qforward(q) { return qrot(q, { x: 1, y: 0, z: 0 }); }
export function qup(q) { return qrot(q, { x: 0, y: 1, z: 0 }); }
export function qright(q) { return qrot(q, { x: 0, y: 0, z: 1 }); }

// ---------- seeded RNG ----------
export function strHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export class RNG {
  constructor(seedStr) {
    this.seedStr = String(seedStr);
    this.f = mulberry32(strHash(this.seedStr));
  }
  next() { return this.f(); }
  range(a, b) { return a + (b - a) * this.f(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); } // inclusive
  pick(arr) { return arr[Math.floor(this.f() * arr.length)]; }
  chance(p) { return this.f() < p; }
  angle() { return this.f() * TAU; }
  weighted(pairs) { // [[value, weight], ...]
    let total = 0;
    for (const p of pairs) total += p[1];
    let r = this.f() * total;
    for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  }
  // deterministic per-cell hash noise 0..1 (for rendering)
  hash2(x, y) {
    let h = (x * 374761393 + y * 668265263) ^ strHash(this.seedStr);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  fork(salt) { return new RNG(this.seedStr + ':' + salt); }
}

// ---------- formatting ----------
export function pad2(n) { return (n < 10 ? '0' : '') + n; }
export function fmtInt(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
export function fmtFixed(n, d = 1) { return Number(n).toFixed(d); }
export function fmtVec(v, d = 1) {
  return `${v.x.toFixed(d)} ${v.y.toFixed(d)} ${v.z.toFixed(d)}`;
}
export function timeHHMM(tSec) {
  const h = Math.floor(tSec / 3600) % 24, m = Math.floor(tSec / 60) % 60;
  return `${pad2(h)}:${pad2(m)}`;
}
export function bar(cur, max, width = 10, full = '#', empty = '-') {
  const n = clamp(Math.round((cur / max) * width), 0, width);
  return full.repeat(n) + empty.repeat(width - n);
}
export function el(id) { return document.getElementById(id); }
