// physics.js — Newtonian integration, gravity, surface queries, projectiles, particles.
// Pure module (no DOM).

import { v3, vadd, vsub, vscale, vlen, vdist, vnorm, vdot, clamp } from './core.js';
import { MOON_MU, PLANET_MU } from './world.js';

export function gravityAt(world, p, out = v3()) {
  // moon at origin
  let d2 = p.x * p.x + p.y * p.y + p.z * p.z;
  let d = Math.sqrt(d2);
  if (d > 1) {
    const a = MOON_MU / d2;
    out.x -= (p.x / d) * a; out.y -= (p.y / d) * a; out.z -= (p.z / d) * a;
  }
  // planet
  const pl = world.planet;
  const dx = pl.pos.x - p.x, dy = pl.pos.y - p.y, dz = pl.pos.z - p.z;
  const pd2 = dx * dx + dy * dy + dz * dz;
  const pd = Math.sqrt(pd2);
  if (pd > pl.radius * 0.5) {
    const a = PLANET_MU / pd2;
    out.x += (dx / pd) * a; out.y += (dy / pd) * a; out.z += (dz / pd) * a;
  }
  return out;
}

export function surfaceGravity(body, p) {
  const r = vdist(body.pos, p);
  const g = (body.mu || 0) / Math.max(1, r * r);
  return vscale(vnorm(vsub(body.pos, p)), g);
}

// Find the nearest solid/structure surface to point p.
// Returns {body, gap, normal, dist, relVel} or null when far from everything.
export function findSurface(world, p) {
  let best = null;
  const consider = (body, radius, isStructure) => {
    const d = vdist(p, body.pos);
    const gap = d - radius;
    if (!best || gap < best.gap) {
      best = { body, gap, normal: vnorm(vsub(p, body.pos)), dist: d, radius, isStructure, center: body.pos };
    }
  };
  consider(world.moon, world.moon.radius, false);
  consider(world.planet, world.planet.radius, false);
  // broad phase: only bodies plausibly near
  for (const a of world.asteroids) {
    const approx = Math.abs(vdist(p, a.pos));
    if (approx - a.radius < 60) consider(a, a.radius, false);
  }
  for (const s of world.stations) {
    const approx = vdist(p, s.pos);
    if (approx - s.size * 1.2 < 60) consider(s, s.size * 0.55, true);
    // docking pads float outside the hull sphere — landable
    for (const pad of (s.pads || [])) {
      const dp = vdist(p, pad.pos);
      if (dp - 8 < 60) {
        const gap = dp - 6;
        if (!best || gap < best.gap) {
          best = { body: s, gap, normal: pad.normal, dist: dp, radius: 6, isStructure: true, pad: true, center: pad.pos };
        }
      }
    }
  }
  for (const d of world.derelicts) {
    const approx = vdist(p, d.pos);
    if (approx - d.radius * 2 < 60) consider(d, d.radius, true);
  }
  return best;
}

// ---------------- projectiles ----------------
export function spawnProjectile(Gw, src, dir, speed, opts = {}) {
  Gw.projectiles.push({
    pos: { ...src }, vel: vadd(vscale(dir, speed), opts.inheritVel ? { ...opts.inheritVel } : v3()),
    life: opts.life || 3.2,
    dmg: opts.dmg || 8,
    friendly: !!opts.friendly,
    color: opts.color || (opts.friendly ? '#ffe08a' : '#ff6a5c'),
    ch: opts.ch || '*',
    size: opts.size || 0,
  });
}

export function updateProjectiles(Gw, dt, onHitPlayer) {
  const ps = Gw.projectiles;
  for (let i = ps.length - 1; i >= 0; i--) {
    const pr = ps[i];
    pr.life -= dt;
    pr.pos = vadd(pr.pos, vscale(pr.vel, dt));
    let dead = pr.life <= 0;
    if (!dead) {
      if (pr.friendly) {
        for (const dr of Gw.drones) {
          if (dr.dead) continue;
          if (vdist(pr.pos, dr.pos) < 3.2) {
            damageDrone(Gw, dr, pr.dmg);
            dead = true; break;
          }
        }
        // vs asteroids: zap sparks
        if (!dead) {
          const surf = fastAsteroidHit(Gw, pr.pos);
          if (surf) { dead = true; burst(Gw, pr.pos, 4, '#ffb36a'); }
        }
      } else {
        const pl = Gw.player;
        if (pl.mode === 'ship' && vdist(pr.pos, pl.ship.pos) < 3.0) {
          onHitPlayer(pr.dmg, pr.pos);
          dead = true;
        } else if ((pl.mode === 'eva' || pl.mode === 'walk') && vdist(pr.pos, footPos(pl)) < 2.0) {
          onHitPlayer(pr.dmg, pr.pos);
          dead = true;
        }
      }
    }
    if (dead) ps.splice(i, 1);
  }
}

function fastAsteroidHit(Gw, p) {
  for (const a of Gw.world.asteroids) {
    const d2 = (p.x - a.pos.x) ** 2 + (p.y - a.pos.y) ** 2 + (p.z - a.pos.z) ** 2;
    if (d2 < a.radius * a.radius) return a;
  }
  return null;
}

export function damageDrone(Gw, dr, dmg) {
  dr.hp -= dmg;
  burst(Gw, dr.pos, 5, '#ffd27a');
  if (dr.hp <= 0 && !dr.dead) {
    dr.dead = true;
    burst(Gw, dr.pos, 40, '#ff9d5c');
    burst(Gw, dr.pos, 24, '#ff5c4a');
    Gw.stats.kills++;
    Gw.audio.explosion();
    // salvage pod
    Gw.pickups.push({
      kind: 'pod', name: 'DRONE POD', pos: { ...dr.pos }, vel: v3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2),
      amount: 20 + Math.floor(Math.random() * 30), life: 60,
    });
  }
}

// ---------------- particles ----------------
export function burst(Gw, pos, n, color, opts = {}) {
  for (let i = 0; i < n; i++) {
    if (Gw.particles.length > 900) return;
    const sp = opts.speed || 8;
    Gw.particles.push({
      pos: { ...pos },
      vel: v3((Math.random() - 0.5) * sp, (Math.random() - 0.5) * sp, (Math.random() - 0.5) * sp),
      life: (opts.life || 0.8) * (0.5 + Math.random()),
      maxLife: opts.life || 0.8,
      color,
      ch: opts.ch || (Math.random() < 0.5 ? '.' : '*'),
    });
  }
}

export function updateParticles(Gw, dt) {
  const ps = Gw.particles;
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    p.life -= dt;
    p.pos = vadd(p.pos, vscale(p.vel, dt));
    if (p.life <= 0) ps.splice(i, 1);
  }
}

export function footPos(pl) {
  return pl.mode === 'interior'
    ? { x: pl.interior.pos.x, y: 0, z: pl.interior.pos.y }
    : pl.foot.pos;
}
