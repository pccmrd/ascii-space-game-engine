// player.js — mode state machine: SHIP flight, EVA, surface WALK, station/cave INTERIOR.
// Pure logic module (DOM only via injected G fields).

import { v3, vadd, vsub, vscale, vlen, vdist, vnorm, vdot, vcross, vlerp, clamp, lerp, qident, qaxis, qmul, qrot, qintegrate, qslerp, qforward, qup, TAU } from './core.js';
import { gravityAt, findSurface, burst } from './physics.js';

export function createPlayer() {
  return {
    mode: 'ship',
    ship: {
      pos: v3(), vel: v3(), quat: qident(),
      rates: v3(),              // body angular velocity rad/s
      fuel: 100, hull: 100, shield: 60, maxHull: 100, maxShield: 60,
      cargo: {}, cargoCap: 24,   // ore units by kind
      credits: 120,
      gearDown: false, landedOn: null, landedName: '',
      dockedTo: null,            // {type:'station', id, portIdx, local:{pos,quat}}
      anchoredTo: null,          // {ast, localPos, localQuat, surfaceVel}
      thrustVis: v3(),           // last applied thrust for fx
      fireCooldown: 0,
      scanRange: 2600,
    },
    eva: { pos: v3(), vel: v3(), fuel: 60, maxFuel: 60 },
    foot: {
      pos: v3(), vel: v3(), up: v3(0, 1, 0), heading: 0,
      body: null, magboots: true, attached: false, walkPhase: 0,
      fireCooldown: 0,
    },
    interior: null,             // {map, pos:{x,y}, prevMode}
    hullFlash: 0,
  };
}

// velocity of the exact surface point of a spinning body
export function surfaceVelocity(body, p) {
  const sv = body.vel ? { ...body.vel } : v3();
  if (body.spinRate && body.spinAxis) {
    const rx = p.x - body.pos.x, ry = p.y - body.pos.y, rz = p.z - body.pos.z;
    const w = body.spinAxis, wr = body.spinRate;
    sv.x += (w.y * rz - w.z * ry) * wr;
    sv.y += (w.z * rx - w.x * rz) * wr;
    sv.z += (w.x * ry - w.y * rx) * wr;
  }
  return sv;
}

