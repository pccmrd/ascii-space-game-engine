// Controls coverage test: every bound key/button produces an observable effect.
// Run: node test/controls-test.mjs
import assert from 'node:assert';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const { G } = await import('../js/state.js');
const { buildWorld } = await import('../js/world.js');
const game = await import('../js/game.js');
const { createPlayer, surfaceVelocity, referenceBody } = await import('../js/player.js');
const {
  vdist, vsub, vlen, vnorm, vadd, vscale, vdot, v3, qident, qforward, qrot,
} = await import('../js/core.js');

const hudStub = { log() {}, logEntries: [] };
const noopAudio = new Proxy({}, { get: () => () => {} });
function mkInput() {
  return {
    keys: new Set(), pressed: new Set(), mouse: { x: 0, y: 0, down: false, clicked: false, rclicked: false },
    down(c) { return this.keys.has(c); },
    hit(c) { return this.pressed.has(c); },
    axis(a, b) { return (this.down(b) ? 1 : 0) - (this.down(a) ? 1 : 0); },
    press(c) { this.pressed.add(c); this.keys.add(c); },
    endFrame() { this.pressed.clear(); this.mouse.clicked = false; },
  };
}

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  PASS', name); }
  catch (e) { console.error('  FAIL', name, '::', e.message); process.exitCode = 1; }
}

G.world = buildWorld('TESTSEED');
G.hud = hudStub;
G.audio = noopAudio;
G.input = mkInput();
G.uiMode = 'play';
G._interiors = {};
G.prompt = '';
G.settings.dampeners = true;
G.projectiles = [];

const step = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) { game.update(G, dt); G.input.endFrame(); } };
const sh = () => G.player.ship;
const reset = () => {
  game.newGame('TESTSEED');
  G.input.keys.clear(); G.input.pressed.clear();
  G.uiMode = 'play';
  G.projectiles.length = 0;
  G.target = null;
};
const tap = (code) => { G.input.press(code); step(1); };
const hold = (code, n) => { G.input.keys.add(code); step(n); G.input.keys.delete(code); };
const stopped = () => { sh().vel = { x: 0, y: 0, z: 0 }; };

console.log('— ship flight controls —');
ok('W/A/S/D/R/F all thrust along their axes', () => {
  const dirs = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF'];
  for (const k of dirs) {
    reset(); stopped();
    const p0 = { ...sh().pos };
    hold(k, 60);
    const moved = Math.hypot(sh().pos.x - p0.x, sh().pos.y - p0.y, sh().pos.z - p0.z);
    assert.ok(moved > 1.2, `${k} produced no movement (${moved.toFixed(2)})`);
  }
});
ok('ArrowUp pitches nose up, ArrowDown nose down', () => {
  reset();
  const nose = () => qforward(sh().quat);
  hold('ArrowUp', 40);
  const upY = nose().y;
  reset();
  hold('ArrowDown', 40);
  const dnY = nose().y;
  assert.ok(upY > 0.15, `ArrowUp nose.y=${upY.toFixed(2)}`);
  assert.ok(dnY < -0.15, `ArrowDown nose.y=${dnY.toFixed(2)}`);
});
ok('ArrowLeft/ArrowRight yaw the nose around', () => {
  reset();
  hold('ArrowLeft', 45);
  const lz = qforward(sh().quat).z;
  reset();
  hold('ArrowRight', 45);
  const rz = qforward(sh().quat).z;
  assert.ok(Math.abs(lz) > 0.1 && Math.abs(rz) > 0.1 && Math.sign(lz) !== Math.sign(rz),
    `yaw z left=${lz.toFixed(2)} right=${rz.toFixed(2)}`);
});
ok('Comma/Period roll in opposite directions', () => {
  reset(); hold('Comma', 12);
  const l = sh().rates.x;
  reset(); hold('Period', 12);
  const r = sh().rates.x;
  assert.ok(l > 0.2, `comma roll rate ${l.toFixed(2)}`);
  assert.ok(r < -0.2, `period roll rate ${r.toFixed(2)}`);
});
ok('T performs a 180° flip', () => {
  reset();
  sh().vel = { x: 5, y: 0, z: 0 };
  const before = qforward(sh().quat);
  tap('KeyT');
  step(150);
  const after = qforward(sh().quat);
  assert.ok(vdot(before, after) < -0.5, `nose reversed, dot=${vdot(before, after).toFixed(2)}`);
});
ok('Shift boosts thrust', () => {
  reset(); stopped(); hold('KeyW', 40);
  const plain = vlen(sh().vel);
  reset(); stopped();
  G.input.keys.add('ShiftLeft'); hold('KeyW', 40); G.input.keys.delete('ShiftLeft');
  const boosted = vlen(sh().vel);
  assert.ok(boosted > plain * 1.5, `boost ${boosted.toFixed(1)} vs plain ${plain.toFixed(1)}`);
});
ok('X brake bleeds relative velocity', () => {
  reset();
  sh().vel = { x: 30, y: 0, z: 0 };
  const ref = referenceBody(G.world, sh().pos);
  const rel = () => vlen(vsub(sh().vel, surfaceVelocity(ref, sh().pos)));
  const v0 = rel();
  hold('KeyX', 90);
  const v1 = rel();
  assert.ok(v1 < v0 * 0.5, `brake ${v0.toFixed(1)} -> ${v1.toFixed(1)}`);
});
ok('G toggles inertial dampeners', () => {
  reset();
  const d0 = !!G.settings.dampeners;
  tap('KeyG');
  assert.equal(!!G.settings.dampeners, !d0, 'dampeners flipped');
});

