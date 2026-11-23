// Renders one frame headlessly and prints the ASCII buffer — for visual tuning.
// Run: node test/frame-dump.mjs [scene]
const scene = process.argv[2] || 'orbit';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
function fakeCtx() {
  return {
    font: '', fillStyle: '', globalAlpha: 1, textBaseline: '',
    measureText: (s) => ({ width: s.length * 8 }),
    fillRect() {}, fillText() {}, drawImage() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    beginPath() {}, arc() {}, fill() {},
  };
}
function fakeCanvas() { return { width: 960, height: 560, getContext: () => fakeCtx(), style: {} }; }
globalThis.window = { innerWidth: 960, innerHeight: 560, addEventListener() {}, AudioContext: undefined, webkitAudioContext: undefined };
globalThis.document = {
  readyState: 'complete',
  getElementById: (id) => (id === 'screen' ? fakeCanvas() : { remove() {} }),
  createElement: () => fakeCanvas(),
  addEventListener() {},
};
globalThis.requestAnimationFrame = () => 1;
globalThis.location = { hash: '', reload() {} };

const { G } = await import('../js/state.js');
await import('../js/main.js');
const gameMod = await import('../js/game.js');
const interiorsMod = await import('../js/interiors.js');
const { Renderer } = await import('../js/renderer.js');

G.uiMode = 'play';
gameMod.newGame(G.world.seed);
for (let i = 0; i < 10; i++) gameMod.update(G, 1 / 60);

// place player per scene
const pl = G.player, sh = pl.ship;
if (scene === 'orbit') {
  const st = G.world.stations.find(s => s.id === 'hregg');
  sh.pos = { x: st.pos.x - 40, y: st.pos.y - 40, z: st.pos.z - 40 };
  sh.vel = { ...st.vel };
  G.cam.mode = 'iso'; G.settings.iso = true; G.cam.zoom = 0.7;
} else if (scene === 'belt') {
  const ast = G.world.asteroids.find(a => a.radius > 40);
  sh.pos = { x: ast.pos.x - 35, y: ast.pos.y - 35, z: ast.pos.z - 35 };
  sh.vel = { ...ast.vel };
  G.target = ast;
  G.cam.mode = 'iso'; G.settings.iso = true; G.cam.zoom = 1.0;
} else if (scene === 'moonwalk') {
  pl.mode = 'walk';
  pl.foot.pos = { x: 600.6, y: 0, z: 0 };
  pl.foot.up = { x: 1, y: 0, z: 0 };
  pl.foot.vel = { x: 0, y: 0, z: 0 };
  pl.foot.attached = true;
  G.cam.mode = 'iso'; G.settings.iso = true; G.cam.zoom = 3.2;
  sh.pos = { x: 603, y: 0.5, z: 0 };
  sh.landedOn = G.world.moon; sh.landedName = 'KVELD';
} else if (scene === 'topdown') {
  const st = G.world.stations.find(s => s.id === 'aurora');
  sh.pos = { x: st.pos.x, y: st.pos.y - 25, z: 0 };
  sh.vel = { ...st.vel };
  G.cam.mode = 'top'; G.settings.iso = false; G.cam.zoom = 1.0;
} else if (scene === 'interior') {
  pl.mode = 'interior';
  pl.interior = { map: interiorsMod.buildStationInterior(G.world.stations[0]), pos: { x: 18, y: 19 }, prevMode: 'ship' };
}

// settle camera (camera follow lives in drawScene)
const r = G.renderer;
for (let i = 0; i < 60; i++) { r.begin(); if (pl.mode === 'interior') G.hud.drawInterior(G, r, 1/60); else r.drawScene(G, 1/60); }
for (let i = 0; i < 30; i++) gameMod.update(G, 1 / 60);
G.hud.log('SAMPLE LOG LINE — SYSTEM NOMINAL', '#b7ff7a');

r.begin();
if (pl.mode === 'interior') G.hud.drawInterior(G, r, 1 / 60);
else r.drawScene(G, 1 / 60);
G.hud.drawHUD(G, r);

// dump
const cols = r.cols, rows = r.rows;
console.log(`scene=${scene} grid=${cols}x${rows}`);
for (let y = 0; y < rows; y++) {
  let line = '';
  for (let x = 0; x < cols; x++) line += r.ch[y * cols + x];
  console.log(line.replace(/\s+$/, ''));
}
