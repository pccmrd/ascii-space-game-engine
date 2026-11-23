// renderer.js — layered ASCII renderer: cell buffer -> canvas, with isometric and
// top-down projections, shaded celestial discs, wireframe stations, terrain grids.

import { v3, vadd, vsub, vscale, vlen, vdist, vnorm, vdot, vcross, clamp, lerp, TAU } from './core.js';
import { findSurface } from './physics.js';

export const PAL = {
  bg: '#04060c',
  starDim: '#3a4356', starMid: '#6b7a94', starBright: '#cfd8ea',
  moonLo: '#2c3644', moonHi: '#aebfd2', moonRim: '#e8f1fb',
  planetA: '#c98d4e', planetB: '#8a5a34', planetC: '#e8c088',
  astRock: '#8d8272', astMetal: '#c9b08a', astIce: '#9fd8e8', astCarbon: '#6a6f7a',
  ship: '#b7ff7a', eva: '#ffe08a', drone: '#ff6a5c',
  laser: '#ffe08a', enemyLaser: '#ff6a5c',
  stationNode: '#e8f1fb', ore: '#ffd27a', good: '#b7ff7a', bad: '#ff6a5c', info: '#7af2ff',
};

const COS30 = 0.8660254;
const SIN30 = 0.5;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fontSize = 15;
    this.font = `${this.fontSize}px "JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace`;
    this.cellW = 8; this.cellH = 16;
    this.cols = 0; this.rows = 0;
    this.ch = []; this.fg = []; this.bg = [];
    this.stars = [];
    this.nebulae = [];
    this.bgCanvas = null;
    this.time = 0;
    this.resize();
  }

  resize() {
    const c = this.canvas;
    c.width = Math.floor(window.innerWidth);
    c.height = Math.floor(window.innerHeight);
    this.ctx.font = this.font;
    const m = this.ctx.measureText('MMMMMMMMMM');
    this.cellW = Math.max(4, m.width / 10);
    this.cellH = Math.round(this.fontSize * 1.06);
    this.cols = Math.min(240, Math.ceil(c.width / this.cellW) + 1);
    this.rows = Math.min(110, Math.ceil(c.height / this.cellH) + 1);
    const n = this.cols * this.rows;
    this.ch = new Array(n); this.fg = new Array(n); this.bg = new Array(n);
    this.buildSky();
  }

  buildSky() {
    // nebula blobs (static, drawn once to offscreen)
    this.bgCanvas = document.createElement('canvas');
    this.bgCanvas.width = Math.max(2, Math.floor(this.canvas.width / 2));
    this.bgCanvas.height = Math.max(2, Math.floor(this.canvas.height / 2));
    const bctx = this.bgCanvas.getContext('2d');
    bctx.fillStyle = '#04060c';
    bctx.fillRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
    const rngColors = [
      [30, 20, 60], [16, 34, 58], [48, 18, 44], [12, 44, 52], [40, 28, 20],
    ];
    let seed = 12345;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 9; i++) {
      const x = rnd() * this.bgCanvas.width, y = rnd() * this.bgCanvas.height;
      const r = (0.12 + rnd() * 0.25) * this.bgCanvas.width;
      const col = rngColors[i % rngColors.length];
      const g = bctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},0.35)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      bctx.fillStyle = g;
      bctx.beginPath(); bctx.arc(x, y, r, 0, TAU); bctx.fill();
    }
    // stars: three parallax layers in normalized coords
    this.stars = [];
    for (let i = 0; i < 420; i++) {
      const layer = rnd();
      this.stars.push({
        x: rnd(), y: rnd(),
        layer,
        ch: layer > 0.92 ? '*' : layer > 0.7 ? '\'' : '.',
        tw: rnd() * TAU,
      });
    }
  }

  begin() {
    const n = this.cols * this.rows;
    for (let i = 0; i < n; i++) { this.ch[i] = ' '; this.fg[i] = PAL.starDim; this.bg[i] = null; }
  }

  put(cx, cy, ch, fg, bg = null) {
    const x = Math.round(cx), y = Math.round(cy);
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    const i = y * this.cols + x;
    this.ch[i] = ch; this.fg[i] = fg; this.bg[i] = bg;
  }

  text(cx, cy, str, fg, bg = null) {
    for (let i = 0; i < str.length; i++) this.put(cx + i, cy, str[i], fg, bg);
  }

  textCenter(cy, str, fg, bg = null) {
    this.text(Math.floor(this.cols / 2 - str.length / 2), cy, str, fg, bg);
  }

  // DDA line in cell space
  line(x0, y0, x1, y1, ch, fg, bg = null) {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.put(x0 + dx * t, y0 + dy * t, ch, fg, bg);
    }
  }

  flush(ctxTime) {
    const ctx = this.ctx;
    const cw = this.cellW, chh = this.cellH;
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // background nebula image (slight parallax)
    if (this.bgCanvas) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.bgCanvas, -20, -10, this.canvas.width + 40, this.canvas.height + 20);
      ctx.globalAlpha = 1;
    }
    ctx.font = this.font;
    ctx.textBaseline = 'top';
    const cols = this.cols, rows = this.rows;
    for (let y = 0; y < rows; y++) {
      let x = 0;
      while (x < cols) {
        const i = y * cols + x;
        const fg = this.fg[i];
        const bg = this.bg[i];
        let j = x + 1;
        let str = this.ch[i];
        if (str === ' ') { x++; continue; }
        while (j < cols) {
          const k = y * cols + j;
          if (this.fg[k] !== fg || this.bg[k] !== bg || this.ch[k] === ' ') break;
          str += this.ch[k]; j++;
        }
        if (bg) { ctx.fillStyle = bg; ctx.fillRect(x * cw, y * chh, str.length * cw, chh); }
        ctx.fillStyle = fg;
        ctx.fillText(str, x * cw, y * chh);
        x = j;
      }
    }
  }

  // ---------------- projection ----------------
  // cam: {x,y,z, mode, zoom}; returns {cx, cy, depth, s} (cell coords) or null if behind
  project(p, cam) {
    const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
    const S = this.baseScale(cam);
    let fx, fy, depth;
    if (cam.mode === 'iso') {
      fx = (dx - dy) * COS30 * S;
      fy = ((dx + dy) * SIN30 - dz) * S * this.isoY;
      depth = (dx + dy) * SIN30 - dz;
    } else {
      fx = dx * S;
      fy = dy * S;
      depth = dz;
    }
    return {
      cx: this.cols / 2 + fx / this.cellW,
      cy: this.rows / 2 + fy / this.cellH,
      depth,
      s: S,
    };
  }

  baseScale(cam) {
    // px per meter
    return cam.zoom * this.cellH * 0.42;
  }
  get isoY() {
    // aspect compensation so cubes look cubic on tall cells
    return (2 * this.cellW) / this.cellH;
  }

  // ---------------- scene ----------------
  drawScene(Gp, dt) {
    this.time += dt;
    const cam = Gp.cam;
    // parallax camera drift for starfield
    const px = (cam.x * 0.02 * (cam.mode === 'iso' ? 0.5 : 1)) % 1;
    const py = (cam.y * 0.02 * (cam.mode === 'iso' ? 0.5 : 1)) % 1;
    for (const st of this.stars) {
      const par = 0.15 + st.layer * 0.6;
      let sx = (st.x - px * par) % 1; if (sx < 0) sx += 1;
      let sy = (st.y - py * par) % 1; if (sy < 0) sy += 1;
      const tw = 0.55 + 0.45 * Math.sin(this.time * (0.5 + st.layer) + st.tw);
      const col = st.layer > 0.92 ? PAL.starBright : st.layer > 0.6 ? PAL.starMid : PAL.starDim;
      this.put(sx * this.cols, sy * this.rows, st.ch, col);
    }

    const W = Gp.world;
    const pl = Gp.player;
    const pPos = pl.mode === 'ship' ? pl.ship.pos : pl.mode === 'interior' ? v3(pl.interior.pos.x, 0, pl.interior.pos.y) : pl.mode === 'eva' ? pl.eva.pos : pl.foot.pos;

    // camera target: smooth follow
    const k = 1 - Math.pow(0.001, dt);
    cam.x = lerp(cam.x, pPos.x, k);
    cam.y = lerp(cam.y, pPos.y, k);
    cam.z = lerp(cam.z, pPos.z, k);

    // ---- celestial bodies ----
    this.drawPlanet(W.planet, cam);
    this.drawMoon(W.moon, cam);
    if (W.comet && W.comet.distMoon < 14000) this.drawComet(W.comet, cam);

    // ---- terrain first: it sits under everything else ----
    const surf0 = findSurface(W, pPos);
    if (surf0 && surf0.gap < 420 && pl.mode !== 'interior') {
      this.drawTerrain(surf0.body, cam, Gp, clamp(surf0.gap, 8, 400));
    }

    // ---- stations ----
    for (const st of W.stations) this.drawStation(st, cam, Gp);
    for (const d of W.derelicts) this.drawDerelict(d, cam, Gp);
    for (const a of W.asteroids) this.drawAsteroid(a, cam, Gp);

    // ---- entities ----
    this.drawPickups(Gp, cam);
    this.drawProjectiles(Gp, cam);
    this.drawParticles(Gp, cam);
    if (Gp.drones.length) for (const dr of Gp.drones) this.drawDrone(dr, cam);

    // ---- player ----
    if (pl.mode === 'ship') this.drawShip(pl.ship, cam, Gp);
    else if (pl.mode === 'eva') this.drawEVA(pl.eva, cam);
    else if (pl.mode === 'walk') this.drawFoot(pl.foot, cam);


    // target reticle & offscreen guides
    if (Gp.target) this.drawReticle(Gp.target, cam, Gp);
  }

  // ---------------- bodies ----------------
  shadeDisc(centerCell, rCells, lightDir, colFn, noiseSeed) {
    // filled shaded disc; colFn(nx, ny, nz) -> color; nx,ny unit disc coords
    for (let oy = -Math.ceil(rCells); oy <= Math.ceil(rCells); oy++) {
      for (let ox = -Math.ceil(rCells); ox <= Math.ceil(rCells); ox++) {
        const d = Math.sqrt(ox * ox + oy * oy);
        if (d > rCells) continue;
        const nx = ox / rCells, ny = oy / rCells;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        // light on the sphere surface: normal has z from viewer
        const L = clamp(nx * lightDir.x + ny * lightDir.y + nz * lightDir.z, 0, 1);
        const n = this.hashCell(noiseSeed + ox, oy);
        this.put(centerCell.cx + ox, centerCell.cy + oy, n > 0.86 ? 'o' : (L > 0.75 ? '*' : L > 0.5 ? '+' : L > 0.3 ? '.' : ' '),
          colFn(L, n), null);
      }
    }
  }
  hashCell(a, b) {
    let h = (a * 374761393 + b * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  drawMoon(moon, cam) {
    const pr = this.project(moon.pos, cam);
    if (!pr) return;
    const rCells = (moon.radius * pr.s) / this.cellW;
    if (rCells < 1.2) {
      this.put(pr.cx, pr.cy, '@', PAL.moonHi);
      return;
    }
    const light = vnorm(v3(0.6, -0.35, 0.72));
    if (rCells <= 60) {
      this.shadeDisc(pr, rCells, light, (L, n) => {
        const maria = this.hashCell(Math.floor(pr.cx / 7), Math.floor(pr.cy / 7)) > 0.72;
        if (L < 0.12) return '#141a24';
        if (maria) return L > 0.6 ? '#7c8ea3' : '#5c6c80';
        return L > 0.8 ? PAL.moonRim : L > 0.55 ? PAL.moonHi : L > 0.3 ? '#7c8ea3' : '#3c4858';
      }, 9182);
    } else {
      // enormous: paint only the lit limb band
      this.drawMoonLimb(moon, cam, pr, rCells);
    }
    if (rCells > 6 && rCells <= 60) this.put(pr.cx, pr.cy - rCells - 1, 'KVELD', PAL.moonHi);
  }

  drawMoonLimb(moon, cam, pr, rCells) {
    // huge body: draw only its visible edge arc, plus faint fill tint near it
    const cx = clamp(pr.cx, -rCells, this.cols + rCells);
    const cy = clamp(pr.cy, -rCells, this.rows + rCells);
    for (let row = 0; row < this.rows; row++) {
      const dy = row - cy;
      if (Math.abs(dy) > rCells) continue;
      const half = Math.sqrt(Math.max(0, rCells * rCells - dy * dy));
      // leading edge column (screen-left side of disc)
      const edge = cx - half;
      const col = Math.round(edge);
      if (col >= 0 && col < this.cols) this.put(col, row, ':', '#5c6c80');
      if (col + 1 >= 0 && col + 1 < this.cols) this.put(col + 1, row, '.', '#3c4858');
    }
  }

  drawPlanet(pl, cam) {
    const pr = this.project(pl.pos, cam);
    if (!pr) return;
    const rCells = (pl.radius * pr.s) / this.cellW;
    if (rCells < 1.5) { this.put(pr.cx, pr.cy, 'O', PAL.planetC); return; }
    const r = Math.min(rCells, 46);
    const light = vnorm(v3(0.6, -0.3, 0.74));
    // rings behind: draw ellipse arcs first
    if (pl.rings && rCells > 4) {
      for (let a = 0; a < TAU; a += 0.08) {
        const rx = Math.cos(a) * r * 1.8, ry = Math.sin(a) * r * 0.42;
        this.put(pr.cx + rx, pr.cy + ry, '.', '#7a6a52');
      }
    }
    this.shadeDisc(pr, r, light, (L, n) => {
      const band = Math.sin((n * 12) + pr.cy * 0.02) * 0.5 + 0.5;
      if (L < 0.15) return '#241812';
      if (band > 0.66) return L > 0.5 ? PAL.planetC : PAL.planetA;
      return L > 0.5 ? PAL.planetA : PAL.planetB;
    }, 5150);
    if (rCells > 6) this.put(pr.cx, pr.cy - r - 2, 'VETR', PAL.planetC);
  }

  drawComet(c, cam) {
    const pr = this.project(c.pos, cam);
    if (!pr) return;
    const r = clamp((c.radius * pr.s) / this.cellW, 1, 5);
    this.shadeDisc(pr, r, vnorm(v3(0.6, -0.35, 0.72)), (L) => L > 0.6 ? '#dffaff' : L > 0.3 ? '#9fd8e8' : '#4a7a8a', 77);
    // tail away from sun (sun dir constant): tail opposite light dir projected
    const tail = vscale(vnorm(v3(0.6, -0.35, 0.72)), -1);
    const tp = this.project(vadd(c.pos, vscale(tail, c.radius * 8)), cam);
    if (tp) {
      const steps = Math.ceil(Math.abs(tp.cx - pr.cx) + Math.abs(tp.cy - pr.cy));
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        this.put(lerp(pr.cx, tp.cx, t), lerp(pr.cy, tp.cy, t), t > 0.6 ? '.' : ':', t > 0.4 ? '#9fd8e8' : '#4a7a8a');
      }
    }
  }

  // ---------------- asteroids ----------------
  drawAsteroid(a, cam, Gp) {
    // cheap off-screen reject before any real work
    {
      const S = this.baseScale(cam);
      const bound = Math.max(this.cols * this.cellW, this.rows * this.cellH) / S + a.radius * 2 + 20;
      const ddx = a.pos.x - cam.x, ddy = a.pos.y - cam.y, ddz = a.pos.z - cam.z;
      if (ddx * ddx + ddy * ddy + ddz * ddz > bound * bound) return;
    }
    const pr = this.project(a.pos, cam);
    if (!pr) return;
    const rM = a.radius;
    const rCells = (rM * pr.s) / this.cellW;
    if (rCells < 0.35) { this.put(pr.cx, pr.cy, '.', '#5a5a52'); return; }
    if (rCells > 90) return; // too close/huge; terrain handles it

    // rotate verts by spin
    const rotQ = qaxisLocal(a.spinAxis, a.spinAngle);
    const pts = a.verts.map(v => {
      const w = qrotLocal(rotQ, v3(v.x, v.y, 0));
      return this.project(vadd(a.pos, w), cam);
    }).filter(Boolean);

    if (rCells <= 2.2) {
      // tiny: single glyph
      const ch = rCells > 1.2 ? 'o' : '.';
      this.put(pr.cx, pr.cy, ch, a.metal ? PAL.astMetal : a.comp.ice > 0.4 ? PAL.astIce : PAL.astRock);
      return;
    }

    // outline
    const colBase = a.comp.ice > 0.4 ? PAL.astIce : a.metal ? PAL.astMetal : a.comp.carbon > 0.3 ? PAL.astCarbon : PAL.astRock;
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
      const steps = Math.ceil(Math.max(Math.abs(p1.cx - p0.cx), Math.abs(p1.cy - p0.cy))) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        this.put(lerp(p0.cx, p1.cx, t), lerp(p0.cy, p1.cy, t), '#', colBase);
      }
    }
    // interior speckle via bounding box + point-in-polygon (coarse)
    const xs = pts.map(p => p.cx), ys = pts.map(p => p.cy);
    const minX = Math.floor(Math.min(...xs)), maxX = Math.ceil(Math.max(...xs));
    const minY = Math.floor(Math.min(...ys)), maxY = Math.ceil(Math.max(...ys));
    if (maxX - minX > 60 || maxY - minY > 60) return;
    const scannedRich = a.scanned >= 1 && a.richness > 0.55;
    const stride = Math.max(1, Math.round(rCells / 9));
    for (let yy = minY; yy <= maxY; yy += stride) {
      for (let xx = minX; xx <= maxX; xx += stride) {
        if (!this.pointInPoly(xx, yy, pts)) continue;
        const h = this.hashCell(xx * 3 + a.seed, yy * 5);
        if (h > 0.55) continue; // sparse
        let ch = h > 0.4 ? '+' : h > 0.28 ? '.' : ':';
        let col = colBase;
        if (scannedRich && h > 0.5 && Math.sin(this.time * 3 + h * 20) > 0.55) { ch = '*'; col = PAL.ore; }
        if (a.comp.ice > 0.4) col = h > 0.35 ? '#cfeeff' : colBase;
        this.put(xx, yy, ch, col);
      }
    }
  }
  pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].cx, yi = pts[i].cy, xj = pts[j].cx, yj = pts[j].cy;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // ---------------- stations ----------------
  drawStation(st, cam, Gp) {
    const pr = this.project(st.pos, cam);
    if (!pr) return;
    const rCells = (st.size * pr.s) / this.cellW;
    if (rCells < 0.4) { this.put(pr.cx, pr.cy, '+', st.color); return; }
    // transform nodes
    const pts = st.mesh.nodes.map(n => this.project(vadd(st.pos, qrotLocal(st.quat, n)), cam)).filter(Boolean);
    const dim = rCells < 3;
    for (const [i, j] of st.mesh.edges) {
      if (!pts[i] || !pts[j]) continue;
      const d = (pts[i].depth + pts[j].depth) / 2;
      const ch = dim ? '.' : (d > 0 ? '#' : ':');
      const col = this.shadeEdge(st.color, d);
      this.line(pts[i].cx, pts[i].cy, pts[j].cx, pts[j].cy, ch, col);
    }
    for (const p of pts) if (dim) this.put(p.cx, p.cy, '.', st.color);
    // nodes
    if (!dim) for (const p of pts) this.put(p.cx, p.cy, '@', '#e8f1fb');
    // ports: blinking markers
    for (let i = 0; i < st.ports.length; i++) {
      const port = st.ports[i];
      const pp = this.project(port.pos, cam);
      if (!pp) continue;
      const blink = Math.sin(this.time * 4 + i * 2) > 0;
      this.put(pp.cx, pp.cy, blink ? '◊' : 'x', blink ? PAL.good : '#5a7a5a');
      // docking approach corridor hint
      if (Gp.target && Gp.target.kind === 'station' && Gp.target.id === st.id) {
        const sp = this.project(Gp.player.ship.pos, cam);
        if (sp && rCells < 40) this.line(sp.cx, sp.cy, pp.cx, pp.cy, ':', '#3f5a4a');
      }
    }
    if (rCells > 3) {
      this.text(pr.cx - st.name.length / 2, pr.cy - rCells - 2, st.name, st.color);
    }
  }
  shadeEdge(color, depth) {
    // crude brightness by depth: parse hex
    const c = hexToRgb(color);
    const f = clamp(0.55 + depth * 0.001, 0.4, 1.1);
    return rgbToHex(clamp(c.r * f, 0, 255), clamp(c.g * f, 0, 255), clamp(c.b * f, 0, 255));
  }

  drawDerelict(d, cam, Gp) {
    const pr = this.project(d.pos, cam);
    if (!pr) return;
    const rCells = (d.radius * pr.s) / this.cellW;
    if (rCells < 0.4) { this.put(pr.cx, pr.cy, 'x', '#6a7684'); return; }
    const mesh = this.derelictMesh(d);
    const rotQ = qaxisLocal(d.spinAxis, d.spinAngle);
    const pts = mesh.nodes.map(n => this.project(vadd(d.pos, qrotLocal(rotQ, n)), cam)).filter(Boolean);
    const dim = rCells < 2.5;
    for (const [i, j] of mesh.edges) {
      if (!pts[i] || !pts[j]) continue;
      this.line(pts[i].cx, pts[i].cy, pts[j].cx, pts[j].cy, dim ? '.' : (this.hashCell(i, j) > 0.5 ? '%' : '#'), '#7a8794');
    }
    if (rCells > 3) this.text(pr.cx - d.name.length / 2, pr.cy - rCells - 2, d.name, '#9aa7b4');
  }
  derelictMesh(d) {
    if (d._mesh) return d._mesh;
    let h = d.seed;
    const rnd = () => { h = (h * 16807) % 2147483647; return h / 2147483647; };
    const nodes = [], edges = [];
    const addN = (p) => { nodes.push(p); return nodes.length - 1; };
    const core = addN(v3());
    const n = 7 + Math.floor(rnd() * 4);
    const ids = [];
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU, b = rnd() * TAU;
      const r = d.radius * (0.5 + rnd() * 0.8);
      ids.push(addN(v3(Math.cos(a) * Math.cos(b) * r, Math.sin(b) * r * 0.6, Math.sin(a) * Math.cos(b) * r)));
      edges.push([core, ids[ids.length - 1]]);
    }
    for (let i = 0; i < ids.length - 1; i += 2) edges.push([ids[i], ids[i + 1]]);
    d._mesh = { nodes, edges };
    return d._mesh;
  }

  // ---------------- entities ----------------
  drawShip(sh, cam, Gp) {
    const pr = this.project(sh.pos, cam);
    if (!pr) return;
    const fwd = qforwardLocal(sh.quat);
    const p2 = this.project(vadd(sh.pos, vscale(fwd, 4)), cam);
    let ang = 0;
    if (p2) ang = Math.atan2(p2.cy - pr.cy, p2.cx - pr.cx);
    const glyphs = [['→', 0], ['\\', 45], ['↓', 90], ['/', 135], ['←', 180], ['/', -135], ['↑', -90], ['\\', -45]];
    // ASCII fallback: use plain chars
    const asciiGlyphs = [['>', 0], ['\\', 45], ['v', 90], ['/', 135], ['<', 180], ['/', -135], ['^', -90], ['\\', -45]];
    let best = asciiGlyphs[0];
    let bestD = 999;
    for (const g of asciiGlyphs) {
      let dd = Math.abs(((ang * 180 / Math.PI) - g[1] + 540) % 360 - 180);
      if (dd < bestD) { bestD = dd; best = g; }
    }
    const flash = Gp.player.hullFlash > 0 && Math.sin(this.time * 30) > 0;
    this.put(pr.cx, pr.cy, best[0], flash ? PAL.bad : PAL.ship);
    // engine flare
    const tv = sh.thrustVis;
    if (vlen(tv) > 0.5) {
      const back = this.project(vadd(sh.pos, vscale(fwd, -3)), cam);
      if (back) this.put(back.cx, back.cy, Math.sin(this.time * 40) > 0 ? '*' : '+', '#ffb36a');
    }
    if (sh.gearDown) this.put(pr.cx, pr.cy + 1, 'H', '#8a94a2');
    if (sh.anchoredTo) this.put(pr.cx + 1, pr.cy, 'K', PAL.info);
    if (sh.dockedTo) this.put(pr.cx + 1, pr.cy, 'D', PAL.good);
  }

  drawEVA(ev, cam) {
    const pr = this.project(ev.pos, cam);
    if (!pr) return;
    this.put(pr.cx, pr.cy, '@', PAL.eva);
    const p2 = this.project(vadd(ev.pos, v3(0, 1, 0)), cam);
    if (p2) this.put(lerp(pr.cx, p2.cx, 0.6), lerp(pr.cy, p2.cy, 0.6), '.', PAL.eva);
  }

  drawFoot(ft, cam) {
    const pr = this.project(ft.pos, cam);
    if (!pr) return;
    const bob = ft.attached && Math.abs(ft.walkPhase || 0) % 2 > 1 ? 0.3 : 0;
    this.put(pr.cx, pr.cy + bob, '@', ft.magboots ? PAL.eva : '#ff9d5c');
    if (!ft.magboots) this.put(pr.cx + 1, pr.cy, '~', PAL.bad);
  }

  drawDrone(dr, cam) {
    const pr = this.project(dr.pos, cam);
    if (!pr) return;
    const pulse = dr.fireCd < 0.2;
    this.put(pr.cx, pr.cy, pulse ? '&' : '%', dr.color);
    if (pulse) this.put(pr.cx + 1, pr.cy, '*', PAL.enemyLaser);
  }

  drawProjectiles(Gp, cam) {
    for (const pr of Gp.projectiles) {
      const p = this.project(pr.pos, cam);
      if (!p) continue;
      this.put(p.cx, p.cy, pr.ch, pr.color);
      const tailP = this.project(vsub(pr.pos, vscale(pr.vel, 0.02)), cam);
      if (tailP) this.put(tailP.cx, tailP.cy, '.', pr.color);
    }
  }

  drawParticles(Gp, cam) {
    for (const p of Gp.particles) {
      const pr = this.project(p.pos, cam);
      if (!pr) continue;
      const f = p.life / p.maxLife;
      if (f < 0.35 && p.ch === '*') this.put(pr.cx, pr.cy, '.', p.color);
      else this.put(pr.cx, pr.cy, p.ch, p.color);
    }
  }

  drawPickups(Gp, cam) {
    for (const pk of Gp.pickups) {
      const pr = this.project(pk.pos, cam);
      if (!pr) continue;
      const blink = Math.sin(this.time * 5) > 0;
      this.put(pr.cx, pr.cy, blink ? 'o' : '°', PAL.ore);
    }
  }

  drawTerrain(body, cam, Gp, gap = 8) {
    // Per-screen-cell inverse projection onto the tangent plane of the body:
    // crisp ground cover at any altitude, curving away over the limb.
    const cols = this.cols, rows = this.rows;
    const pPos = Gp.player.mode === 'ship' ? Gp.player.ship.pos : Gp.player.mode === 'eva' ? Gp.player.eva.pos : Gp.player.foot.pos;
    if (!pPos || !body.radius) return;
    const toC = vsub(pPos, body.pos);
    const n = vnorm(toC);
    let e1 = vnorm(vcross(n, v3(0, 0, 1)));
    if (vlen(e1) < 1e-3) e1 = v3(1, 0, 0);
    let e2 = vnorm(vcross(n, e1));
    const surfPt = vadd(body.pos, vscale(n, body.radius));
    const K = vdot(surfPt, n) - (n.x * cam.x + n.y * cam.y + n.z * cam.z);
    const S = this.baseScale(cam);
    const seed = body.seed || 1;
    const maxAlt = clamp(gap * 2.5, 25, 260);
    const cosI = Math.cos(Math.atan2(1, 1)); // placeholder removed below
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const fx = (col - cols / 2) * this.cellW;
        const fy = (row - rows / 2) * this.cellH;
        let dx, dy, dz;
        if (cam.mode === 'iso') {
          const A = fx / (S * COS30);            // dx - dy
          const B = fy / (S * this.isoY);        // (dx+dy)/2 - dz
          const sn = n.x + n.y + n.z;
          if (Math.abs(sn) < 1e-6) continue;
          dx = (K + n.y * A + n.z * (B + A / 2)) / sn;
          dy = dx - A;
          dz = dx - B - A / 2;
        } else {
          dx = fx / S; dy = fy / S;
          if (Math.abs(n.z) < 1e-4) continue;
          dz = (K - n.x * dx - n.y * dy) / n.z;
        }
        const px = cam.x + dx, py = cam.y + dy, pz = cam.z + dz;
        const rx = px - body.pos.x, ry = py - body.pos.y, rz = pz - body.pos.z;
        const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
        const alt = r - body.radius;
        if (alt < -1.5 || alt > maxAlt) continue;
        const lx = (px - surfPt.x) * e1.x + (py - surfPt.y) * e1.y + (pz - surfPt.z) * e1.z;
        const ly = (px - surfPt.x) * e2.x + (py - surfPt.y) * e2.y + (pz - surfPt.z) * e2.z;
        const h = this.hashCell(Math.round(lx * 0.5 + seed), Math.round(ly * 0.5));
        const fade = clamp(1 - alt / maxAlt, 0.08, 1);
        let ch = h > 0.985 ? '^' : h > 0.965 ? 'o' : h > 0.89 ? '*' : h > 0.76 ? '+' : h > 0.52 ? ':' : '.';
        const base = body.kind === 'moon' ? [148, 168, 194] : body.comp && body.comp.ice > 0.4 ? [150, 195, 210] : [150, 138, 118];
        const f = Math.pow(fade, 1.5) * (0.5 + h * 0.5);
        this.put(col, row, ch, rgbToHex(base[0] * f, base[1] * f, base[2] * f));
      }
    }
  }

  drawReticle(target, cam, Gp) {
    const pos = target.kind === 'station' ? target.pos : target.kind === 'asteroid' ? target.pos :
      target.kind === 'derelict' ? target.pos : target.kind === 'drone' ? target.pos :
      target.kind === 'comet' ? target.pos : target.kind === 'moon' ? target.pos : target.kind === 'planet' ? target.pos : target.pos;
    const pr = this.project(pos, cam);
    if (!pr) {
      // offscreen arrow
      const dir = vsub(pos, cam);
      const ax = clamp(this.cols / 2 + dir.x * 0.02, 2, this.cols - 2);
      const ay = clamp(this.rows / 2 + dir.y * 0.02, 2, this.rows - 2);
      this.put(ax, ay, '»', PAL.ore);
      return;
    }
    const r = clamp((target.radius ? target.radius : target.size ? target.size : 8) * pr.s / this.cellW + 2, 3, 18);
    const puls = Math.sin(this.time * 4) * 0.5;
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [sx, sy] of corners) {
      const cx = pr.cx + sx * r, cy = pr.cy + sy * r * 0.7;
      this.put(cx, cy, sx * sy > 0 ? '\\' : '/', PAL.ore);
    }
    if (puls > 0) {
      this.put(pr.cx, pr.cy - r * 0.7 - 1, 'v', PAL.ore);
      this.put(pr.cx, pr.cy + r * 0.7 + 1, '^', PAL.ore);
    }
  }
}

// quat helpers (local copies to avoid circular imports)
function qaxisLocal(axis, ang) {
  const h = ang * 0.5, s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}
function qrotLocal(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
function qforwardLocal(q) { return qrotLocal(q, v3(1, 0, 0)); }

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function rgbToHex(r, g, b) {
  const to = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