console.log('— combat / tools —');
ok('Space fires ship lasers (mouse button too)', () => {
  reset();
  const n0 = G.projectiles.length;
  hold('Space', 5);
  assert.ok(G.projectiles.length > n0 || sh().fireCooldown > 0, 'no laser fired');
  G.projectiles.length = 0; sh().fireCooldown = 0;
  G.input.mouse.down = true; step(5); G.input.mouse.down = false;
  assert.ok(G.projectiles.length > 0 || sh().fireCooldown > 0, 'mouse laser did not fire');
});
ok('TAB cycles targets', () => {
  reset();
  tap('Tab');
  const t1 = G.target;
  assert.ok(t1, 'target acquired');
  tap('Tab');
  assert.ok(G.target && G.target !== t1, 'target cycled');
});
ok('V scans the targeted body', () => {
  reset();
  G.target = G.world.stations.find(s => s.id === 'hregg');
  G.target.scanned = 0;
  hold('KeyV', 60);
  assert.ok(G.target.scanned > 0.1, `scan progress ${G.target.scanned}`);
});
ok('C mining beam extracts ore on foot', () => {
  reset();
  const ast = G.world.asteroids.find(a => a.radius > 15 && a.oreLeft > 0);
  ast.scanned = 1;
  G.player.mode = 'walk';
  const dir = vnorm(v3(1, 0.2, 0.1));
  G.player.foot.pos = vadd(ast.pos, vscale(dir, ast.radius + 1.2));
  G.player.foot.vel = { x: 0, y: 0, z: 0 };
  G.player.foot.up = dir;
  G.player.foot.body = ast;
  G.player.foot.attached = true;
  G.player.ship.cargo = {};
  const before = Object.values(sh().cargo).reduce((a, b) => a + b, 0);
  hold('KeyC', 150);
  const after = Object.values(sh().cargo).reduce((a, b) => a + b, 0);
  assert.ok(after > before, `ore extracted ${before} -> ${after}`);
});