// ---------------------------------------------------------------- SHIP
export function updateShip(Gp, dt) {
  const sh = Gp.player.ship;
  const inp = Gp.input;

  // --- docked: kinematic attachment ---
  if (sh.dockedTo) {
    const st = Gp.world.stations.find(s => s.id === sh.dockedTo.id);
    if (!st) { sh.dockedTo = null; return; }
    const port = st.ports[sh.dockedTo.portIdx];
    if (!port) { sh.dockedTo = null; return; }
    const lq = sh.dockedTo.localQuat, lp = sh.dockedTo.localPos;
    sh.pos = vadd(port.pos, qrot(st.quat, lp));
    sh.quat = qmul(st.quat, lq);
    sh.vel = surfaceVelocity(st, sh.pos);
    sh.rates = v3();
    sh.thrustVis = v3();
    return;
  }

  // --- anchored to asteroid: kinematic attachment to spinning rock ---
  if (sh.anchoredTo) {
    const a = sh.anchoredTo.ast;
    const rot = qaxis(a.spinAxis.x, a.spinAxis.y, a.spinAxis.z, a.spinAngle);
    sh.pos = vadd(a.pos, qrot(rot, sh.anchoredTo.localPos));
    sh.quat = qmul(rot, sh.anchoredTo.localQuat);
    sh.vel = surfaceVelocity(a, sh.pos);
    sh.rates = v3();
    sh.thrustVis = v3();
    return;
  }

  // --- landed: sitting on a surface ---
  if (sh.landedOn) {
    const b = sh.landedOn;
    const n = vnorm(vsub(sh.pos, b.pos));
    // re-seat exactly on surface
    sh.pos = vadd(b.pos, vscale(n, b.radius + 0.6));
    sh.vel = surfaceVelocity(b, sh.pos);
    sh.rates = v3();
    // gentle align of ship up to normal
    const curUp = qup(sh.quat);
    const targetQ = quatFromUp(n, sh.quat);
    sh.quat = qslerp(sh.quat, targetQ, 1 - Math.pow(0.001, dt));
    sh.thrustVis = v3();
    const thr = shipThrustInput(Gp);
    if (thr.y > 0 && !sh.gearDown) {
      // liftoff
      sh.landedOn = null; sh.landedName = '';
      sh.vel = vadd(sh.vel, vscale(n, 2.5));
      Gp.audio.jump();
    }
    return;
  }

  // --- free flight ---
  const thr = shipThrustInput(Gp, false);
  const fwd = qforward(sh.quat);
  const up = qup(sh.quat);
  const right = vcross(fwd, up);
  const acc = gravityAt(Gp.world, sh.pos, v3());
  let thrustAcc = v3();
  thrustAcc = vadd(thrustAcc, vscale(fwd, thr.x));
  thrustAcc = vadd(thrustAcc, vscale(up, thr.y));
  thrustAcc = vadd(thrustAcc, vscale(right, -thr.z));

  const dampeners = Gp.settings.dampeners;
  if (dampeners) {
    // counter-thrust on axes with no input
    const lv = vdot(sh.vel, fwd), lu = vdot(sh.vel, up), lr = vdot(sh.vel, right);
    const cap = 4;
    // deadband: assist won't fight slow drift / landing approaches
    if (Math.abs(thr.x) < 0.01 && Math.abs(lv) > 2.5) thrustAcc = vadd(thrustAcc, vscale(fwd, clamp(-lv / Math.max(dt, 1e-4) * 0.5, -cap, cap)));
    if (Math.abs(thr.y) < 0.01 && Math.abs(lu) > 2.5) thrustAcc = vadd(thrustAcc, vscale(up, clamp(-lu / Math.max(dt, 1e-4) * 0.5, -cap, cap)));
    if (Math.abs(thr.z) < 0.01 && Math.abs(lr) > 2.5) thrustAcc = vadd(thrustAcc, vscale(right, clamp(-lr / Math.max(dt, 1e-4) * 0.5, -cap, cap)));
  }
  // brake key X: heavy damping
  if (inp.down('KeyX')) {
    const dv = vscale(sh.vel, clamp(1.6 / Math.max(dt, 1e-4) * dt, 0, 6));
    sh.vel = vsub(sh.vel, dv);
  }

  const usedFuel = (Math.abs(thr.x) + Math.abs(thr.y) + Math.abs(thr.z)) * dt * 0.06;
  if (usedFuel > 0 && sh.fuel > 0) sh.fuel = Math.max(0, sh.fuel - usedFuel);

  sh.vel = vadd(sh.vel, vscale(vadd(acc, thrustAcc), dt));
  sh.pos = vadd(sh.pos, vscale(sh.vel, dt));
  sh.thrustVis = thrustAcc;
  // exhaust shimmer
  if (vlen(thrustAcc) > 0.5 && sh.fuel > 0 && Math.random() < dt * 45) {
    burst(Gp, vadd(sh.pos, vscale(fwd, -2.6)), 1, '#ffb36a', { speed: 2.5, life: 0.35 });
  }

  // attitude
  const rateTarget = v3(
    (inp.down('KeyE') ? -1 : 0) + (inp.down('KeyQ') ? 1 : 0),
    (inp.down('ArrowLeft') ? 1 : 0) + (inp.down('ArrowRight') ? -1 : 0),
    (inp.down('ArrowUp') ? 1 : 0) + (inp.down('ArrowDown') ? -1 : 0)
  );
  const maxRate = 1.4;
  sh.rates.x = lerp(sh.rates.x, rateTarget.x * maxRate, 1 - Math.pow(0.002, dt));
  sh.rates.y = lerp(sh.rates.y, rateTarget.y * maxRate, 1 - Math.pow(0.002, dt));
  sh.rates.z = lerp(sh.rates.z, rateTarget.z * maxRate, 1 - Math.pow(0.002, dt));
  sh.quat = qintegrate(sh.quat, sh.rates.x, sh.rates.y, sh.rates.z, dt);

  // --- surface contact / landing ---
  const surf = findSurface(Gp.world, sh.pos);
  if (surf && surf.gap <= 1.2) {
    const sv = surfaceVelocity(surf.body, sh.pos);
    const relV = vsub(sh.vel, sv);
    const closing = -vdot(relV, surf.normal);
    const impactSpeed = vlen(relV);
    if (closing > 0) {
      if ((sh.gearDown || closing < 3.5) && impactSpeed < 8) {
        // LAND
        sh.landedOn = surf.body;
        sh.landedName = surf.body.name || surf.body.id || 'SURFACE';
        sh.pos = vadd(surf.body.pos, vscale(surf.normal, surf.radius + 0.6));
        sh.vel = sv;
        Gp.audio.land();
        burst(Gp, sh.pos, 10, '#aab', { speed: 3, life: 0.5 });
        Gp.hud && Gp.hud.log(`TOUCHDOWN — ${sh.landedName}`, '#b7ff7a');
      } else {
        // crash bounce
        const dmg = Math.max(0, (impactSpeed - 3) * 7);
        sh.hull = Math.max(0, sh.hull - dmg);
        const vn = vscale(surf.normal, vdot(relV, surf.normal));
        const vt = vsub(relV, vn);
        sh.vel = vadd(sv, vadd(vscale(vn, -0.35), vscale(vt, 0.8)));
        sh.pos = vadd(sh.pos, vscale(surf.normal, surf.gap * -1 + 0.2));
        Gp.audio.hit();
        burst(Gp, sh.pos, 16, '#ffb36a');
        Gp.hud && Gp.hud.log(`HULL IMPACT −${Math.round(dmg)}`, '#ff6a5c');
        Gp.player.hullFlash = 0.5;
      }
    }
  }
}

