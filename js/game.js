// game.js — game rules & glue: modes, interactions, scanning, mining,
// docking, anchoring, landing/takeoff, market, drones triggers, save/load.

import { v3, vadd, vsub, vscale, vlen, vdist, vnorm, vdot, vcross, clamp, lerp, qident, qmul, qconj, qrot, qslerp, TAU, fmtInt, strHash } from './core.js';
import { gravityAt, findSurface, spawnProjectile, updateProjectiles, updateParticles, burst, footPos } from './physics.js';
import { createPlayer, updateShip, updateEVA, updateWalk, updateInterior, exitShipToEVA, exitToEVA, boardShip, exitShipToWalk, surfaceVelocity, charAt, setChar } from './player.js';
import { spawnDrone, updateDrones } from './npc.js';
import { buildStationInterior, buildCave, buildDerelictInterior } from './interiors.js';
import { G, SAVE_KEY } from './state.js';

const BASE_PRICES = { metal: 12, ice: 8, rock: 5, carbon: 15 };

export function newGame(seed) {
  const fresh = createPlayer();
  G.player = fresh;
  G.drones.length = 0; G.projectiles.length = 0; G.particles.length = 0; G.pickups.length = 0;
  G.target = null;
  G.time = 8 * 3600; G.day = 1; G.timeScale = 1;
  G.world.update(G.time, 0); // place orbiters at the new mission clock
  G.stats = { mined: 0, kills: 0, earned: 0, deaths: 0, dockedAt: {}, scanned: {} };
  G.lastDock = null; G.deathInfo = null;
  G.uiMode = 'play';
  G.hud.logEntries = [];
  // spawn: parked in orbit near Hregg's Gate, slightly offset
  const st = G.world.stations.find(s => s.id === 'hregg');
  G.player.ship.pos = vadd(st.pos, v3(0, 260, 120));
  G.player.ship.vel = { ...st.vel };
  G.player.ship.quat = qident();
  G.player.foot.up = v3(0, 0, 1);
  G.cam.x = G.player.ship.pos.x; G.cam.y = G.player.ship.pos.y; G.cam.z = G.player.ship.pos.z;
  G.hud.log('FLIGHT SYSTEMS ONLINE — KVELD CONTROL', '#b7ff7a');
  G.hud.log('TAB: target · V: scan · SPACE: lasers · H: manual', '#7af2ff');
}

export function update(Gp, rawDt) {
  const dt = rawDt * Gp.timeScale;
  Gp.time += dt;
  Gp.day = 1 + Math.floor(Gp.time / 86400);
  Gp.world.update(Gp.time, dt);

  // player mode updates
  const pl = Gp.player;
  if (pl.mode === 'ship') updateShip(Gp, dt);
  else if (pl.mode === 'eva') updateEVA(Gp, dt);
  else if (pl.mode === 'walk') updateWalk(Gp, dt);
  else if (pl.mode === 'interior') updateInterior(Gp, dt);

  // camera basis
  if (Gp.cam.mode === 'iso') Gp.cam.fwd = vnorm(v3(-1, -1, 0));
  else Gp.cam.fwd = v3(0, -1, 0);

  // timers
  const sh = pl.ship;
  sh.fireCooldown = Math.max(0, sh.fireCooldown - dt);
  sh.shield = Math.min(sh.maxShield, sh.shield + dt * (pl.hullFlash > 0 ? 0 : 1.2));
  pl.hullFlash = Math.max(0, pl.hullFlash - rawDt);
  pl.foot.fireCooldown = Math.max(0, pl.foot.fireCooldown - dt);

  handleUiInput(Gp, dt);
  updateScanning(Gp, dt);
  updateMining(Gp, dt);
  updateLasers(Gp, dt);
  updateNests(Gp, dt);
  updateDrones(Gp, dt);
  updateProjectiles(Gp, dt, (dmg, pos) => onPlayerHit(Gp, dmg, pos));
  updateParticles(Gp, dt);
  updatePickups(Gp, dt);
  updatePrompts(Gp);

  // zoom & view
  const inp = Gp.input;
  if (inp.down('Equal')) Gp.cam.zoom = clamp(Gp.cam.zoom * (1 + rawDt * 1.5), 0.12, 12);
  if (inp.down('Minus')) Gp.cam.zoom = clamp(Gp.cam.zoom / (1 + rawDt * 1.5), 0.12, 12);
  if (inp.hit('KeyZ')) { Gp.settings.iso = !Gp.settings.iso; Gp.cam.mode = Gp.settings.iso ? 'iso' : 'top'; }
  if (inp.hit('Digit1')) Gp.timeScale = 0.25;
  if (inp.hit('Digit2')) Gp.timeScale = 1;
  if (inp.hit('Digit3')) Gp.timeScale = 4;

  // hull death check
  if (sh.hull <= 0 && Gp.uiMode !== 'dead') {
    die(Gp);
  }

  // autosave
  Gp._autosaveT = (Gp._autosaveT || 0) + rawDt;
  if (Gp._autosaveT > 25) { Gp._autosaveT = 0; saveGame(true); }
}