console.log('— docking / landing / modes —');
ok('L deploys and retracts landing gear', () => {
  reset();
  const g0 = sh().gearDown;
  tap('KeyL');
  assert.equal(sh().gearDown, !g0, 'gear toggled');
});
ok('K mag-anchors to a nearby rock and releases', () => {
  reset();
  const ast = G.world.asteroids.find(a => a.radius > 20);
  sh().pos = vadd(ast.pos, v3(ast.radius + 12, 0, 0));
  sh().vel = { ...ast.vel };
  tap('KeyK');
  assert.ok(sh().anchoredTo, 'anchored');
  tap('KeyK');
  assert.ok(!sh().anchoredTo, 'released');
});
ok('E docks at a port, enters station, opens market, exits', () => {
  reset();
  const st = G.world.stations.find(s => s.id === 'hregg');
  const port = st.ports[0];
  sh().pos = { x: port.pos.x + 5, y: port.pos.y, z: port.pos.z };
  sh().vel = surfaceVelocity(st, sh().pos);
  sh().landedOn = null; sh().dockedTo = null; sh().anchoredTo = null;
  tap('KeyE');
  assert.ok(sh().dockedTo && sh().dockedTo.id === 'hregg', 'docked via E');
  tap('KeyE'); // enter station
  assert.equal(G.player.mode, 'interior', 'entered station');
  // walk inside with WASD
  const p0 = { ...G.player.interior.pos };
  hold('KeyD', 20);
  assert.ok(Math.abs(G.player.interior.pos.x - p0.x) > 0.3 || Math.abs(G.player.interior.pos.y - p0.y) > 0.3, 'interior movement');
  // terminal -> market
  const term = G.player.interior.map.terminals[0];
  G.player.interior.pos = { x: term.x + 0.5, y: term.y + 0.5 };
  tap('KeyE');
  assert.equal(G.uiMode, 'market', 'market opened');
  tap('Escape');
  assert.equal(G.uiMode, 'play', 'market closed');
  // airlock back out to the hull
  const al = G.player.interior.map.airlocks[0];
  G.player.interior.pos = { x: al.x + 0.5, y: al.y + 0.5 };
  tap('KeyE');
  assert.equal(G.player.mode, 'walk', 'airlock exit works');
  assert.equal(G.player.foot.body.id, 'hregg', 'standing on the hull');
});
ok('U undocks and saves when flying free', () => {
  reset();
  const st = G.world.stations.find(s => s.id === 'hregg');
  const port = st.ports[0];
  sh().pos = { x: port.pos.x + 5, y: port.pos.y, z: port.pos.z };
  sh().vel = surfaceVelocity(st, sh().pos);
  tap('KeyE'); // dock
  assert.ok(sh().dockedTo, 'docked');
  tap('KeyU'); // undock
  assert.ok(!sh().dockedTo, 'undocked');
  tap('KeyU'); // save while flying
  assert.ok(store['starfarer.save.v1'], 'save written');
});
ok('J exits to EVA and boards again', () => {
  reset();
  tap('KeyJ');
  assert.equal(G.player.mode, 'eva', 'in EVA');
  const p0 = { ...G.player.eva.pos };
  hold('KeyW', 40);
  const moved = Math.hypot(G.player.eva.pos.x - p0.x, G.player.eva.pos.y - p0.y, G.player.eva.pos.z - p0.z);
  assert.ok(moved > 2, `EVA jet moved ${moved.toFixed(2)}`);
  G.player.eva.pos = { ...sh().pos };
  G.player.eva.vel = { x: 0, y: 0, z: 0 };
  tap('KeyJ');
  assert.equal(G.player.mode, 'ship', 'boarded ship');
});
ok('M toggles magnetic boots on foot', () => {
  reset();
  const ft = G.player.foot;
  G.player.mode = 'walk';
  const m0 = !!ft.magboots;
  tap('KeyM');
  assert.notEqual(!!ft.magboots, m0, 'mag boots toggled');
});
ok('B calls a rescue tug when fuel-starved', () => {
  reset();
  sh().fuel = 1; sh().credits = 100;
  tap('KeyB');
  assert.ok(sh().fuel > 10, `refueled to ${sh().fuel}`);
  assert.equal(sh().credits, 50, 'rescue fee charged');
});

console.log('— camera / time / UI —');
ok('Z toggles isometric view', () => {
  reset();
  const i0 = !!G.settings.iso;
  tap('KeyZ');
  assert.notEqual(!!G.settings.iso, i0, 'iso flipped');
});
ok('+ / - zoom the camera', () => {
  reset();
  const z0 = G.cam.zoom;
  hold('Equal', 20);
  const zi = G.cam.zoom;
  hold('Minus', 20);
  const zo = G.cam.zoom;
  assert.ok(zi > z0, `zoom in ${z0} -> ${zi}`);
  assert.ok(zo < zi, `zoom out ${zi} -> ${zo}`);
});
ok('1/2/3 set time warp', () => {
  reset();
  tap('Digit1'); assert.equal(G.timeScale, 0.25, 'slow');
  tap('Digit2'); assert.equal(G.timeScale, 1, 'normal');
  tap('Digit3'); assert.equal(G.timeScale, 4, 'fast');
});
ok('P pauses and resumes, H help, N mute', () => {
  reset();
  tap('KeyP');
  assert.equal(G.uiMode, 'pause', 'paused');
  tap('KeyP');
  assert.equal(G.uiMode, 'play', 'resumed');
  tap('KeyH');
  assert.equal(G.uiMode, 'help', 'help open');
  tap('KeyH');
  assert.equal(G.uiMode, 'play', 'help closed');
  const m0 = !!G.settings.mute;
  tap('KeyN');
  assert.notEqual(!!G.settings.mute, m0, 'mute toggled');
});
ok('Escape opens pause and closes menus', () => {
  reset();
  tap('Escape');
  assert.equal(G.uiMode, 'pause', 'escape pauses');
  tap('Escape');
  assert.equal(G.uiMode, 'play', 'escape resumes');
});
ok('ENTER starts the game from the title screen', () => {
  reset();
  G.uiMode = 'title';
  tap('Enter');
  assert.equal(G.uiMode, 'play', 'game started');
});
ok('death screen ENTER respawns', () => {
  reset();
  sh().hull = 0;
  step(1);
  assert.equal(G.uiMode, 'dead', 'died');
  tap('Enter');
  assert.equal(G.uiMode, 'play', 'respawned');
});

console.log(`\n${passed} control checks passed`);
