// main.js — boot, main loop, mode orchestration.

import { G } from './state.js';
import { Renderer, PAL } from './renderer.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { AudioBus } from './audio.js';
import { buildWorld } from './world.js';
import { update, saveGame, loadGame, handleUiInput } from './game.js';
import { createPlayer } from './player.js';

function boot() {
  const canvas = document.getElementById('screen');
  const bootMsg = document.getElementById('boot-msg');
  if (bootMsg) bootMsg.remove();

  G.renderer = new Renderer(canvas);
  G.hud = new Hud();
  G.input = new Input(window);
  G.audio = new AudioBus();
  G._interiors = {};
  G.prompt = '';
  G.uiMode = 'title';
  G.cam.fwd = { x: Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 };

  // seed from URL hash (#SEED=foo) or default
  let seed = 'KVELD-PRIME';
  if (typeof location !== 'undefined' && location.hash) {
    const m = location.hash.match(/SEED=([A-Za-z0-9\-_]+)/i);
    if (m) seed = m[1];
  }
  G.seed = seed;
  G.world = buildWorld(seed);
  G.player = createPlayer(); // placeholder for the attract-mode background

  window.addEventListener('resize', () => { G.renderer.resize(); });
  G.input.onFirstKey = () => { G.audio.resume(); };

  // first frame
  G.renderer.begin();
  G.hud.drawTitle(G, G.renderer);
  G.renderer.flush(0);
  requestAnimationFrame(frame);
}

let lastT = 0;
const STEP = 1 / 60;
let acc = 0;
let attractT = 0;

function frame(tms) {
  requestAnimationFrame(frame);
  const now = tms / 1000;
  let rawDt = Math.min(0.1, now - (lastT || now));
  lastT = now;

  const r = G.renderer;
  const inp = G.input;

  // ---------- simulate ----------
  if (G.uiMode === 'title') {
    attractT += rawDt;
    const dt = rawDt;
    G.time += dt * 10;
    G.world.update(G.time, dt);
    const a = attractT * 0.03;
    G.cam.x = Math.cos(a) * 2600;
    G.cam.y = Math.sin(a) * 2600;
    G.cam.z = 900;
    G.cam.zoom = 0.5;
    G.cam.mode = 'iso';
  } else if (G.uiMode === 'play') {
    acc += rawDt;
    let n = 0;
    while (acc >= STEP && n < 8) {
      update(G, STEP);
      acc -= STEP;
      n++;
    }
    if (n === 8) acc = 0;
  }
  if (G.uiMode !== 'play') handleUiInput(G, rawDt);

  // ---------- render ----------
  r.begin();
  if (G.uiMode === 'title') {
    r.drawScene(G, rawDt);
    G.hud.drawTitle(G, r);
  } else {
    if (G.player.mode === 'interior' && G.uiMode !== 'dead') {
      G.hud.drawInterior(G, r, rawDt);
      if (G.uiMode === 'market') G.hud.drawMarket(G, r);
    } else {
      r.drawScene(G, rawDt);
      G.hud.drawHUD(G, r);
      if (G.uiMode === 'help') G.hud.drawHelp(G, r);
      if (G.uiMode === 'pause') G.hud.drawPause(G, r);
      if (G.uiMode === 'dead') G.hud.drawDead(G, r);
    }
  }
  r.flush(rawDt);

  inp.endFrame();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
