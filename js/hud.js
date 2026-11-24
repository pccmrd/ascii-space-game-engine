// hud.js — heads-up display, radar, interior tile views, menus.

import { clamp, lerp, bar, fmtInt, pad2 } from './core.js';
import { PAL } from './renderer.js';
import { charAt, surfaceVelocity } from './player.js';

const BOX = {
  tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│',
};
const PANEL_BG = 'rgba(3,8,14,0.80)';
const PANEL_BG_LIGHT = 'rgba(6,14,22,0.85)';

export class Hud {
  constructor() {
    this.logEntries = [];
    this.maxLog = 40;
  }

  log(text, color = '#9fb4c7') {
    this.logEntries.push({ text, color, t: performance.now() / 1000 });
    if (this.logEntries.length > this.maxLog) this.logEntries.shift();
  }

  panel(r, x, y, w, h, title, color = '#7af2ff', fillBg = true) {
    // fill bg
    if (fillBg) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) r.put(xx, yy, ' ', '#0a0f16', PANEL_BG);
    r.put(x, y, BOX.tl, color); r.put(x + w - 1, y, BOX.tr, color);
    r.put(x, y + h - 1, BOX.bl, color); r.put(x + w - 1, y + h - 1, BOX.br, color);
    for (let xx = x + 1; xx < x + w - 1; xx++) { r.put(xx, y, BOX.h, color); r.put(xx, y + h - 1, BOX.h, color); }
    for (let yy = y + 1; yy < y + h - 1; yy++) { r.put(x, yy, BOX.v, color); r.put(x + w - 1, yy, BOX.v, color); }
    if (title) r.text(x + 2, y, ` ${title} `, color);
  }

  drawHUD(Gp, r) {
    const pl = Gp.player;
    const W = Gp.world;
    const cols = r.cols, rows = r.rows;

    // ---------- top-left: location & clock ----------
    const locName = this.locationName(Gp);
    this.panel(r, 1, 1, 46, 6, 'KVELD SYSTEM');
    r.text(3, 2, `LOC  ${locName}`, PAL.info);
    r.text(3, 3, `CLK  ${pad2(Math.floor(Gp.time / 3600) % 24)}:${pad2(Math.floor(Gp.time / 60) % 60)}:${pad2(Math.floor(Gp.time) % 60)}  DAY ${Gp.day}${Gp.timeScale !== 1 ? `  ×${Gp.timeScale}` : ''}`, '#9fb4c7');
    const fuelPct = Math.round((pl.ship.fuel / 100) * 100);
    r.text(3, 4, `FUEL ${bar(pl.ship.fuel, 100, 12)} ${fuelPct}%`, pl.ship.fuel < 20 ? PAL.bad : '#9fb4c7');

    // ---------- radar ----------
    this.drawRadar(Gp, r, cols - 27, 1, 26, 13);

    // ---------- bottom-left: status ----------
    this.drawStatus(Gp, r, 1, rows - 10, 46, 9);

    // ---------- bottom-right: target ----------
    this.drawTarget(Gp, r, cols - 43, rows - 10, 42, 9);

    // ---------- log ----------
    const now = performance.now() / 1000;
    const recent = this.logEntries.slice(-5);
    for (let i = 0; i < recent.length; i++) {
      const e = recent[i];
      const age = now - e.t;
      if (age > 9) continue;
      const y = rows - 12 - (recent.length - 1 - i);
      const fadeCol = age > 6 ? '#5a6675' : e.color;
      r.text(cols / 2 - e.text.length / 2, y, e.text, fadeCol);
    }

    // ---------- station approach guide ----------
    this.drawGuide(Gp, r);

    // ---------- prompts ----------
    if (Gp.uiMode === 'play' && Gp.prompt) {
      const p = Gp.prompt;
      r.text(cols / 2 - p.length / 2, rows - 3, p, PAL.good);
    }

    // ---------- compass ----------
    this.drawCompass(Gp, r, cols / 2, 1, 40);

    // ---------- warnings ----------
    if (Gp.drones.some(d => !d.dead)) {
      if (Math.sin(performance.now() / 150) > 0) {
        r.text(cols / 2 - 22, 2, '! HOSTILE CONTACT — BELT SYNDICATE ACTIVE !', PAL.bad);
      }
    }
  }

  drawGuide(Gp, r) {
    if (Gp.player.mode !== 'ship') return;
    const sh = Gp.player.ship;
    if (sh.dockedTo || sh.landedOn || sh.anchoredTo) return;
    let best = null;
    for (const st of Gp.world.stations) {
      const d = Math.hypot(sh.pos.x - st.pos.x, sh.pos.y - st.pos.y, sh.pos.z - st.pos.z);
      if (d < 2400 && (!best || d < best.d)) best = { st, d };
    }
    if (!best) return;
    const st = best.st;
    let pd = 1e9, pi = 0;
    for (let i = 0; i < st.pads.length; i++) {
      const d = Math.hypot(sh.pos.x - st.pads[i].pos.x, sh.pos.y - st.pads[i].pos.y, sh.pos.z - st.pads[i].pos.z);
      if (d < pd) { pd = d; pi = i; }
    }
    let nd = 1e9, ni = 0;
    for (let i = 0; i < st.ports.length; i++) {
      const d = Math.hypot(sh.pos.x - st.ports[i].pos.x, sh.pos.y - st.ports[i].pos.y, sh.pos.z - st.ports[i].pos.z);
      if (d < nd) { nd = d; ni = i; }
    }
    const rel = Math.hypot(
      sh.vel.x - surfaceVelocity(st, sh.pos).x,
      sh.vel.y - surfaceVelocity(st, sh.pos).y,
      sh.vel.z - surfaceVelocity(st, sh.pos).z
    );
    const ready = nd < 26 && rel < 5;
    const fmt = (d) => (d < 999 ? d.toFixed(0) : '—');
    const txt = `${st.name} · D${ni + 1} ${fmt(nd)}m · P${pi + 1} ${fmt(pd)}m · REL ${rel.toFixed(1)}${ready ? ' · DOCK READY [E]' : ''}`;
    r.text(Math.max(1, Math.floor(r.cols / 2 - txt.length / 2)), 0, txt, ready ? PAL.good : PAL.info);
  }

  locationName(Gp) {
    const pl = Gp.player;
    if (pl.mode === 'interior') return pl.interior.map.name;
    if (pl.mode === 'walk' && pl.foot.body) return `${pl.foot.body.name || pl.foot.body.id || 'SURFACE'} — SURFACE`;
    const p = pl.mode === 'ship' ? pl.ship.pos : pl.eva.pos;
    let best = null, bd = 1e18;
    for (const s of Gp.world.stations) { const d = Math.hypot(p.x - s.pos.x, p.y - s.pos.y, p.z - s.pos.z); if (d < bd) { bd = d; best = s; } }
    if (bd < 900) return `${best.name} ORBITAL VICINITY`;
    const dm = Math.hypot(p.x, p.y, p.z);
    if (dm < Gp.world.moon.radius + 400) return 'KVELD LOW ORBIT';
    if (dm > 4000) return 'OUTER BELT';
    return 'INNER BELT';
  }

  drawStatus(Gp, r, x, y, w, h) {
    const pl = Gp.player;
    this.panel(r, x, y, w, h, 'SHIP / SUIT');
    const sh = pl.ship;
    if (pl.mode === 'ship') {
      const hullCol = sh.hull > 50 ? PAL.good : sh.hull > 25 ? PAL.ore : PAL.bad;
      r.text(x + 2, y + 1, `HULL  ${bar(sh.hull, sh.maxHull, 14)} ${Math.ceil(sh.hull)}`, hullCol);
      r.text(x + 2, y + 2, `SHLD  ${bar(sh.shield, sh.maxShield, 14)} ${Math.ceil(sh.shield)}`, PAL.info);
      const spd = Math.hypot(sh.vel.x, sh.vel.y, sh.vel.z);
      r.text(x + 2, y + 3, `VEL   ${spd.toFixed(1)} m/s`, '#cfd8ea');
      r.text(x + 2, y + 4, `MODE  ${sh.landedOn ? 'LANDED' : sh.dockedTo ? 'DOCKED' : sh.anchoredTo ? 'ANCHORED' : Gp.settings.dampeners ? 'FLIGHT+ASSIST' : 'NEWTONIAN'}`, '#cfd8ea');
      r.text(x + 2, y + 5, `FLAG  ${[sh.gearDown ? 'GEAR' : '', sh.dockedTo ? 'DOCK' : '', sh.anchoredTo ? 'ANCHOR' : '', Gp.settings.iso ? 'ISO' : 'TOP'].filter(Boolean).join(' · ') || '—'}`, '#8a94a2');
      const cargoN = Object.values(sh.cargo).reduce((a, b) => a + b, 0);
      r.text(x + 2, y + 6, `CARGO ${cargoN}/${sh.cargoCap}t   CR ${fmtInt(sh.credits)}`, cargoN >= sh.cargoCap ? PAL.ore : '#cfd8ea');
    } else if (pl.mode === 'eva') {
      r.text(x + 2, y + 1, `SUIT  ${bar(pl.ship.hull, pl.ship.maxHull, 14)} ${Math.ceil(pl.ship.hull)}`, PAL.good);
      r.text(x + 2, y + 2, `JET   ${bar(pl.eva.fuel, pl.eva.maxFuel, 14)} ${Math.ceil(pl.eva.fuel)}`, pl.eva.fuel < 12 ? PAL.bad : '#cfd8ea');
      const spd = Math.hypot(pl.eva.vel.x, pl.eva.vel.y, pl.eva.vel.z);
      r.text(x + 2, y + 3, `VEL   ${spd.toFixed(1)} m/s`, '#cfd8ea');
      r.text(x + 2, y + 4, `BOARD: [J] near ship`, '#8a94a2');
    } else if (pl.mode === 'walk') {
      r.text(x + 2, y + 1, `SUIT  ${bar(pl.ship.hull, pl.ship.maxHull, 14)} ${Math.ceil(pl.ship.hull)}`, PAL.good);
      r.text(x + 2, y + 2, `BODY  ${(pl.foot.body && (pl.foot.body.name || pl.foot.body.kind)) || 'DRIFT'}`, '#cfd8ea');
      r.text(x + 2, y + 3, `MAG   ${pl.foot.magboots ? 'ENGAGED [M]' : 'OFF [M]'}`, pl.foot.magboots ? PAL.info : PAL.ore);
      r.text(x + 2, y + 4, `GRAV  ${(pl.foot.body && pl.foot.body.mu ? (pl.foot.body.mu / Math.max(100, (() => { const d = Math.hypot(pl.foot.pos.x - pl.foot.body.pos.x, pl.foot.pos.y - pl.foot.body.pos.y, pl.foot.pos.z - pl.foot.body.pos.z); return d * d; })())) : 0).toFixed(2)} m/s²`, '#9fb4c7');
      r.text(x + 2, y + 5, `SHIP: [J] EVA   [E] board`, '#8a94a2');
    } else {
      r.text(x + 2, y + 1, `SUIT  ${bar(pl.ship.hull, pl.ship.maxHull, 14)} ${Math.ceil(pl.ship.hull)}`, PAL.good);
      r.text(x + 2, y + 2, `LOC   ${pl.interior.map.name}`, '#cfd8ea');
      r.text(x + 2, y + 3, `[E] use / interact`, '#8a94a2');
    }
  }

  drawTarget(Gp, r, x, y, w, h) {
    const t = Gp.target;
    this.panel(r, x, y, w, h, 'TARGET');
    if (!t) { r.text(x + 2, y + 1, '[TAB] acquire target', '#5a6675'); return; }
    const pl = Gp.player;
    const pPos = pl.mode === 'ship' ? pl.ship.pos : pl.mode === 'interior' ? null : pl.mode === 'eva' ? pl.eva.pos : pl.foot.pos;
    const tp = t.pos;
    const d = pPos ? Math.hypot(tp.x - pPos.x, tp.y - pPos.y, tp.z - pPos.z) : 0;
    const typeStr = t.scanned >= 1 ? (t.type || t.sub || t.comp ? this.compStr(t) : 'UNKNOWN') : 'UNSCANNED';
    r.text(x + 2, y + 1, `${t.name || t.id || '?'}`.slice(0, 38), PAL.ore);
    r.text(x + 2, y + 2, `${typeStr}`, '#9fb4c7');
    r.text(x + 2, y + 3, `DIST  ${d < 1000 ? d.toFixed(0) + ' m' : (d / 1000).toFixed(2) + ' km'}`, '#cfd8ea');
    if (pPos) {
      const rel = { x: tp.x - pPos.x, y: tp.y - pPos.y, z: tp.z - pPos.z };
      const vv = pl.mode === 'ship' ? pl.ship.vel : pl.mode === 'eva' ? pl.eva.vel : pl.foot.vel;
      const tvv = t.vel || { x: 0, y: 0, z: 0 };
      const cl = ((vv.x - tvv.x) * rel.x + (vv.y - tvv.y) * rel.y + (vv.z - tvv.z) * rel.z) / Math.max(d, 1);
      r.text(x + 2, y + 4, `CLOSURE ${cl >= 0 ? '+' : ''}${cl.toFixed(1)} m/s`, Math.abs(cl) > 30 ? PAL.ore : '#cfd8ea');
    }
    if (t.kind === 'asteroid') {
      const rSc = t.richness || 0;
      r.text(x + 2, y + 5, `ORE   ${bar(rSc, 1, 14)} ${Math.round(rSc * 100)}%`, PAL.ore);
    }
    const sc = t.scanned || 0;
    r.text(x + 2, y + 6, `SCAN  ${bar(sc, 1, 14)} ${Math.round(sc * 100)}%`, sc >= 1 ? PAL.good : PAL.info);
  }

  compStr(t) {
    if (!t.comp) return t.type || 'OBJECT';
    const parts = [];
    for (const k of ['metal', 'ice', 'rock', 'carbon']) if (t.comp[k] > 0.08) parts.push(`${k.toUpperCase().slice(0, 3)} ${Math.round(t.comp[k] * 100)}`);
    return parts.join(' ');
  }

  drawRadar(Gp, r, x, y, w, h) {
    this.panel(r, x, y, w, h, 'RADAR');
    const pl = Gp.player;
    const p = pl.mode === 'ship' ? pl.ship.pos : pl.mode === 'interior' ? null : pl.mode === 'eva' ? pl.eva.pos : pl.foot.pos;
    if (!p) return;
    const range = 6000;
    const cx = x + Math.floor(w / 2), cy = y + Math.floor(h / 2);
    const plot = (wp, ch, col) => {
      const dx = wp.x - p.x, dy = wp.y - p.y;
      const rx = cx + (dx / range) * (w / 2 - 2);
      const ry = cy + (dy / range) * (h / 2 - 2);
      if (rx < x + 1 || ry < y + 1 || rx > x + w - 2 || ry > y + h - 2) return;
      r.put(rx, ry, ch, col);
    };
    // moon (huge): draw scaled ring
    const md = Math.hypot(Gp.world.moon.pos.x - p.x, Gp.world.moon.pos.y - p.y);
    if (md - Gp.world.moon.radius < range) {
      const rr = (Gp.world.moon.radius / range) * (w / 2 - 2);
      for (let a = 0; a < Math.PI * 2; a += 0.25) {
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.5;
        if (px >= x + 1 && py >= y + 1 && px <= x + w - 2 && py <= y + h - 2) r.put(px, py, '.', '#7c8ea3');
      }
    }
    for (const a of Gp.world.asteroids) {
      if (Math.hypot(a.pos.x - p.x, a.pos.y - p.y) > 2500) continue;
      plot(a.pos, a.metal ? ':' : '.', a.cave ? '#9fd8e8' : '#4a5260');
    }
    for (const s of Gp.world.stations) plot(s.pos, 'S', s.color);
    for (const dr of Gp.world.derelicts) plot(dr.pos, 'x', '#8d99a6');
    for (const dr of Gp.drones) if (!dr.dead) plot(dr.pos, 'X', PAL.drone);
    if (Gp.world.comet) plot(Gp.world.comet.pos, '*', '#9fd8e8');
    if (Gp.target) plot(Gp.target.pos, 'T', PAL.ore);
    r.put(cx, cy, '@', PAL.ship);
    r.text(cx - 1, y + 1, 'N', '#5a6675');
  }

  drawCompass(Gp, r, cx, y, w) {
    // bearing strip based on camera forward projected on xy plane
    const f = Gp.cam.fwd || { x: 0, y: -1 };
    const ang = Math.atan2(f.y, f.x);
    const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
    const idx = Math.round(((ang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    let lineStr = '';
    for (let i = -3; i <= 3; i++) {
      const d = dirs[(idx + i + 16) % 8];
      lineStr += i === 0 ? `[${d}]` : ` ${d} `;
    }
    r.text(cx - lineStr.length / 2, y, lineStr, '#5a6675');
    // ship nose bearing marker
    if (Gp.player && Gp.player.mode === 'ship') {
      const q = Gp.player.ship.quat;
      // forward vector = q * (1,0,0)
      const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
      const fy = 2 * (q.x * q.y + q.w * q.z);
      const fz = 2 * (q.x * q.z - q.w * q.y);
      let sx, sy;
      if (Gp.cam.mode === 'iso') { sx = (fx - fy) * 0.7071; sy = (fx + fy) * 0.5 - fz; }
      else { sx = fx; sy = fy; }
      const sang = Math.atan2(sy, sx);
      const idx = Math.round(((sang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
      const noseDirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
      r.text(cx - lineStr.length / 2 + lineStr.length + 1, y, `▲${noseDirs[idx]}`, PAL.ore);
    }
  }

  // ---------------- interiors ----------------
  drawInterior(Gp, r, dt) {
    const it = Gp.player.interior;
    const map = it.map;
    const cols = r.cols, rows = r.rows;
    // backdrop
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) r.put(x, y, ' ', '#10141c', '#05070b');
    const viewW = Math.min(cols - 4, 96, map.w), viewH = Math.min(rows - 6, 40, map.h);
    const ox = Math.floor(cols / 2 - viewW / 2);
    const oy = Math.floor(rows / 2 - viewH / 2);
    const camX = clamp(it.pos.x - viewW / 2, 0, Math.max(0, map.w - viewW));
    const camY = clamp(it.pos.y - viewH / 2, 0, Math.max(0, map.h - viewH));
    for (let vy = 0; vy < viewH; vy++) {
      for (let vx = 0; vx < viewW; vx++) {
        const mx = Math.floor(camX) + vx, my = Math.floor(camY) + vy;
        const ch = charAt(map, mx, my);
        const sx = ox + (mx - camX), sy = oy + (vy);
        this.drawTile(Gp, r, ch, sx, sy, mx, my);
      }
    }
    // player
    const psx = ox + (it.pos.x - camX), psy = oy + (it.pos.y - camY);
    const bob = Math.abs((it.walkPhase || 0) % 2) > 1 ? 0.4 : 0;
    r.put(psx, psy + bob, '@', PAL.eva);
    // frame (border only — must not erase the map under it)
    this.panel(r, ox - 2, oy - 2, viewW + 4, viewH + 4, map.name, '#7af2ff', false);
    // hint line
    const hint = this.interiorHint(Gp);
    if (hint) r.textCenter(rows - 4, hint, PAL.good);
  }

  drawTile(Gp, r, ch, sx, sy, mx, my) {
    switch (ch) {
      case '#': {
        // wall with fake depth: brighter if floor below
        const open = charAt(Gp.player.interior.map, mx, my + 1) !== '#' || charAt(Gp.player.interior.map, mx + 1, my) !== '#' || charAt(Gp.player.interior.map, mx - 1, my) !== '#';
        r.put(sx, sy, open ? '#' : '█', open ? '#5a6675' : '#2c3644');
        break;
      }
      case '.': r.put(sx, sy, '·', '#28303c'); break;
      case '+': r.put(sx, sy, '+', PAL.ore); break;
      case 'A': r.put(sx, sy, 'A', PAL.good); break;
      case 'D': r.put(sx, sy, 'D', PAL.info); break;
      case 'T': r.put(sx, sy, 'T', PAL.ore); break;
      case 'F': r.put(sx, sy, 'F', PAL.planetC); break;
      case 'R': r.put(sx, sy, 'R', PAL.info); break;
      case 'c': r.put(sx, sy, 'c', PAL.ore); break;
      case 'O': r.put(sx, sy, 'O', '#9fd8e8'); break;
      case 'X': r.put(sx, sy, 'X', '#d59aff'); break;
      default: r.put(sx, sy, ' ', '#10141c');
    }
  }

  interiorHint(Gp) {
    const it = Gp.player.interior;
    const ch = charAt(it.map, it.pos.x, it.pos.y);
    if (ch === 'A') return '[E] AIRLOCK — EVA OUT';
    if (ch === 'T') return '[E] MARKET TERMINAL';
    if (ch === 'F') return '[E] REFUEL — 2 CR / UNIT';
    if (ch === 'R') return '[E] REPAIR — 3 CR / HULL PT';
    return null;
  }

  // ---------------- menus ----------------
  drawTitle(Gp, r) {
    const cols = r.cols, rows = r.rows;
    const art = [
      ' ███████╗████████╗ █████╗ ██████╗ ███████╗ █████╗ ██████╗ ███████╗██████╗ ',
      ' ██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝██╔══██╗',
      ' ███████╗   ██║   ███████║██████╔╝█████╗  ███████║██████╔╝█████╗  ██████╔╝',
      ' ╚════██║   ██║   ██╔══██║██╔══██╗██╔══╝  ██╔══██║██╔══██╗██╔══╝  ██╔══██╗',
      ' ███████║   ██║   ██║  ██║██║  ██║██║     ██║  ██║██║  ██║███████╗██║  ██║',
      ' ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝',
    ];
    const cx = Math.floor(cols / 2 - art[0].length / 2);
    const cy = Math.floor(rows / 2 - 9);
    for (let i = 0; i < art.length; i++) r.text(cx, cy + i, art[i], '#59f7c2');
    r.textCenter(cy + 7, 'N E W T O N I A N   A S C I I   4 X   E N G I N E', '#9fb4c7');
    const hasSave = typeof localStorage !== 'undefined' && !!localStorage.getItem('starfarer.save.v1');
    if (hasSave) {
      r.textCenter(cy + 10, '[ENTER] CONTINUE FLIGHT', PAL.good);
      r.textCenter(cy + 11, '[N] NEW GAME', PAL.info);
    } else {
      r.textCenter(cy + 10, '[ENTER] LAUNCH', PAL.good);
    }
    r.textCenter(rows - 3, 'KVELD SYSTEM · ONE MOON · FIVE STATIONS · A BELT THAT KILLS', '#5a6675');
  }

  drawHelp(Gp, r) {
    const w = Math.min(86, r.cols - 6), h = Math.min(40, r.rows - 6);
    const x = Math.floor(r.cols / 2 - w / 2), y = Math.floor(r.rows / 2 - h / 2);
    this.panel(r, x, y, w, h, 'FLIGHT MANUAL', '#59f7c2');
    const L = [
      ['FLIGHT (SHIP)', PAL.info],
      ['  W/S  main / retro thrust      R/F  vertical thrust       A/D  lateral', '#9fb4c7'],
      ['  ARROWS  pitch & yaw            ,/.  roll                  SHIFT boost', '#9fb4c7'],
      ['  X  brake                      G  flight assist on/off (Newtonian drift)', '#9fb4c7'],
      ['  SPACE / CLICK  lasers         TAB  target · V (hold) scan · C  mining beam', '#9fb4c7'],
      ['  L  landing gear (land soft < 3.5 m/s)   K  mag-anchor   T  180° flip', '#9fb4c7'],
      ['EVA & SURFACE', PAL.info],
      ['  J  exit ship / board          WASD + R/F  jet thrust     M  magnetic boots', '#9fb4c7'],
      ['  SPACE  jump (on foot)          CLICK / C  hand laser / mining tool', '#9fb4c7'],
      ['DOCKING · BOARDING · INTERIORS', PAL.info],
      ['  E  dock at @ port (<26 m, <5 m/s) · land on amber H PAD (L gear, <8 m/s)', '#9fb4c7'],
      ['     enter station · loot · airlock      EVA: E at a collar cycles you in on foot', '#9fb4c7'],
      ['  U  undock / save game          H  this manual            ESC/P  pause', '#9fb4c7'],
      ['VIEW & TIME', PAL.info],
      ['  Z  isometric / top-down        + / −  zoom               1/2/3  time ×0.25/×1/×4', '#9fb4c7'],
      ['  N  mute audio                  B  emergency tug (fuel < 5%, 50 cr)', '#9fb4c7'],
      ['', '#9fb4c7'],
      ['LOOP: scan the belt [V] → mine ore [C] → haul to KOLVIK / HREGG\'S GATE → get paid.', '#b7ff7a'],
      ['Rich rocks attract RED JACKAL patrols. Mag-anchor, EVA out, crack the cave open.', '#7af2ff'],
    ];
    for (let i = 0; i < L.length; i++) r.text(x + 3, y + 1 + i, L[i][0], L[i][1]);
    r.textCenter(y + h - 2, '[H]/[ESC] close', PAL.good);
  }

  drawPause(Gp, r) {
    const w = 40, h = 12;
    const x = Math.floor(r.cols / 2 - w / 2), y = Math.floor(r.rows / 2 - h / 2);
    this.panel(r, x, y, w, h, 'PAUSED', '#ffd27a');
    r.textCenter(y + 3, '[P]/[ESC] resume', '#cfd8ea');
    r.textCenter(y + 4, '[K] save game', '#cfd8ea');
    r.textCenter(y + 5, '[N] toggle sound', '#cfd8ea');
    r.textCenter(y + 6, '[Q] quit to title', '#ff9d5c');
  }

  drawDead(Gp, r) {
    const w = 56, h = 12;
    const x = Math.floor(r.cols / 2 - w / 2), y = Math.floor(r.rows / 2 - h / 2);
    this.panel(r, x, y, w, h, 'SIGNAL LOST', '#ff6a5c');
    r.textCenter(y + 3, 'Your escape pod ejects at the last second…', '#cfd8ea');
    r.textCenter(y + 5, Gp.deathInfo ? Gp.deathInfo : '', '#9fb4c7');
    r.textCenter(y + 7, '[ENTER] insurance reboot (−15% credits)', PAL.good);
  }

  drawMarket(Gp, r) {
    const mk = Gp.market;
    const st = mk.station;
    const w = Math.min(78, r.cols - 6), h = Math.min(34, r.rows - 6);
    const x = Math.floor(r.cols / 2 - w / 2), y = Math.floor(r.rows / 2 - h / 2);
    this.panel(r, x, y, w, h, `MARKET — ${st.name}`, '#ffd27a');
    const sh = Gp.player.ship;
    let row = 1;
    r.text(x + 3, y + row++, `CREDITS ${fmtInt(sh.credits)} CR`, PAL.ore);
    r.text(x + 3, y + row++, `CARGO ${Object.values(sh.cargo).reduce((a, b) => a + b, 0)}/${sh.cargoCap} t`, '#cfd8ea');
    row++;
    r.text(x + 3, y + row, 'ORE', PAL.info);
    r.text(x + 16, y + row, 'HELD', PAL.info);
    r.text(x + 26, y + row, 'PRICE', PAL.info);
    r.text(x + 38, y + row, 'VALUE', PAL.info);
    row++;
    const prices = Gp.market.prices;
    let any = false;
    for (const kind of ['metal', 'ice', 'rock', 'carbon']) {
      const held = sh.cargo[kind] || 0;
      const price = prices[kind];
      if (held > 0) any = true;
      r.text(x + 3, y + row, `  ${kind.toUpperCase().slice(0, 6)}`, held > 0 ? '#cfd8ea' : '#4a5260');
      r.text(x + 16, y + row, `${held} t`, held > 0 ? '#cfd8ea' : '#4a5260');
      r.text(x + 26, y + row, `${price} cr`, '#9fb4c7');
      r.text(x + 38, y + row, `${held * price} cr`, held > 0 ? PAL.ore : '#4a5260');
      row++;
    }
    if (!any && mk.kind === 'market') r.text(x + 3, y + row++, '( hold is empty — go mine something )', '#5a6675');
    row++;
    if (mk.kind === 'market') {
      const total = Object.keys(sh.cargo).reduce((a, k) => a + (sh.cargo[k] || 0) * mk.prices[k], 0);
      r.text(x + 3, y + row++, `[1] SELL ALL CARGO — +${fmtInt(total)} CR`, PAL.good);
    }
    if (mk.kind === 'fuel') r.text(x + 3, y + row++, `[1] REFUEL TO FULL — ${Math.ceil((100 - sh.fuel) * 2)} CR`, PAL.planetC);
    if (mk.kind === 'repair') r.text(x + 3, y + row++, `[1] REPAIR HULL — ${Math.ceil((sh.maxHull - sh.hull) * 3)} CR`, PAL.planetC);
    if (st.roles.includes('refinery') && mk.kind === 'market') r.text(x + 3, y + row++, '  (refinery bonus: +15% ore prices)', '#5a6675');
    r.text(x + 3, y + row + 1, '[E]/[ESC] leave terminal', '#8a94a2');
  }
}