function shipThrustInput(Gp, landedView) {
  const inp = Gp.input;
  const sh = Gp.player.ship;
  const boost = (inp.down('ShiftLeft') || inp.down('ShiftRight')) ? 2.2 : 1;
  const hasFuel = sh.fuel > 0;
  const tx = hasFuel ? ((inp.down('KeyW') ? 13 : 0) - (inp.down('KeyS') ? 6 : 0)) * boost : 0;
  const ty = hasFuel ? ((inp.down('KeyR') ? 5.5 : 0) - (inp.down('KeyF') ? 5.5 : 0)) * boost : 0;
  const tz = hasFuel ? ((inp.down('KeyD') ? 5.5 : 0) - (inp.down('KeyA') ? 5.5 : 0)) * boost : 0;
  if (landedView && ty <= 0) return v3(tx, ty, tz);
  return v3(tx, ty, tz);
}

// build a quaternion whose +y (up) points along n, preserving current heading as much as possible
function quatFromUp(n, refQ) {
  const fwd = qforward(refQ);
  const right = vnorm(vcross(fwd, n));
  if (vlen(right) < 1e-6) return qident();
  const newFwd = vnorm(vcross(n, right));
  // basis: x=fwd, y=up, z=? we want consistent: z = cross(x, y)?? build matrix columns
  const z = vcross(newFwd, n);
  return quatFromBasis(newFwd, n, z);
}