// ---------------------------------------------------------------- input
export function handleUiInput(Gp, dt) {
  const inp = Gp.input;
  const pl = Gp.player;
  const sh = pl.ship;
  const ui = Gp.uiMode;

  if (ui === 'title') {
    if (inp.hit('Enter')) { Gp.audio.resume(); startFromTitle(Gp, false); }
    if (inp.hit('KeyN')) { Gp.audio.resume(); startFromTitle(Gp, true); }
    return;
  }
  if (ui === 'help') {
    if (inp.hit('KeyH') || inp.hit('Escape')) Gp.uiMode = Gp.prevUiMode;
    return;
  }
  if (ui === 'pause') {
    if (inp.hit('KeyP') || inp.hit('Escape')) Gp.uiMode = 'play';
    if (inp.hit('KeyK')) saveGame(true);
    if (inp.hit('KeyN')) { Gp.settings.mute = !Gp.settings.mute; Gp.audio.setEnabled(!Gp.settings.mute); }
    if (inp.hit('KeyQ')) location.reload();
    return;
  }
  if (ui === 'dead') {
    if (inp.hit('Enter')) respawn(Gp);
    return;
  }
  if (ui === 'market') { handleMarketInput(Gp); return; }

  // ---- play ----
  if (inp.hit('Escape') || inp.hit('KeyP')) { Gp.uiMode = 'pause'; return; }
  if (inp.hit('KeyH')) { Gp.prevUiMode = 'play'; Gp.uiMode = 'help'; return; }
  if (inp.hit('KeyN')) { Gp.settings.mute = !Gp.settings.mute; Gp.audio.setEnabled(!Gp.settings.mute); Gp.hud.log(`AUDIO ${Gp.settings.mute ? 'MUTED' : 'ON'}`, '#9fb4c7'); }
  if (inp.hit('Tab')) cycleTarget(Gp);
  if (inp.hit('KeyU')) { if (sh.dockedTo) undock(Gp); else saveGame(false); }
  if (inp.hit('KeyB')) callRescue(Gp);
  if (inp.hit('KeyG')) {
    Gp.settings.dampeners = !Gp.settings.dampeners;
    Gp.hud.log(`FLIGHT ASSIST ${Gp.settings.dampeners ? 'ON — inertial dampeners hold station' : 'OFF — pure Newtonian drift'}`, '#7af2ff');
  }

  // context interact
  if (inp.hit('KeyE')) interact(Gp);

  // gear (allowed anytime; takeoff needs gear up)
  if (inp.hit('KeyL') && pl.mode === 'ship') {
    sh.gearDown = !sh.gearDown;
    Gp.hud.log(`LANDING GEAR ${sh.gearDown ? 'DEPLOYED' : 'RETRACTED'}`, '#9fb4c7');
  }
  // anchor
  if (inp.hit('KeyK')) {
    if (sh.anchoredTo) releaseAnchor(Gp);
    else tryAnchor(Gp);
  }
  // EVA / boarding
  if (inp.hit('KeyJ')) {
    if (pl.mode === 'ship') {
      if (sh.dockedTo) Gp.hud.log('UNDOCK FIRST [U]', '#ff9d5c');
      else exitShipToEVA(Gp);
    } else if (pl.mode === 'eva') {
      if (vdist(pl.eva.pos, sh.pos) < 15) boardShip(Gp);
      else Gp.hud.log('TOO FAR FROM SHIP TO BOARD', '#ff9d5c');
    } else if (pl.mode === 'walk') {
      if ((sh.landedOn || sh.anchoredTo) && vdist(pl.foot.pos, sh.pos) < 12) {
        boardShip(Gp);
      } else {
        exitToEVA(Gp);
      }
    } else if (pl.mode === 'interior') {
      // step onto airlock tile then F
    }
  }
  // mining tool on foot
  if ((pl.mode === 'walk') && inp.down('KeyC')) mineToolFoot(Gp, dt);
  // lasers on foot/eva
  if ((pl.mode === 'eva' && (inp.down('Space') || inp.mouse.down)) ||
      (pl.mode === 'walk' && inp.mouse.clicked)) {
    fireHandLaser(Gp);
  }
}

