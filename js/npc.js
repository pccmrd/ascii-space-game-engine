// npc.js — hostile drone AI for the belt nests.

import { v3, vadd, vsub, vscale, vlen, vdist, vnorm, vdot, vcross, clamp, qident, qintegrate, qaxis } from './core.js';
import { gravityAt, spawnProjectile, burst } from './physics.js';
import { G } from './state.js';

export function spawnDrone(Gp, nestPos, name) {
  const a = Math.random() * Math.PI * 2;
  const r = 8 + Math.random() * 14;
  const dr = {
    kind: 'drone', name,
    pos: v3(nestPos.x + Math.cos(a) * r, nestPos.y + Math.sin(a) * r, nestPos.z + (Math.random() - 0.5) * r),
    vel: v3(), hp: 26, maxHp: 26,
    state: 'attack', fireCd: 1 + Math.random(),
    orbitDir: Math.random() < 0.5 ? 1 : -1,
    quat: qident(),
    color: '#ff6a5c',
    think: Math.random(),
  };
  Gp.drones.push(dr);
  return dr;
}

export function updateDrones(Gp, dt) {
  const pl = Gp.player;
  const pPos = pl.mode === 'ship' ? pl.ship.pos : pl.mode === 'interior' ? null : pl.foot ? pl.foot.pos : pl.eva.pos;
  if (!pPos) return;
  for (const dr of Gp.drones) {
    if (dr.dead) continue;
    const toP = vsub(pPos, dr.pos);
    const dist = vlen(toP);
    const dir = vscale(toP, 1 / Math.max(dist, 1e-3));

    // desired position: orbit ring around player at ~90m
    const tangent = vnorm(vcross(dir, v3(0, 0, 1)));
    const wish = vadd(
      vscale(dir, dist > 110 ? 9 : dist < 70 ? -7 : 0),
      vscale(tangent, dr.orbitDir * 7)
    );
    let acc = gravityAt(Gp.world, dr.pos, v3());
    acc = vadd(acc, vscale(wish, 1.4));
    // damping for control
    acc = vadd(acc, vscale(dr.vel, -0.5));
    dr.vel = vadd(dr.vel, vscale(acc, dt));
    // cap speed
    const sp = vlen(dr.vel);
    if (sp > 26) dr.vel = vscale(dr.vel, 26 / sp);
    dr.pos = vadd(dr.pos, vscale(dr.vel, dt));

    // face player
    dr.think -= dt;
    dr.fireCd -= dt;
    if (dist < 260 && dr.fireCd <= 0) {
      dr.fireCd = 0.9 + Math.random() * 0.7;
      const spread = 0.03;
      const aim = vnorm(vadd(dir, v3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread)));
      const inherit = vscale(dr.vel, 0.5);
      spawnProjectile(Gp, dr.pos, aim, 130, { dmg: 5, friendly: false, inheritVel: inherit, life: 2.6 });
      Gp.audio.laser();
    }
    // asteroid collision soft push
    if (Math.random() < 0.02) {
      const s = Gp.world.asteroids.find(a => vdist(a.pos, dr.pos) < a.radius + 2);
      if (s) dr.vel = vadd(dr.vel, v3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6));
    }
  }
  // cleanup dead
  for (let i = Gp.drones.length - 1; i >= 0; i--) if (Gp.drones[i].dead) Gp.drones.splice(i, 1);
}