function quatFromBasis(x, y, z) {
  const m00 = x.x, m01 = z.x, m02 = y.x; // column-major careful: we store [x | z | y] as local->world
  const m10 = x.y, m11 = z.y, m12 = y.y;
  const m20 = x.z, m21 = z.z, m22 = y.z;
  const trace = m00 + m11 + m22;
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = { x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s, w: s / 4 };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s, w: (m21 - m12) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s, w: (m02 - m20) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4, w: (m10 - m01) / s };
  }
  return qmul(qnormLocal(q), qident());
}
function qnormLocal(q) {
  const l = Math.sqrt(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w)||1;
  return { x: q.x/l, y: q.y/l, z: q.z/l, w: q.w/l };
}

// ---------------------------------------------------------------- EVA
export function updateEVA(Gp, dt) {
  const ev = Gp.player.eva;
  const inp = Gp.input;
  const pl = Gp.player;
  // use ship quat as reference frame for controls (keeps controls intuitive)
  const refQ = pl.mode === 'eva' && pl.evaQuat ? pl.evaQuat : Gp.player.ship.quat;
  const fwd = qrot(refQ, v3(1, 0, 0));
  const up = qrot(refQ, v3(0, 1, 0));
  const right = vcross(fwd, up);
  let acc = gravityAt(Gp.world, ev.pos, v3());
  const boost = 1;
  let t = v3();
  if (ev.fuel > 0) {
    t = vadd(t, vscale(fwd, (inp.down('KeyW') ? 2.6 : 0) - (inp.down('KeyS') ? 1.6 : 0)));
    t = vadd(t, vscale(up, (inp.down('KeyR') ? 1.8 : 0) - (inp.down('KeyF') ? 1.8 : 0)));
    t = vadd(t, vscale(right, (inp.down('KeyD') ? 1.8 : 0) - (inp.down('KeyA') ? 1.8 : 0)));
    ev.fuel = Math.max(0, ev.fuel - vlen(t) * dt * 0.12);
  }
  acc = vadd(acc, vscale(t, boost));
  // handhold dampers
  const lv = vlen(ev.vel);
  if (lv > 0.01) acc = vadd(acc, vscale(vscale(ev.vel, -1 / lv), clamp(lv * 1.2, 0, 2.2) ));
  ev.vel = vadd(ev.vel, vscale(acc, dt));
  ev.pos = vadd(ev.pos, vscale(ev.vel, dt));
  // gentle orient ref to velocity? keep fixed frame; arrows could rotate eva view
  pl.evaQuat = qintegrate(pl.evaQuat || Gp.player.ship.quat, 0,
    (inp.down('ArrowLeft') ? 1 : 0) - (inp.down('ArrowRight') ? 1 : 0),
    (inp.down('ArrowUp') ? 1 : 0) - (inp.down('ArrowDown') ? -1 : 0), dt);

  // collide with surfaces softly
  const surf = findSurface(Gp.world, ev.pos);
  if (surf && surf.gap < 0.5) {
    const sv = surfaceVelocity(surf.body, ev.pos);
    const relV = vsub(ev.vel, sv);
    if (vdot(relV, surf.normal) < 0) {
      const imp = -vdot(relV, surf.normal);
      ev.vel = vadd(sv, vsub(relV, vscale(surf.normal, vdot(relV, surf.normal) * 1.3)));
      ev.pos = vadd(ev.pos, vscale(surf.normal, 0.5 - surf.gap));
      if (imp > 3) { damageFoot(Gp, (imp - 3) * 4); }
    }
  }
}