// ---------------------------------------------------------------- targeting
function targetList(Gp) {
  const pl = Gp.player;
  const p = pl.mode === 'ship' ? pl.ship.pos : pl.mode === 'interior' ? null : pl.mode === 'eva' ? pl.eva.pos : pl.foot.pos;
  const list = [];
  for (const s of Gp.world.stations) list.push(s);
  for (const d of Gp.world.derelicts) list.push(d);
  for (const c of Gp.drones) if (!c.dead) list.push(c);
  list.push(Gp.world.comet);
  list.push(Gp.world.moon);
  list.push(Gp.world.planet);
  const asts = Gp.world.asteroids
    .map(a => ({ a, d: p ? vdist(a.pos, p) : 0 }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 22)
    .map(x => x.a);
  list.push(...asts);
  return list;
}

function cycleTarget(Gp) {
  const list = targetList(Gp);
  if (!list.length) return;
  let idx = list.indexOf(Gp.target);
  idx = (idx + 1) % list.length;
  Gp.target = list[idx];
  Gp.audio.pickup();
  Gp.hud.log(`TARGET: ${Gp.target.name || Gp.target.id}`, '#ffd27a');
}

// ---------------------------------------------------------------- scanning
function updateScanning(Gp, dt) {
  const inp = Gp.input;
  const t = Gp.target;
  if (!inp.down('KeyV') || !t) return;
  const pl = Gp.player;
  const range = pl.mode === 'ship' ? pl.ship.scanRange : 700;
  const p = pl.mode === 'ship' ? pl.ship.pos : pl.mode === 'eva' ? pl.eva.pos : pl.foot.pos;
  if (!p) return;
  const d = vdist(p, t.pos);
  if (d > range) { t._scanBlocked = true; return; }
  t._scanBlocked = false;
  if ((t.scanned || 0) >= 1) return;
  const rate = 0.55 * (1 - (d / range) * 0.65);
  t.scanned = clamp((t.scanned || 0) + rate * dt, 0, 1);
  if (Math.random() < dt * 6) Gp.audio.mineTick();
  if (t.scanned >= 1) {
    Gp.stats.scanned[t.id || t.name] = 1;
    Gp.audio.scanDone();
    let msg = `SCAN COMPLETE — ${t.name || t.id}`;
    if (t.kind === 'asteroid') msg += ` · ORE ${(t.richness * 100) | 0}% · ${compText(t)}`;
    if (t.kind === 'station') msg += ` · SERVICES ${t.services.join('/')}`;
    if (t.kind === 'derelict') msg += ` · ${t.lootCrates} CRATES, TECH x${t.tech}`;
    Gp.hud.log(msg, '#7af2ff');
  }
}
function compText(t) {
  const parts = [];
  if (t.comp) for (const k of ['metal', 'ice', 'rock', 'carbon']) if (t.comp[k] > 0.08) parts.push(`${k.toUpperCase()} ${(t.comp[k] * 100) | 0}%`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- mining
function updateMining(Gp, dt) {
  const inp = Gp.input;
  const pl = Gp.player;
  if (pl.mode !== 'ship') return;
  if (!inp.down('KeyC')) return;
  let t = Gp.target;
  if (!t || t.kind !== 'asteroid') {
    // QoL: auto-acquire the nearest rock in drill range
    let best = null, bd = 1e9;
    for (const a of Gp.world.asteroids) {
      const d = vdist(sh.pos, a.pos) - a.radius;
      if (d < 140 && d < bd) { bd = d; best = a; }
    }
    if (best) { Gp.target = best; t = best; }
  }
  if (!t || t.kind !== 'asteroid') return;
  const sh = pl.ship;
  const d = vdist(sh.pos, t.pos) - t.radius;
  if (d > 140) { return; }
  if ((t.scanned || 0) < 1) { Gp.hud.log('ROCK UNSCANNED — HOLD V TO SCAN', '#ff9d5c'); return; }
  if (t.oreLeft <= 0) { Gp.hud.log('VEIN DEPLETED', '#ff9d5c'); return; }
  const cargoN = Object.values(sh.cargo).reduce((a, b) => a + b, 0);
  if (cargoN >= sh.cargoCap) { Gp.hud.log('CARGO HOLD FULL', '#ff9d5c'); return; }
  sh._mineT = (sh._mineT || 0) + dt;
  if (sh._mineT > 0.55) {
    sh._mineT = 0;
    extractOre(Gp, sh, t, 1);
  }
  // beam fx
  const dir = vnorm(vsub(t.pos, sh.pos));
  const hit = vadd(sh.pos, vscale(dir, Math.max(2, vdist(sh.pos, t.pos) - t.radius)));
  if (Math.random() < dt * 30) burst(Gp, hit, 2, '#ffd27a', { speed: 6, life: 0.4 });
  if (Math.random() < dt * 8) Gp.audio.mineTick();
}

function extractOre(Gp, sh, ast, n) {
  // weighted by composition & richness
  const comp = ast.comp;
  const entries = [
    ['metal', comp.metal * (0.6 + ast.richness)],
    ['ice', comp.ice],
    ['carbon', comp.carbon * 1.2],
    ['rock', comp.rock * 0.6],
  ].filter(e => e[1] > 0.03);
  const total = entries.reduce((a, e) => a + e[1], 0);
  let r = Math.random() * total;
  let kind = entries[0][0];
  for (const e of entries) { r -= e[1]; if (r <= 0) { kind = e[0]; break; } }
  sh.cargo[kind] = (sh.cargo[kind] || 0) + n;
  ast.oreLeft -= n;
  Gp.stats.mined += n;
  Gp.hud.log(`EXTRACTED ${n}t ${kind.toUpperCase()}  (vein ${ast.oreLeft}t)`, '#ffd27a');
  Gp.audio.pickup();
}

function mineToolFoot(Gp, dt) {
  const ft = Gp.player.foot;
  const body = ft.body;
  if (!body) return;
  if (body.kind === 'asteroid' && body.scanned >= 1 && body.oreLeft > 0) {
    const surf = findSurface(Gp.world, ft.pos);
    if (surf && surf.gap < 2.5) {
      ft._mineT = (ft._mineT || 0) + dt;
      if (ft._mineT > 0.7) {
        ft._mineT = 0;
        const sh = Gp.player.ship;
        const cargoN = Object.values(sh.cargo).reduce((a, b) => a + b, 0);
        if (cargoN < sh.cargoCap) extractOre(Gp, sh, body, 1);
        else Gp.hud.log('CARGO HOLD FULL', '#ff9d5c');
      }
      if (Math.random() < dt * 20) burst(Gp, ft.pos, 2, '#ffd27a', { speed: 4, life: 0.35 });
    }
  } else {
    Gp.hud.log('NOTHING TO MINE HERE (scan rocks first)', '#ff9d5c');
    ft._mineT = -1;
  }
}

// ---------------------------------------------------------------- lasers & combat
function updateLasers(Gp, dt) {
  const inp = Gp.input;
  const pl = Gp.player;
  if (pl.mode !== 'ship') return;
  const sh = pl.ship;
  if (!(inp.down('Space') || inp.mouse.down)) return;
  if (sh.fireCooldown > 0) return;
  if (sh.landedOn || sh.dockedTo || sh.anchoredTo) return;
  sh.fireCooldown = 0.14;
  const fwd = qrot(sh.quat, v3(1, 0, 0));
  const src = vadd(sh.pos, vscale(fwd, 3));
  spawnProjectile(Gp, src, fwd, 240, { friendly: true, dmg: 8, inheritVel: sh.vel, life: 1.6 });
  Gp.audio.laser();
  burst(Gp, src, 2, '#ffe08a', { speed: 3, life: 0.2 });
}

function fireHandLaser(Gp) {
  const pl = Gp.player;
  if (pl.foot.fireCooldown > 0) return;
  pl.foot.fireCooldown = 0.3;
  const ref = pl.mode === 'eva' ? (pl.evaQuat || pl.ship.quat) : pl.ship.quat;
  const fwd = qrot(ref, v3(1, 0, 0));
  const src = vadd(footPos(pl), vscale(fwd, 1.5));
  spawnProjectile(Gp, src, fwd, 160, { friendly: true, dmg: 6, life: 1.2 });
  Gp.audio.laser();
}

export function onPlayerHit(Gp, dmg, pos) {
  const sh = Gp.player.ship;
  if (sh.shield > 0) {
    const absorbed = Math.min(sh.shield, dmg);
    sh.shield -= absorbed; dmg -= absorbed;
  }
  if (dmg > 0) sh.hull = Math.max(0, sh.hull - dmg);
  Gp.player.hullFlash = 0.4;
  Gp.audio.hit();
  burst(Gp, pos || footPos(Gp.player), 8, '#ffb36a');
}

// ---------------------------------------------------------------- docking / anchor / land
function nearestPort(Gp, pos) {
  const p = pos || Gp.player.ship.pos;
  let best = null;
  for (const st of Gp.world.stations) {
    for (let i = 0; i < st.ports.length; i++) {
      const port = st.ports[i];
      const d = vdist(p, port.pos);
      if (!best || d < best.d) best = { st, port, d, idx: i };
    }
  }
  return best;
}

export function interact(Gp) {
  const pl = Gp.player;
  const sh = pl.ship;

  if (pl.mode === 'ship') {
    if (sh.dockedTo) { enterStation(Gp, sh.dockedTo.id); return; }
    if (sh.landedOn) { exitShipToWalk(Gp); return; }
    // try dock
    const np = nearestPort(Gp);
    if (np && np.d < 26) {
      const sv = surfaceVelocity(np.st, sh.pos);
      const rel = vlen(vsub(sh.vel, sv));
      if (rel < 5) {
        doDock(Gp, np);
      } else {
        Gp.hud.log(`DOCKING ABORT — RELATIVE VELOCITY ${rel.toFixed(1)} m/s (need < 5)`, '#ff9d5c');
        Gp.audio.error();
      }
      return;
    }
    Gp.hud.log('NO DOCKING PORT IN RANGE', '#ff9d5c');
    return;
  }

  if (pl.mode === 'eva') {
    if (vdist(pl.eva.pos, sh.pos) < 15) { boardShip(Gp); return; }
    // space-walker airlock: drift into a dock collar and cycle in on foot
    const np = nearestPort(Gp, pl.eva.pos);
    if (np && np.d < 20) {
      const sv = surfaceVelocity(np.st, pl.eva.pos);
      if (vlen(vsub(pl.eva.vel, sv)) < 8) {
        Gp.stats.dockedAt[np.st.id] = 1;
        Gp.lastDock = { type: 'station', id: np.st.id, label: np.st.name };
        enterStation(Gp, np.st.id);
        Gp.hud.log('AIRLOCK DOCK — your ship remains outside', '#7af2ff');
        return;
      }
      Gp.hud.log(`AIRLOCK HOLD — RELATIVE VELOCITY ${vlen(vsub(pl.eva.vel, sv)).toFixed(1)} m/s (need < 8)`, '#ff9d5c');
      return;
    }
    Gp.hud.log('NOTHING TO INTERACT WITH — BOARD YOUR SHIP [J]', '#ff9d5c');
    return;
  }

  if (pl.mode === 'walk') {
    // board landed/anchored ship
    if ((sh.landedOn || sh.anchoredTo) && vdist(pl.foot.pos, sh.pos) < 12) { boardShip(Gp); return; }
    // cave entrance
    const surf = findSurface(Gp.world, pl.foot.pos);
    if (surf && surf.body.kind === 'asteroid' && surf.body.cave && surf.gap < 3) {
      const ent = caveEntrance(surf.body);
      if (vdist(pl.foot.pos, ent) < 6) { enterCave(Gp, surf.body); return; }
    }
    // derelict airlock
    if (surf && surf.body.kind === 'derelict' && surf.gap < 4) { enterDerelict(Gp, surf.body); return; }
    Gp.hud.log('NOTHING TO INTERACT WITH', '#ff9d5c');
    return;
  }

  if (pl.mode === 'interior') {
    const it = pl.interior;
    const ch = charAt(it.map, it.pos.x, it.pos.y);
    if (ch === 'A') { exitInterior(Gp); return; }
    const term = it.map.terminals.find(t => Math.floor(it.pos.x) === t.x && Math.floor(it.pos.y) === t.y);
    if (term) { openTerminal(Gp, term); return; }
    // loot crates/techs adjacent or underfoot
    const crate = it.map.crates.find(c => !c.looted && Math.abs(c.x + 0.5 - it.pos.x) < 0.8 && Math.abs(c.y + 0.5 - it.pos.y) < 0.8);
    if (crate) { lootCrate(Gp, it.map, crate); return; }
    const tech = it.map.techs.find(t => !t.looted && Math.abs(t.x + 0.5 - it.pos.x) < 0.8 && Math.abs(t.y + 0.5 - it.pos.y) < 0.8);
    if (tech) { lootTech(Gp, it.map, tech); return; }
    return;
  }
}

function doDock(Gp, np) {
  const sh = Gp.player.ship;
  const st = np.st;
  const conj = qconj(st.quat);
  sh.dockedTo = {
    type: 'station', id: st.id, portIdx: np.idx,
    localPos: qrot(conj, vsub(sh.pos, np.port.pos)),
    localQuat: qmul(conj, sh.quat),
  };
  sh.landedOn = null; sh.anchoredTo = null; sh.gearDown = false;
  Gp.stats.dockedAt[st.id] = 1;
  Gp.lastDock = { type: 'station', id: st.id, label: st.name };
  Gp.audio.dock();
  Gp.hud.log(`HARD DOCK — ${st.name} · AIRLOCK READY [E]`, '#b7ff7a');
}

function undock(Gp) {
  const sh = Gp.player.ship;
  if (!sh.dockedTo) return;
  const st = Gp.world.stations.find(s => s.id === sh.dockedTo.id);
  if (st) sh.vel = surfaceVelocity(st, sh.pos);
  sh.dockedTo = null;
  Gp.hud.log('UNDOCKED — THRUST AWAY GENTLY', '#9fb4c7');
}

function enterStation(Gp, stationId) {
  const st = Gp.world.stations.find(s => s.id === stationId);
  if (!st) return;
  const pl = Gp.player;
  let map = Gp._interiors[st.interiorId];
  if (!map) { map = buildStationInterior(st); Gp._interiors[st.interiorId] = map; }
  pl.mode = 'interior';
  pl.interior = { map, pos: { x: map.spawn.x, y: map.spawn.y }, prevMode: 'ship' };
  pl.ship.dockedTo = null;
  Gp.hud.log(`WELCOME TO ${st.name} — ARTIFICIAL GRAVITY 0.2 g`, '#7af2ff');
  Gp.audio.dock();
}

function enterCave(Gp, ast) {
  const pl = Gp.player;
  let map = Gp._interiors[ast.caveId];
  if (!map) { map = buildCave(ast.seed, ast.caveId); Gp._interiors[ast.caveId] = map; }
  pl.mode = 'interior';
  pl.interior = { map, pos: { x: map.spawn.x, y: map.spawn.y }, prevMode: 'walk' };
  pl._returnBody = ast;
  Gp.hud.log('ENTERING CAVERN — watch your step', '#9fd8e8');
}

function enterDerelict(Gp, der) {
  const pl = Gp.player;
  let map = Gp._interiors[der.interiorId];
  if (!map) { map = buildDerelictInterior(der); Gp._interiors[der.interiorId] = map; }
  pl.mode = 'interior';
  pl.interior = { map, pos: { x: map.spawn.x, y: map.spawn.y }, prevMode: 'walk' };
  pl._returnBody = der;
  Gp.hud.log(`BOARDING ${der.name} — salvage rights claimed`, '#ffd27a');
}

function exitInterior(Gp) {
  const pl = Gp.player;
  const it = pl.interior;
  const map = it.map;
  if (map.stationId) {
    // EVA onto the station hull
    const st = Gp.world.stations.find(s => s.id === map.stationId);
    pl.mode = 'walk';
    const dir = vnorm(qrot(st.quat, v3(0, 1, 0)));
    // spawn ON the actual surface (hull sphere or nearby pad)
    let raw = vadd(st.pos, vscale(dir, st.size * 1.1 + 2));
    const surf = findSurface(Gp.world, raw);
    let fp = raw, up = dir, body = st;
    if (surf) {
      fp = vadd(surf.center || surf.body.pos, vscale(surf.normal, (surf.pad ? 6 : surf.radius) + 1.0));
      up = surf.normal;
      body = surf.body;
    }
    pl.foot.pos = fp;
    pl.foot.vel = surfaceVelocity(body, fp);
    pl.foot.up = up;
    pl.foot.attached = true;
    pl.foot.magboots = true;
    pl.foot.body = body;
    pl.interior = null;
    Gp.hud.log('AIRLOCK CYCLING — MAG BOOTS ON HULL', '#7af2ff');
    return;
  }
  if (map.cave) {
    const ast = Gp.world.asteroids.find(a => a.caveId === map.exitTo);
    if (ast) {
      const ent = caveEntrance(ast);
      pl.mode = 'walk';
      pl.foot.pos = vadd(ent, vscale(vnorm(vsub(ent, ast.pos)), 2));
      pl.foot.vel = v3();
      pl.foot.up = vnorm(vsub(ent, ast.pos));
      pl.foot.attached = true;
      pl.foot.body = ast;
      pl.interior = null;
      Gp.hud.log('BACK ON THE SURFACE', '#9fd8e8');
      return;
    }
  }
  if (map.derelict) {
    const der = Gp.world.derelicts.find(d => d.id === map.exitTo);
    if (der) {
      pl.mode = 'walk';
      pl.foot.pos = vadd(der.pos, v3(der.radius + 1, 0, 0));
      pl.foot.vel = surfaceVelocity(der, pl.foot.pos);
      pl.foot.up = v3(1, 0, 0);
      pl.foot.attached = true;
      pl.foot.body = der;
      pl.interior = null;
      Gp.hud.log('OUTSIDE THE WRECK', '#9aa7b4');
      return;
    }
  }
  // fallback
  pl.mode = 'eva';
  pl.eva.pos = { ...Gp.player.ship.pos };
  pl.interior = null;
}

export function caveEntrance(ast) {
  const q = quatFromAxisAngleLocal(ast.spinAxis, ast.spinAngle);
  const e = vnorm(v3(ast.verts[0].x, ast.verts[0].y, 0));
  const we = qrot(q, e);
  return vadd(ast.pos, vscale(we, ast.radius));
}
function quatFromAxisAngleLocal(axis, ang) {
  const h = ang * 0.5, s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}

// ---------------------------------------------------------------- anchoring
function tryAnchor(Gp) {
  const sh = Gp.player.ship;
  const pl = Gp.player;
  if (pl.mode !== 'ship' || sh.landedOn || sh.dockedTo) return;
  let best = null;
  for (const a of Gp.world.asteroids) {
    const d = vdist(sh.pos, a.pos) - a.radius;
    if (d < 30 && (!best || d < best.d)) best = { a, d };
  }
  if (!best) { Gp.hud.log('ANCHOR: NO ROCK WITHIN 30 m OF SURFACE', '#ff9d5c'); return; }
  const q = quatFromAxisAngleLocal(best.a.spinAxis, best.a.spinAngle);
  const qc = qconj(q);
  sh.anchoredTo = {
    ast: best.a,
    localPos: qrot(qc, vsub(sh.pos, best.a.pos)),
    localQuat: qmul(qc, sh.quat),
  };
  Gp.audio.dock();
  Gp.hud.log(`MAG-ANCHOR SET ON ${best.a.name} — riding the spin`, '#7af2ff');
}

function releaseAnchor(Gp) {
  const sh = Gp.player.ship;
  if (!sh.anchoredTo) return;
  const a = sh.anchoredTo.ast;
  sh.vel = surfaceVelocity(a, sh.pos);
  sh.vel = vadd(sh.vel, v3(0, 0, 2));
  sh.anchoredTo = null;
  Gp.hud.log('ANCHOR RELEASED', '#9fb4c7');
}

// ---------------------------------------------------------------- loot
function lootCrate(Gp, map, crate) {
  crate.looted = true;
  setChar(map, crate.x, crate.y, '.');
  const amount = 8 + Math.floor(Math.random() * 22);
  Gp.player.ship.credits += amount;
  Gp.stats.earned += amount;
  Gp.hud.log(`CRATE OPENED — ${amount} CR SALVAGE`, '#ffd27a');
  Gp.audio.pickup();
}
function lootTech(Gp, map, tech) {
  tech.looted = true;
  setChar(map, tech.x, tech.y, '.');
  const amount = 40 + Math.floor(Math.random() * 60);
  Gp.player.ship.credits += amount;
  Gp.stats.earned += amount;
  Gp.hud.log(`TECH RECOVERED — ${amount} CR (black-box buyer pays well)`, '#d59aff');
  Gp.audio.pickup();
}

// ---------------------------------------------------------------- market
function openTerminal(Gp, term) {
  const st = Gp.world.stations.find(s => s.id === Gp.player.interior.map.stationId);
  if (!st) return;
  const rng = mulberryLocal(st.marketSeed + term.kind);
  const mult = {};
  for (const k of Object.keys(BASE_PRICES)) mult[k] = 0.8 + rng() * 0.45;
  if (st.roles.includes('refinery')) for (const k of Object.keys(mult)) mult[k] *= 1.15;
  const prices = {};
  for (const k of Object.keys(BASE_PRICES)) prices[k] = Math.max(2, Math.round(BASE_PRICES[k] * mult[k]));
  Gp.market = { station: st, kind: term.kind, prices };
  Gp.uiMode = 'market';
  Gp.audio.uiOpen();
}
function mulberryLocal(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function handleMarketInput(Gp) {
  const inp = Gp.input;
  const sh = Gp.player.ship;
  const mk = Gp.market;
  if (inp.hit('Escape') || inp.hit('KeyE')) { Gp.uiMode = 'play'; return; }
  const priceFuel = 2, priceRepair = 3;
  if (inp.hit('Digit1')) {
    if (mk.kind === 'market') {
      const prices = mk.prices;
      let gain = 0;
      for (const k of Object.keys(sh.cargo)) {
        gain += (sh.cargo[k] || 0) * prices[k];
        sh.cargo[k] = 0;
      }
      if (gain > 0) {
        sh.credits += gain; Gp.stats.earned += gain;
        Gp.hud.log(`CARGO SOLD — +${fmtInt(gain)} CR`, '#b7ff7a');
        Gp.audio.credits();
      } else Gp.hud.log('HOLD EMPTY — NOTHING TO SELL', '#ff9d5c');
    } else if (mk.kind === 'fuel') {
      const need = Math.ceil(100 - sh.fuel);
      const cost = need * priceFuel;
      if (need <= 0) Gp.hud.log('TANKS FULL', '#ff9d5c');
      else if (sh.credits < cost) Gp.hud.log(`NEED ${cost} CR — INSUFFICIENT`, '#ff9d5c');
      else { sh.credits -= cost; sh.fuel = 100; Gp.hud.log(`REFUELED −${cost} CR`, '#b7ff7a'); Gp.audio.credits(); }
    } else if (mk.kind === 'repair') {
      const need = Math.ceil(sh.maxHull - sh.hull);
      const cost = need * priceRepair;
      if (need <= 0) Gp.hud.log('HULL AT 100%', '#ff9d5c');
      else if (sh.credits < cost) Gp.hud.log(`NEED ${cost} CR — INSUFFICIENT`, '#ff9d5c');
      else { sh.credits -= cost; sh.hull = sh.maxHull; Gp.hud.log(`REPAIRED −${cost} CR`, '#b7ff7a'); Gp.audio.credits(); }
    }
  }
}

// ---------------------------------------------------------------- nests / pickups / rescue
function updateNests(Gp, dt) {
  for (const n of Gp.world.nests) {
    n.cooldown = Math.max(0, n.cooldown - dt);
    const p = Gp.player.mode === 'ship' ? Gp.player.ship.pos : Gp.player.foot ? Gp.player.foot.pos : Gp.player.eva.pos;
    if (!p) continue;
    const d = vdist(p, n.pos);
    if (d < 700 && n.cooldown <= 0 && Gp.drones.filter(x => !x.dead).length < 6) {
      n.cooldown = 90;
      const count = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) spawnDrone(Gp, n.pos, n.name);
      Gp.hud.log(`⚠ ${n.name} DRONE PATROL LAUNCHED`, '#ff6a5c');
      Gp.audio.alarm();
    }
  }
}

function updatePickups(Gp, dt) {
  const pl = Gp.player;
  const p = pl.mode === 'ship' ? pl.ship.pos : pl.mode === 'interior' ? null : pl.mode === 'eva' ? pl.eva.pos : pl.foot.pos;
  for (let i = Gp.pickups.length - 1; i >= 0; i--) {
    const pk = Gp.pickups[i];
    pk.life -= dt;
    pk.pos = vadd(pk.pos, vscale(pk.vel, dt));
    pk.vel = vscale(pk.vel, 1 - 0.2 * dt);
    if (pk.life <= 0) { Gp.pickups.splice(i, 1); continue; }
    if (p && vdist(p, pk.pos) < (pl.mode === 'ship' ? 12 : 4)) {
      pl.ship.credits += pk.amount;
      Gp.stats.earned += pk.amount;
      Gp.hud.log(`SALVAGE POD — +${pk.amount} CR`, '#ffd27a');
      Gp.audio.pickup();
      Gp.pickups.splice(i, 1);
    }
  }
}

function callRescue(Gp) {
  const sh = Gp.player.ship;
  if (sh.fuel > 5) { Gp.hud.log('RESCUE ONLY WHEN FUEL < 5%', '#ff9d5c'); return; }
  if (sh.credits < 50) { Gp.hud.log('RESCUE COSTS 50 CR — INSUFFICIENT', '#ff9d5c'); return; }
  sh.credits -= 50;
  sh.fuel = 18;
  const st = Gp.world.stations.find(s => s.id === (Gp.lastDock && Gp.lastDock.id) || 'hregg');
  sh.pos = vadd(st.pos, v3(0, 300, 150));
  sh.vel = { ...st.vel };
  if (Gp.player.mode !== 'ship') { Gp.player.mode = 'ship'; Gp.player.interior = null; }
  Gp.hud.log(`TUG DISPATCHED — delivered to ${st.name} approach (−50 CR)`, '#7af2ff');
  Gp.audio.dock();
}

function die(Gp) {
  Gp.stats.deaths++;
  Gp.uiMode = 'dead';
  Gp.deathInfo = ['Ejection seat fired. Pod beacon active.', 'The belt keeps what it kills. Not today.', 'Decompression in 3… 2… gone.'][Math.floor(Math.random() * 3)];
  Gp.audio.explosion();
  burst(Gp, Gp.player.mode === 'ship' ? Gp.player.ship.pos : footPos(Gp.player), 60, '#ff9d5c');
  Gp.audio.stopThrust();
}

function respawn(Gp) {
  const sh = Gp.player.ship;
  sh.hull = sh.maxHull; sh.shield = sh.maxShield;
  sh.fuel = Math.max(sh.fuel, 30);
  sh.credits = Math.floor(sh.credits * 0.85);
  sh.cargo = {};
  sh.dockedTo = null; sh.landedOn = null; sh.anchoredTo = null;
  const st = Gp.world.stations.find(s => s.id === (Gp.lastDock && Gp.lastDock.id) || 'hregg');
  Gp.player.mode = 'ship';
  Gp.player.interior = null;
  sh.pos = vadd(st.pos, v3(0, 260, 120));
  sh.vel = { ...st.vel };
  sh.quat = qident();
  Gp.uiMode = 'play';
  Gp.hud.log(`INSURANCE REBOOT — systems restored, −15% credits`, '#b7ff7a');
}

// ---------------------------------------------------------------- prompts
function updatePrompts(Gp) {
  const pl = Gp.player;
  const sh = pl.ship;
  let prompt = '';
  if (pl.mode === 'ship') {
    if (sh.dockedTo) prompt = '[E] ENTER STATION   [U] UNDOCK';
    else if (sh.landedOn) prompt = sh.gearDown ? '[E] EXIT ON FOOT   [L] RETRACT GEAR THEN [R] LIFT OFF' : '[E] EXIT ON FOOT   [R] THRUST TO LIFT OFF';
    else if (sh.anchoredTo) prompt = '[K] RELEASE ANCHOR   [J] EVA ONTO ROCK';
    else {
      const np = nearestPort(Gp);
      if (np && np.d < 26) {
        const rel = vlen(vsub(sh.vel, surfaceVelocity(np.st, sh.pos)));
        prompt = rel < 5 ? `[E] DOCK → ${np.st.name}` : `DOCK? MATCH VELOCITY (${rel.toFixed(1)} m/s)`;
      } else {
        // landing-pad guidance
        let padBest = null;
        for (const st of Gp.world.stations) {
          for (let i = 0; i < st.pads.length; i++) {
            const d = vdist(sh.pos, st.pads[i].pos);
            if (d < 220 && (!padBest || d < padBest.d)) padBest = { st, i, d };
          }
        }
        if (padBest) prompt = `[L] GEAR · DESCEND ON PAD ${padBest.i + 1} (${padBest.d.toFixed(0)} m)`;
        else {
          let anchorable = false;
          for (const a of Gp.world.asteroids) { if (vdist(sh.pos, a.pos) - a.radius < 30) { anchorable = true; break; } }
          if (anchorable) prompt = '[K] MAG-ANCHOR TO ROCK';
          else if (sh.gearDown) prompt = 'GEAR DOWN — descend gently to land';
        }
      }
    }
  } else if (pl.mode === 'eva') {
    if (vdist(pl.eva.pos, sh.pos) < 15) prompt = '[J]/[E] BOARD SHIP';
    else {
      const np = nearestPort(Gp, pl.eva.pos);
      if (np && np.d < 20) prompt = '[E] AIRLOCK DOCK — MATCH < 8 m/s';
      else if (np && np.d < 260) prompt = `AIRLOCK ${np.d.toFixed(0)} m — DRIFT TO THE @ MARKER · [J] BOARD SHIP`;
      else prompt = 'EVA · WASD+RF jets · SPACE fire · [J] board when close';
    }
  } else if (pl.mode === 'walk') {
    if ((sh.landedOn || sh.anchoredTo) && vdist(pl.foot.pos, sh.pos) < 12) prompt = '[E] BOARD SHIP';
    else {
      const surf = findSurface(Gp.world, pl.foot.pos);
      if (surf && surf.body.kind === 'asteroid' && surf.body.cave && vdist(pl.foot.pos, caveEntrance(surf.body)) < 6) prompt = `[E] ENTER CAVERN — ${surf.body.name}`;
      else if (surf && surf.body.kind === 'derelict' && surf.gap < 4) prompt = `[E] BOARD WRECK — ${surf.body.name}`;
      else prompt = '[M] MAG BOOTS · SPACE jump · [J] EVA';
    }
  } else if (pl.mode === 'interior') {
    const it = pl.interior;
    const ch = charAt(it.map, it.pos.x, it.pos.y);
    if (ch === 'A') prompt = '[E] AIRLOCK — EVA OUT';
  }
  Gp.prompt = prompt;
}

// ---------------------------------------------------------------- save / load
export function saveGame(silent = false) {
  if (!localStorageAvailable()) return;
  const sh = GpSafe().player.ship;
  const data = {
    v: 1,
    seed: GpSafe().world.seed,
    time: GpSafe().time, day: GpSafe().day,
    credits: sh.credits, fuel: sh.fuel, hull: sh.hull, shield: sh.shield,
    cargo: sh.cargo,
    stats: GpSafe().stats,
    settings: GpSafe().settings,
    scanned: GpSafe().stats.scanned,
    docked: sh.dockedTo ? { id: sh.dockedTo.id, portIdx: sh.dockedTo.portIdx } : null,
    mode: GpSafe().player.mode,
    pos: sh.pos, vel: sh.vel, quat: sh.quat,
    lastDock: GpSafe().lastDock,
    oreLeft: GpSafe().world.asteroids.map(a => a.oreLeft),
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    if (!silent) GpSafe().hud.log('GAME SAVED', '#b7ff7a');
  } catch (e) {
    if (!silent) GpSafe().hud.log('SAVE FAILED', '#ff6a5c');
  }
}
function localStorageAvailable() {
  try { return typeof localStorage !== 'undefined'; } catch (e) { return false; }
}
function GpSafe() { return G; }

export function loadGame() {
  if (!localStorageAvailable()) return false;
  let data = null;
  try { data = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return false; }
  if (!data || data.v !== 1) return false;
  return data;
}

export function applySave(data) {
  // world already built with same seed in main
  const sh = G.player.ship;
  sh.credits = data.credits; sh.fuel = data.fuel; sh.hull = data.hull; sh.shield = data.shield;
  sh.cargo = data.cargo || {};
  G.time = data.time; G.day = data.day;
  G.stats = Object.assign({ mined: 0, kills: 0, earned: 0, deaths: 0, dockedAt: {}, scanned: {} }, data.stats);
  G.settings = Object.assign(G.settings, data.settings);
  G.lastDock = data.lastDock || null;
  sh.pos = { ...data.pos }; sh.vel = { ...data.vel }; sh.quat = { ...data.quat };
  if (Array.isArray(data.oreLeft)) G.world.asteroids.forEach((a, i) => { if (data.oreLeft[i] != null) a.oreLeft = data.oreLeft[i]; });
  if (data.docked) {
    const st = G.world.stations.find(s => s.id === data.docked.id);
    if (st) {
      const port = st.ports[data.docked.portIdx] || st.ports[0];
      sh.dockedTo = {
        type: 'station', id: st.id, portIdx: data.docked.portIdx,
        localPos: qrot(qconj(st.quat), vsub(sh.pos, port.pos)),
        localQuat: qmul(qconj(st.quat), sh.quat),
      };
    }
  }
  G.cam.x = sh.pos.x; G.cam.y = sh.pos.y; G.cam.z = sh.pos.z;
  G.uiMode = 'play';
  G.hud.logEntries = [];
  G.hud.log('SAVE LOADED — welcome back, pilot', '#b7ff7a');
}

export function startFromTitle(Gp, isNew) {
  if (isNew || !loadGame()) {
    newGame(Gp.world.seed);
    Gp.hud.log('NEW FLIGHT STARTED', '#b7ff7a');
  } else {
    applySave(loadGame());
  }
}
