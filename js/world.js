// world.js — procedural generation of the Kveld system: one moon, a gas giant,
// five orbital stations, an asteroid/comet belt, derelicts and pirate nests.
// Pure module (no DOM access) so it can be unit-tested in Node.

import { RNG, TAU, DEG, v3, vadd, vscale, vnorm, qaxis, qrot, qmul, qnorm, clamp } from './core.js';

export const MOON_RADIUS = 600;
export const MOON_MU = 126000;             // g = mu / r^2  -> ~0.35 m/s² surface
export const PLANET_POS = v3(120000, -70000, 95000);
export const PLANET_RADIUS = 18000;
export const PLANET_MU = 1.2e9;

const STATION_DEFS = [
  {
    id: 'hregg', name: "HREGG'S GATE", kind: 'torus', size: 46, orbitR: 1500, incl: 4 * DEG,
    rotRate: 14, color: '#ffd27a', services: ['market', 'fuel', 'repair'],
    desc: 'Free-port trade hub. Everything is for sale, nothing is cheap.',
    roles: ['trade'],
  },
  {
    id: 'kolvik', name: 'KOLVIK REFINERY', kind: 'cylinder', size: 52, orbitR: 2150, incl: -7 * DEG,
    rotRate: 9, color: '#ff9d5c', services: ['market', 'fuel', 'repair'],
    desc: 'Belt ore goes in one end, credits come out the other.',
    roles: ['refinery'],
  },
  {
    id: 'aurora', name: 'AURORA HABITAT', kind: 'spokes', size: 55, orbitR: 2650, incl: 11 * DEG,
    rotRate: 6, color: '#7af2ff', services: ['fuel', 'repair'],
    desc: 'Rotating ring-habitat. Three thousand souls, one café.',
    roles: ['habitat'],
  },
  {
    id: 'mimir', name: 'MIMIR DOCKYARDS', kind: 'cross', size: 50, orbitR: 1900, incl: -3 * DEG,
    rotRate: 4, color: '#b7ff7a', services: ['fuel', 'repair'],
    desc: 'Shipyards and scrap heaps. If it floats, they will fix it.',
    roles: ['dockyard'],
  },
  {
    id: 'deepnine', name: 'DEEP NINE ARRAY', kind: 'lattice', size: 70, orbitR: 3100, incl: 6 * DEG,
    rotRate: 2.5, color: '#d59aff', services: ['market', 'fuel'],
    desc: 'Listening post at the edge of the system. Ears open to the dark.',
    roles: ['science'],
  },
];