// ---------------------------------------------------------------- WALK (exterior surfaces, mag boots)
export function updateWalk(Gp, dt) {
  const ft = Gp.player.foot;
  const inp = Gp.input;
  const surf = findSurface(Gp.world, ft.pos);
  const body = surf ? surf.body : null;
  ft.body = body;
  const gravBody = body && body.mu ? body : null;

  // mag boots stick on metal asteroids & any structure hull
  const canStick = ft.magboots && body && (body.metal || surf.isStructure || body.kind === 'asteroid' && body.comp.metal > 0.2);

  if (surf && surf.gap < (ft.attached ? 6 : 2.5) && (canStick || surf.gap < 2.5)) {
    if (!ft.attached) {
      ft.attached = true;
      if (surf.gap > 0.8 && ft.vel.y !== undefined) { /* touchdown */ }
    }
    // orient up to normal
    const targetUp = surf.normal;
    ft.up = vnorm(vlerp(ft.up, targetUp, 1 - Math.pow(0.0005, dt)));

    // work in the body's local frame: relative velocity = vel - surface velocity
    const sv = surfaceVelocity(body, ft.pos);
    let rel = vsub(ft.vel, sv);
    const nComp = vdot(rel, ft.up);
    let tang = vsub(rel, vscale(ft.up, nComp));

    // gravity (mag boots cancel effective weight on hulls)
    const g = gravBody ? gravBody.mu / Math.max(100, vdist(gravBody.pos, ft.pos) ** 2) : 0;
    let nVel = canStick ? 0 : nComp - g * dt;

    // move relative to camera ground plane
    const camFwd = Gp.cam.fwd || v3(0, 0, 1);
    let mf = vnorm(vsub(camFwd, vscale(ft.up, vdot(camFwd, ft.up))));
    if (vlen(mf) < 1e-4) mf = v3(1, 0, 0);
    const mr = vnorm(vcross(mf, ft.up));
    const speed = canStick ? 4.2 : 5.2;
    let wish = v3();
    wish = vadd(wish, vscale(mf, inp.axis('KeyS', 'KeyW')));
    wish = vadd(wish, vscale(mr, inp.axis('KeyA', 'KeyD')));
    if (vlen(wish) > 0) { wish = vscale(vnorm(wish), speed); ft.walkPhase += dt * 9; }
    const grip = canStick ? 14 : 8;
    tang = vscale(tang, Math.max(0, 1 - grip * dt));
    tang = vadd(tang, vscale(vsub(wish, tang), clamp(10 * dt, 0, 1)));
    rel = vadd(vscale(ft.up, nVel), tang);

    // jump
    if (inp.hit('Space')) {
      rel = vadd(rel, vscale(ft.up, 3.2));
      Gp.audio.jump();
    }
    ft.vel = vadd(rel, sv);
    ft.pos = vadd(ft.pos, vscale(ft.vel, dt));

    // re-seat onto the surface (effective radius from findSurface)
    if (surf && surf.gap < 2) {
      const distNow = vdist(ft.pos, body.pos);
      ft.pos = vadd(ft.pos, vscale(surf.normal, (surf.radius + 0.5) - distNow));
    }
    ft.attached = true;
    // walked/jumped off into space?
    if (surf.gap > 9 && !canStick) {
      exitToEVA(Gp);
    }
  } else {
    // drifting just above surface / no contact
    ft.attached = false;
    let acc = gravBody ? vscale(vnorm(vsub(gravBody.pos, ft.pos)), (gravBody.mu / Math.max(100, vdist(gravBody.pos, ft.pos) ** 2))) : v3();
    ft.vel = vadd(ft.vel, vscale(acc, dt));
    ft.pos = vadd(ft.pos, vscale(ft.vel, dt));
    if (surf && surf.gap > 10) exitToEVA(Gp);
  }
  if (inp.hit('KeyM')) {
    ft.magboots = !ft.magboots;
    Gp.hud && Gp.hud.log(`MAG BOOTS ${ft.magboots ? 'ENGAGED' : 'RELEASED'}`, '#7af2ff');
  }
}

// ---------------------------------------------------------------- INTERIOR
export function updateInterior(Gp, dt) {
  const it = Gp.player.interior;
  if (!it) return;
  const inp = Gp.input;
  const map = it.map;
  const speed = 2.6;
  let dx = inp.axis('KeyA', 'KeyD');
  let dy = inp.axis('KeyW', 'KeyS');
  const len = Math.hypot(dx, dy) || 1;
  dx = (dx / len) * speed; dy = (dy / len) * speed;
  moveWithCollision(map, it.pos, dx * dt, dy * dt);
  it.walkPhase = (it.walkPhase || 0) + (Math.abs(dx) + Math.abs(dy)) * dt * 1.6;
}