function makeMesh(kind, size, rng) {
  // returns {nodes: [v3], edges: [[i,j]], ports: [v3 local]}
  const nodes = [], edges = [], ports = [];
  const N = (arr) => arr.length;
  const addNode = (p) => { nodes.push(p); return N(nodes) - 1; };
  const ring = (r, axis, count, phase = 0, center = v3()) => {
    const ids = [];
    const u = axis === 'y' ? v3(1, 0, 0) : v3(0, 1, 0);
    const w = vnorm(v3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0));
    const u2 = vnorm({ x: w.y * 0 - w.z * 0 + (w.x === 1 ? 0 : 1), y: 0, z: 0 }); // fallback below
    let e1, e2;
    if (w.x === 1) { e1 = v3(0, 1, 0); e2 = v3(0, 0, 1); }
    else if (w.y === 1) { e1 = v3(1, 0, 0); e2 = v3(0, 0, 1); }
    else { e1 = v3(1, 0, 0); e2 = v3(0, 1, 0); }
    for (let i = 0; i < count; i++) {
      const a = phase + (i / count) * TAU;
      const p = vadd(center, vadd(vscale(e1, Math.cos(a) * r), vscale(e2, Math.sin(a) * r)));
      ids.push(addNode(p));
    }
    for (let i = 0; i < count; i++) edges.push([ids[i], ids[(i + 1) % count]]);
    return ids;
  };

  if (kind === 'torus') {
    const outer = ring(size, 'y', 14);
    const inner = ring(size * 0.6, 'y', 12, Math.PI / 12);
    for (let i = 0; i < inner.length; i++) {
      edges.push([inner[i], outer[i % outer.length]]);
      edges.push([inner[i], outer[(i + 1) % outer.length]]);
    }
    const hub = addNode(v3(0, size * 0.18, 0));
    const hub2 = addNode(v3(0, -size * 0.18, 0));
    for (let i = 0; i < outer.length; i += 2) { edges.push([hub, outer[i]]); edges.push([hub2, outer[i]]); }
    edges.push([hub, hub2]);
    ports.push(v3(size * 0.6, size * 0.32, 0), v3(-size * 0.6, size * 0.32, 0));
  } else if (kind === 'cylinder') {
    const r = size * 0.5, len = size * 1.1;
    const top = ring(r, 'y', 10, 0, v3(0, len * 0.5, 0));
    const mid = ring(r * 1.15, 'y', 10, Math.PI / 10);
    const bot = ring(r, 'y', 10, 0, v3(0, -len * 0.5, 0));
    for (let i = 0; i < 10; i++) {
      edges.push([top[i], mid[i]]); edges.push([mid[i], bot[i]]);
      edges.push([top[i], top[(i + 3) % 10]]); edges.push([bot[i], bot[(i + 3) % 10]]);
    }
    const drill = addNode(v3(0, len * 0.5 + size * 0.4, 0));
    for (const id of top) edges.push([drill, id]);
    ports.push(v3(r * 1.15, 0, r * 1.15), v3(-r * 1.15, 0, -r * 1.15));
  } else if (kind === 'spokes') {
    const core = ring(size * 0.22, 'y', 8);
    const hubC = addNode(v3());
    for (const id of core) edges.push([hubC, id]);
    const armLen = size * 0.9;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU;
      const dir = v3(Math.cos(a), 0, Math.sin(a));
      const p1 = vscale(dir, armLen * 0.5), p2 = vscale(dir, armLen);
      const i1 = addNode(p1), i2 = addNode(p2);
      edges.push([hubC, i1]); edges.push([i1, i2]);
      const pod = ring(size * 0.2, 'y', 6, a, p2);
      for (const pid of pod) edges.push([i2, pid]);
      if (k % 2 === 0) ports.push(vadd(p2, v3(0, size * 0.3, 0)));
    }
    // gravity ring
    const gr = ring(size * 0.78, 'y', 16);
    for (const id of gr) edges.push([id, core[id % core.length]]);
  } else if (kind === 'cross') {
    const c = addNode(v3());
    const L = size;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + Math.PI / 4;
      const dir = v3(Math.cos(a), 0, Math.sin(a));
      const p = vscale(dir, L);
      const i1 = addNode(vscale(dir, L * 0.4)), i2 = addNode(p);
      edges.push([c, i1]); edges.push([i1, i2]);
      const mod = ring(L * 0.16, 'y', 6, a, p);
      for (const id of mod) edges.push([i2, id]);
      ports.push(vadd(p, v3(0, L * 0.22, 0)));
    }
    edges.push([c, addNode(v3(0, L * 0.35, 0))]);
    edges.push([c, addNode(v3(0, -L * 0.35, 0))]);
  } else { // lattice
    const L = size * 1.2, W = size * 0.35;
    const corners = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      corners.push(addNode(v3(sx * L * 0.5, 0, sz * W * 0.5)));
    }
    for (let i = 0; i < 4; i++) edges.push([corners[i], corners[(i + 1) % 4]]);
    for (const sy of [-W * 0.5, W * 0.5]) {
      const r = [];
      for (let i = 0; i < 6; i++) {
        r.push(addNode(v3(-L * 0.5 + (i / 5) * L, sy * 0.5, 0)));
      }
      for (let i = 0; i < 5; i++) {
        edges.push([r[i], r[i + 1]]);
        edges.push([r[i], r[(i + 2) % 6]]);
      }
    }
    const mast = addNode(v3(0, size * 0.7, 0));
    edges.push([mast, corners[0]]);
    ports.push(v3(L * 0.5, W * 0.75, W * 0.5), v3(-L * 0.5, W * 0.75, -W * 0.5));
  }
  if (ports.length === 0) ports.push(v3(size * 0.8, 0, 0), v3(-size * 0.8, 0, 0));
  return { nodes, edges, ports };
}

function genAsteroidVerts(rng, radius) {
  const n = rng.int(8, 13);
  const verts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const rr = radius * rng.range(0.72, 1.12);
    verts.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
  }
  return verts;
}

function asteroidName(rng, idx) {
  const letters = 'KVTRHMZDLN';
  return `${letters[rng.int(0, letters.length - 1)]}${letters[rng.int(0, letters.length - 1)]}-${rng.int(100, 999)}${idx % 97}`;
}

export function buildWorld(seedStr) {
  const rng = new RNG(seedStr);
  const world = {
    seed: seedStr,
    rng,
    moon: {
      kind: 'moon', name: 'KVELD', pos: v3(), vel: v3(), radius: MOON_RADIUS, mu: MOON_MU,
      rotAngle: 0, spinRate: TAU / (2 * 3600), color: '#9fb4c7', comp: { rock: 1, metal: 0.2, ice: 0.15, carbon: 0.1 },
      scanned: 1, type: 'SILICATE MOON',
    },
    planet: {
      kind: 'planet', name: 'VETR', pos: { ...PLANET_POS }, vel: v3(), radius: PLANET_RADIUS, mu: PLANET_MU,
      color: '#e8a56a', rings: true, type: 'GAS GIANT', scanned: 1,
    },
    comet: null,
    stations: [],
    asteroids: [],
    derelicts: [],
    nests: [],
    orbiters: [],   // everything on rails (stations, asteroids, derelicts)
  };

  // ---- stations ----
  for (const def of STATION_DEFS) {
    const srng = rng.fork('station:' + def.id);
    const omega = Math.sqrt(MOON_MU / def.orbitR) / def.orbitR;
    const mesh = makeMesh(def.kind, def.size, srng);
    const st = {
      kind: 'station', id: def.id, name: def.name, subkind: def.kind,
      desc: def.desc, roles: def.roles, services: def.services.slice(),
      size: def.size, color: def.color,
      orbit: { r: def.orbitR, omega, phase: srng.angle(), incl: def.incl, asc: srng.angle() },
      pos: v3(), vel: v3(),
      quat: qaxis(0, 1, 0, srng.angle()),
      rotAxis: vnorm(v3(srng.range(-0.2, 0.2), 1, srng.range(-0.2, 0.2))),
      rotRate: def.rotRate * DEG,
      rotAngle: 0,
      mesh, portsLocal: mesh.ports,
      padsLocal: mesh.ports.map((lp) => {
        const dl = Math.max(1e-6, Math.hypot(lp.x, lp.y, lp.z));
        return v3((lp.x / dl) * def.size * 1.02, (lp.y / dl) * def.size * 1.02, (lp.z / dl) * def.size * 1.02);
      }),
      ports: [], // filled each tick: {pos, dir}
      pads: [],  // filled each tick: {pos, normal}
      hull: 100,
      interiorId: 'st_' + def.id,
      marketSeed: srng.int(1, 1e9),
      scanned: 0,
      distFromMoon: def.orbitR,
    };
    world.stations.push(st);
    world.orbiters.push(st);
  }

  // ---- asteroid belt ----
  const beltCount = 380;
  for (let i = 0; i < beltCount; i++) {
    const arng = rng.fork('ast:' + i);
    const rOrbit = arng.range(4200, 7600) + (arng.chance(0.08) ? arng.range(-900, 900) : 0);
    const radius = Math.pow(arng.next(), 1.6) * 49 + 6; // many small, few big
    const comp = arng.weighted([
      [{ rock: 0.8, metal: 0.15, ice: 0.03, carbon: 0.02 }, 0.5],
      [{ rock: 0.45, metal: 0.45, ice: 0.05, carbon: 0.05 }, 0.25],
      [{ rock: 0.3, metal: 0.05, ice: 0.6, carbon: 0.05 }, 0.15],
      [{ rock: 0.35, metal: 0.15, ice: 0.05, carbon: 0.45 }, 0.1],
    ]);
    const richness = clamp(arng.range(0.05, 1.0) * (comp.metal > 0.3 ? 1.3 : comp.ice > 0.4 ? 1.1 : 0.8), 0.05, 1);
    const ast = {
      kind: 'asteroid', idx: i, name: asteroidName(arng, i),
      orbit: { r: rOrbit, omega: Math.sqrt(MOON_MU / rOrbit) / rOrbit, phase: arng.angle(), incl: arng.range(-5, 5) * DEG, asc: arng.angle() },
      pos: v3(), vel: v3(),
      radius,
      comp, richness,
      spinAxis: vnorm(v3(arng.range(-1, 1), arng.range(-1, 1), arng.range(-1, 1))),
      spinRate: TAU / arng.range(60, 600) * (arng.chance(0.5) ? 1 : -1),
      spinAngle: arng.angle(),
      verts: genAsteroidVerts(arng, radius),
      cave: false, caveId: null,
      scanned: 0, scanInfo: null,
      oreLeft: Math.round(radius * richness * 2.2),
      metal: comp.metal > 0.25,
      seed: arng.int(1, 1e9),
    };
    if (radius >= 30 && arng.chance(0.28) && world.asteroids.filter(a => a.cave).length < 9) {
      ast.cave = true;
      ast.caveId = 'cave_' + i;
    }
    world.asteroids.push(ast);
    world.orbiters.push(ast);
  }

  // ---- derelicts ----
  const derelictDefs = [
    { name: 'SS KVALØY', sub: 'ore hauler', loot: 5 },
    { name: 'MSV ISBOD', sub: 'ice tanker', loot: 4 },
    { name: 'TDR-7 “VEILS”', sub: 'survey corvette', loot: 6 },
    { name: 'UNREGISTERED HULK', sub: 'unknown origin', loot: 8 },
  ];
  for (let i = 0; i < derelictDefs.length; i++) {
    const drng = rng.fork('derelict:' + i);
    const d = derelictDefs[i];
    const rOrbit = drng.range(5600, 8200);
    const der = {
      kind: 'derelict', id: 'der_' + i, name: d.name, sub: d.sub,
      orbit: { r: rOrbit, omega: Math.sqrt(MOON_MU / rOrbit) / rOrbit, phase: drng.angle(), incl: drng.range(-8, 8) * DEG, asc: drng.angle() },
      pos: v3(), vel: v3(),
      radius: drng.range(14, 22),
      spinAxis: vnorm(v3(drng.range(-1, 1), drng.range(-1, 1), drng.range(-1, 1))),
      spinRate: TAU / drng.range(120, 500),
      spinAngle: drng.angle(),
      color: '#8d99a6',
      lootCrates: d.loot,
      tech: drng.int(1, 3),
      interiorId: 'der_' + i,
      scanned: 0,
      seed: drng.int(1, 1e9),
    };
    world.derelicts.push(der);
    world.orbiters.push(der);
  }

  // ---- comet GRÍM-1 ----
  const a = 6200, e = 0.72;
  world.comet = {
    kind: 'comet', name: 'GRÍM-1', type: 'COMET',
    a, e,
    period: TAU * Math.sqrt((a * a * a) / MOON_MU),
    M0: rng.angle(),
    radius: 120,
    pos: v3(), vel: v3(),
    scanned: 0,
    color: '#aef',
  };

  // ---- pirate nests ----
  for (let i = 0; i < 3; i++) {
    const nrng = rng.fork('nest:' + i);
    const rOrbit = nrng.range(5000, 7000);
    const th = nrng.angle();
    world.nests.push({
      id: 'nest_' + i,
      pos: v3(Math.cos(th) * rOrbit, Math.sin(th) * rOrbit, nrng.range(-160, 160)),
      cooldown: 0,
      alive: 0,
      name: ['RED JACKAL', 'VOID CATS', 'PALE SYNDICATE'][i],
    });
  }

  // orbital kinematics ------------------------------------------------------
  const basis = (orb) => {
    const ci = Math.cos(orb.incl), si = Math.sin(orb.incl);
    const ca = Math.cos(orb.asc), sa = Math.sin(orb.asc);
    // node rotation about z by asc, then inclination about x
    return {
      e1: v3(ca, sa * ci, sa * si),
      e2: v3(-sa, ca * ci, ca * si),
    };
  };
  const updateOrbiter = (o, t) => {
    const { e1, e2 } = basis(o.orbit);
    const th = o.orbit.phase + o.orbit.omega * t;
    const c = Math.cos(th), s = Math.sin(th);
    o.pos = vadd(vscale(e1, c * o.orbit.r), vscale(e2, s * o.orbit.r));
    const dc = -Math.sin(th) * o.orbit.omega, ds = Math.cos(th) * o.orbit.omega;
    o.vel = vadd(vscale(e1, dc * o.orbit.r), vscale(e2, ds * o.orbit.r));
    if (o.spinRate !== undefined) o.spinAngle += o.spinRate * 0; // integrated in update
  };

  world.update = (t, dt) => {
    for (const o of world.orbiters) {
      updateOrbiter(o, t, dt);
      if (o.spinRate) o.spinAngle += o.spinRate * dt;
      if (o.quat && o.rotRate !== undefined && o.subkind) {
        o.quat = qnorm(qmul(o.quat, qaxis(o.rotAxis.x, o.rotAxis.y, o.rotAxis.z, o.rotRate * dt))); // rotate in body frame
      }
      if (o.kind === 'station') {
        o.ports = o.portsLocal.map((lp) => {
          const wp = qrot(o.quat, lp);
          return { pos: vadd(wp, o.pos), dir: vnorm(wp) };
        });
        o.pads = o.padsLocal.map((lp) => {
          const wp = qrot(o.quat, lp);
          return { pos: vadd(wp, o.pos), normal: vnorm(wp) };
        });
      }
    }
    // comet: Kepler via mean anomaly (Newton solve, cached)
    const c = world.comet;
    const M = (c.M0 + (TAU / c.period) * t) % TAU;
    let Eap = M;
    for (let i = 0; i < 6; i++) Eap = Eap - (Eap - c.e * Math.sin(Eap) - M) / (1 - c.e * Math.cos(Eap));
    const xp = c.a * (Math.cos(Eap) - c.e), yp = c.a * Math.sqrt(1 - c.e * c.e) * Math.sin(Eap);
    const rNow = c.a * (1 - c.e * Math.cos(Eap));
    // in orbital plane; tilt the plane for visual interest
    const inc = 14 * DEG, asc = 2.1;
    const ci = Math.cos(inc), si = Math.sin(inc), ca = Math.cos(asc), sa = Math.sin(asc);
    c.pos = v3(
      ca * xp - sa * yp * ci,
      sa * xp + ca * yp * ci,
      yp * si
    );
    const n = Math.sqrt(MOON_MU / c.a);
    const vfac = n / (1 - c.e * Math.cos(Eap));
    const vx = -c.a * Math.sin(Eap) * vfac, vy = c.a * Math.sqrt(1 - c.e * c.e) * Math.cos(Eap) * vfac;
    c.vel = v3(ca * vx - sa * vy * ci, sa * vx + ca * vy * ci, vy * si);
    c.distMoon = rNow;
  };

  // names/descriptions of nests set above
  return world;
}