function moveWithCollision(map, pos, mx, my) {
  const r = 0.3;
  const tryAxis = (nx, ny) => {
    const ch = charAt(map, nx, ny);
    if (isWall(ch)) return false;
    return true;
  };
  const nx = pos.x + mx;
  if (tryAxis(nx + Math.sign(mx) * r, pos.y - r * 0.7) && tryAxis(nx + Math.sign(mx) * r, pos.y + r * 0.7)) pos.x = nx;
  const ny = pos.y + my;
  if (tryAxis(pos.x - r * 0.7, ny + Math.sign(my) * r) && tryAxis(pos.x + r * 0.7, ny + Math.sign(my) * r)) pos.y = ny;
}

export function charAt(map, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= map.w || yi >= map.h) return '#';
  return map._raw[yi][xi];
}
export function setChar(map, x, y, ch) {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= map.w || yi >= map.h) return;
  map._raw[yi][xi] = ch;
}
function isWall(ch) { return ch === '#' || ch === undefined; }

// ---------------------------------------------------------------- transitions
export function exitShipToEVA(Gp, popVel = 1.2) {
  const pl = Gp.player;
  pl.mode = 'eva';
  pl.eva.pos = { ...pl.ship.pos };
  pl.eva.vel = vadd(pl.ship.vel, v3(0, popVel, 0));
  pl.eva.fuel = pl.eva.maxFuel;
  pl.evaQuat = { ...pl.ship.quat };
  Gp.hud && Gp.hud.log('EVA — suit thrusters online', '#7af2ff');
}

export function boardShip(Gp) {
  const pl = Gp.player;
  pl.mode = 'ship';
  pl.eva.fuel = Math.min(pl.eva.maxFuel, pl.eva.fuel);
  Gp.hud && Gp.hud.log('BOARDING CLAMP RELEASED — Welcome back, pilot.', '#b7ff7a');
}

export function exitToEVA(Gp, vel) {
  const pl = Gp.player;
  pl.mode = 'eva';
  pl.eva.pos = { ...pl.foot.pos };
  pl.eva.vel = vel ? { ...vel } : vadd(pl.foot.vel, v3(0, 1, 0));
  pl.eva.fuel = pl.eva.maxFuel;
  pl.evaQuat = quatFromUpSafe(pl.foot.up, pl.ship.quat);
  Gp.hud && Gp.hud.log('EVA — magnetic release', '#7af2ff');
}

function quatFromUpSafe(up, refQ) { try { return quatFromUp(up, refQ); } catch (e) { return qident(); } }

export function exitShipToWalk(Gp) {
  const pl = Gp.player;
  pl.mode = 'walk';
  pl.foot.pos = vadd(pl.ship.pos, vscale(vnorm(vsub(pl.ship.pos, pl.ship.landedOn.pos)), 2.2));
  pl.foot.vel = v3();
  const n = vnorm(vsub(pl.foot.pos, pl.ship.landedOn.pos));
  pl.foot.up = n;
  pl.foot.attached = true;
  pl.foot.magboots = true;
  Gp.hud && Gp.hud.log('MAG BOOTS ENGAGED — pressure nominal', '#b7ff7a');
}

export function damageFoot(Gp, dmg) {
  const pl = Gp.player;
  pl.ship.hull = Math.max(0, pl.ship.hull - dmg);
  Gp.player.hullFlash = 0.5;
  Gp.audio.hit();
  Gp.hud && Gp.hud.log(`SUIT INTEGRITY −${Math.round(dmg)}`, '#ff6a5c');
}
