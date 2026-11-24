// Headless smoke/simulation test for the engine logic (no DOM).
// Run: node test/sim-test.mjs
import assert from 'node:assert';

// ---------- browser stubs ----------
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const { G, SAVE_KEY } = await import('../js/state.js');
const { buildWorld } = await import('../js/world.js');
const game = await import('../js/game.js');
const { createPlayer, exitShipToWalk, charAt, surfaceVelocity, referenceBody } = await import('../js/player.js');
const physics = await import('../js/physics.js');
const interiors = await import('../js/interiors.js');
const npc = await import('../js/npc.js');
const { vdist, vsub, vlen, vnorm, vadd, vscale, qident, qforward } = await import('../js/core.js');

// ---------- fakes ----------
const noopAudio = new Proxy({}, { get: () => () => {} });
const hudStub = { log() {}, logEntries: [] };
function mkInput() {
  return {
    keys: new Set(), pressed: new Set(), mouse: { x: 0, y: 0, down: false, clicked: false, rclicked: false },
    _axis: [0, 0],
    down(c) { return this.keys.has(c); },
    hit(c) { return this.pressed.has(c); },
    axis(a, b) { return (this.down(b) ? 1 : 0) - (this.down(a) ? 1 : 0); },
    press(c) { this.pressed.add(c); this.keys.add(c); },
    endFrame() { this.pressed.clear(); },
  };
}

let passed = 0;
function ok(name, fn) {
  G.input.keys.clear(); G.input.pressed.clear(); // no key bleed between checks
  try { fn(); passed++; console.log('  PASS', name); }
  catch (e) { console.error('  FAIL', name, '::', e.message); process.exitCode = 1; }
  G.input.keys.clear(); G.input.pressed.clear();
}

// ---------- setup ----------
G.world = buildWorld('TESTSEED');
G.player = createPlayer();
G.hud = hudStub;
G.audio = noopAudio;
G.input = mkInput();
G.uiMode = 'play';
G._interiors = {};
G.prompt = '';
G.settings.dampeners = true;

const step = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) { game.update(G, dt); G.input.endFrame(); } };
const sh = () => G.player.ship;

console.log('— world generation —');
ok('world builds with stations/belt/comet', () => {
  assert.equal(G.world.stations.length, 5);
  assert.ok(G.world.asteroids.length >= 300);
  assert.ok(G.world.derelicts.length === 4);
  assert.ok(G.world.comet && isFinite(G.world.comet.pos.x));
  const caves = G.world.asteroids.filter(a => a.cave);
  assert.ok(caves.length >= 3, 'should have caves');
});
ok('orbital kinematics finite & stations expose ports', () => {
  for (let t = 0; t < 200; t += 0.5) G.world.update(t, 0.5);
  for (const st of G.world.stations) {
    assert.ok(isFinite(st.pos.x + st.pos.y + st.pos.z));
    assert.ok(st.ports.length >= 2 && isFinite(st.ports[0].pos.x));
    const orbitR = Math.hypot(st.pos.x, st.pos.y, st.pos.z);
    assert.ok(Math.abs(orbitR - st.orbit.r) < 50, `orbit radius drift ${orbitR}`);
  }
});

console.log('— flight —');
game.newGame('TESTSEED');
ok('new game spawns near Hregg with fuel', () => {
  const st = G.world.stations.find(s => s.id === 'hregg');
  const d = vdist(sh().pos, st.pos);
  assert.ok(d < 400, `spawn near station (d=${d.toFixed(0)})`);
  assert.ok(sh().fuel > 90);
});
ok('main thrust accelerates ship forward', () => {
  const p0 = { ...sh().pos };
  G.input.keys.add('KeyW');
  step(600);
  G.input.keys.delete('KeyW');
  const moved = Math.hypot(sh().pos.x - p0.x, sh().pos.y - p0.y, sh().pos.z - p0.z);
  assert.ok(moved > 100, `moved ${moved}`);
  assert.ok(sh().fuel < 100, 'fuel burned');
});
ok('newtonian drift without assist conserves velocity', () => {
  G.settings.dampeners = false;
  sh().vel = { x: 10, y: 0, z: 0 };
  const v0 = { ...sh().vel };
  step(120);
  assert.ok(Math.abs(sh().vel.x - v0.x) < 0.5, `vx drift ${sh().vel.x}`);
  G.settings.dampeners = true;
});
ok('moon gravity pulls a stationary ship down', () => {
  sh().pos = { x: 1000, y: 0, z: 0 }; sh().vel = { x: 0, y: 0, z: 0 };
  const r0 = Math.hypot(sh().pos.x, sh().pos.y, sh().pos.z);
  step(300);
  const r1 = Math.hypot(sh().pos.x, sh().pos.y, sh().pos.z);
  assert.ok(r1 < r0, `fell inward ${r0} -> ${r1}`);
});
ok('ship can land softly on the moon and take off again', () => {
  sh().pos = { x: 610, y: 0, z: 0 }; sh().vel = { x: -1, y: 0, z: 0 };
  sh().gearDown = true;
  step(600);
  assert.ok(sh().landedOn === G.world.moon, 'landed on moon, got ' + (sh().landedOn && sh().landedOn.name));
  G.input.press('KeyL'); // retract gear
  G.input.keys.add('KeyR');
  step(90);
  G.input.keys.delete('KeyR');
  assert.ok(!sh().landedOn, 'liftoff');
});

console.log('— scanning / mining / combat —');
ok('scan completes on targeted asteroid', () => {
  // put ship next to a big asteroid
  const ast = G.world.asteroids.find(a => a.radius > 30);
  sh().pos = { x: ast.pos.x + ast.radius + 200, y: ast.pos.y, z: ast.pos.z };
  sh().vel = { ...ast.vel };
  G.target = ast;
  G.input.keys.add('KeyV');
  step(600);
  G.input.keys.delete('KeyV');
  assert.ok(ast.scanned >= 1, `scan=${ast.scanned}`);
});
ok('mining beam extracts ore into cargo', () => {
  const ast = G.target;
  sh().pos = { x: ast.pos.x + ast.radius + 60, y: ast.pos.y, z: ast.pos.z };
  sh().vel = { ...ast.vel };
  G.input.keys.add('KeyC');
  step(600);
  G.input.keys.delete('KeyC');
  const cargoN = Object.values(sh().cargo).reduce((a, b) => a + b, 0);
  assert.ok(cargoN > 0, 'cargo extracted');
  assert.ok(ast.oreLeft < ast.radius * ast.richness * 2.2 + 1, 'vein depleted');
});
ok('lasers destroy a drone and drop salvage', () => {
  G.drones.length = 0; G.projectiles.length = 0;
  G.settings.dampeners = false;
  sh().pos = { x: 30000, y: 30000, z: 30000 }; sh().vel = { x: 0, y: 0, z: 0 };
  sh().dockedTo = null; sh().landedOn = null; sh().anchoredTo = null;
  sh().quat = { x: 0, y: 0, z: 0, w: 1 };
  const dr = npc.spawnDrone(G, { x: 30040, y: 30000, z: 30000 }, 'TEST');
  let ticks = 0;
  while (!dr.dead && ticks < 2000) {
    dr.pos = { x: 30040, y: 30000, z: 30000 }; dr.vel = { x: 0, y: 0, z: 0 }; // pin target
    G.input.mouse.down = true;
    game.update(G, 1 / 60);
    G.input.endFrame();
    ticks++;
  }
  assert.ok(dr.dead, 'drone destroyed');
  assert.ok(G.pickups.length > 0, 'pod dropped');
  G.input.mouse.down = false;
  G.settings.dampeners = true;
});
ok('hostile drone shoots back (projectile hits ship)', () => {
  G.drones.length = 0; G.projectiles.length = 0;
  G.settings.dampeners = false;
  sh().pos = { x: 30000, y: 30000, z: 30000 }; sh().vel = { x: 0, y: 0, z: 0 };
  sh().dockedTo = null; sh().landedOn = null; sh().anchoredTo = null;
  const dr = npc.spawnDrone(G, { x: 30090, y: 30000, z: 30000 }, 'TEST');
  sh().hull = 100; sh().shield = 0;
  let hit = false;
  for (let i = 0; i < 2000 && !hit; i++) {
    dr.pos = { x: 30090, y: 30000, z: 30000 }; dr.vel = { x: 0, y: 0, z: 0 };
    game.update(G, 1 / 60); G.input.endFrame();
    if (sh().hull < 100) hit = true;
  }
  assert.ok(hit, 'hostile fire landed');
  dr.dead = true;
  G.settings.dampeners = true;
});

console.log('— docking / interior —');
ok('dock when close & slow, enter station, EVA out airlock', () => {
  const st = G.world.stations.find(s => s.id === 'hregg');
  const port = st.ports[0];
  sh().pos = { x: port.pos.x + 8, y: port.pos.y, z: port.pos.z };
  sh().vel = surfaceVelocity(st, sh().pos);
  sh().dockedTo = null; sh().landedOn = null; sh().anchoredTo = null;
  game.interact(G);
  assert.ok(sh().dockedTo && sh().dockedTo.id === 'hregg', 'docked');
  game.interact(G); // enter station
  assert.equal(G.player.mode, 'interior', 'inside station');
  assert.equal(G.player.interior.map.stationId, 'hregg');
  // walk to airlock tile
  const al = G.player.interior.map.airlocks[0];
  G.player.interior.pos = { x: al.x + 0.5, y: al.y + 0.5 };
  game.interact(G);
  assert.equal(G.player.mode, 'walk', 'out on hull');
  assert.equal(G.player.foot.body.id, 'hregg', 'standing on station hull');
});
ok('walk on hull sticks with mag boots', () => {
  G.settings.dampeners = true;
  step(300);
  const ft = G.player.foot;
  assert.ok(ft.attached, 'boots attached');
  const surf = physics.findSurface(G.world, ft.pos);
  assert.ok(surf && surf.gap < 6, `sticks near surface, gap=${surf ? surf.gap.toFixed(2) : 'none'}`);
});
ok('EVA can airlock-dock into a station on foot', () => {
  const st = G.world.stations.find(s => s.id === 'hregg');
  const port = st.ports[0];
  G.player.mode = 'eva';
  G.player.interior = null;
  sh().landedOn = null; sh().anchoredTo = null; sh().dockedTo = null;
  sh().pos = { x: port.pos.x + 400, y: port.pos.y + 400, z: port.pos.z + 400 }; // ship safely elsewhere
  G.player.eva.pos = { x: port.pos.x + 4, y: port.pos.y, z: port.pos.z };
  G.player.eva.vel = surfaceVelocity(st, G.player.eva.pos);
  game.interact(G);
  assert.equal(G.player.mode, 'interior', 'cycled in');
  assert.equal(G.player.interior.map.stationId, 'hregg', 'inside Hregg');
  assert.ok(!sh().dockedTo, 'ship left outside');
});

console.log('— station pads & hull safety —');
ok('landing pad touchdown works with gear down', () => {
  const st = G.world.stations.find(s => s.id === 'hregg');
  const pad = st.pads[0];
  G.player.mode = 'ship'; G.player.interior = null;
  sh().pos = { x: pad.pos.x + pad.normal.x * 4.5, y: pad.pos.y + pad.normal.y * 4.5, z: pad.pos.z + pad.normal.z * 4.5 };
  sh().vel = vadd(surfaceVelocity(st, sh().pos), vscale(pad.normal, -1.5));
  sh().quat = qident(); sh().gearDown = true; sh().dockedTo = null; sh().landedOn = null; sh().anchoredTo = null;
  step(120);
  assert.ok(sh().landedOn && sh().landedOn.id === 'hregg', `landed on hregg (got ${sh().landedOn ? sh().landedOn.id : 'nothing'})`);
  assert.ok(sh().landedPad, 'registered as a pad landing');
  // lift off again
  sh().gearDown = false; G.input.press('KeyR'); step(60);
  assert.ok(!sh().landedOn, 'lifted off from pad');
});
ok('flying over a station does not destroy the ship', () => {
  const st = G.world.stations.find(s => s.id === 'hregg');
  const hull = st.size * 0.55;
  G.player.mode = 'ship';
  sh().pos = { x: st.pos.x, y: st.pos.y, z: st.pos.z + hull + 3 }; // skimming the hull
  sh().vel = { x: st.vel.x + 40, y: st.vel.y, z: st.vel.z };      // grazing pass
  sh().gearDown = false; sh().landedOn = null; sh().dockedTo = null;
  const hull0 = sh().hull;
  step(120);
  assert.ok(sh().hull > 0 && sh().alive !== false, 'still flying');
  assert.ok(hull0 - sh().hull <= 12.01, `hull damage capped (${(hull0 - sh().hull).toFixed(1)})`);
});

console.log('— anchoring —');
ok('mag-anchor rides an asteroid spin', () => {
  const ast = G.world.asteroids.find(a => a.radius > 20 && !a.cave);
  // go back to ship mode first
  G.player.mode = 'ship'; G.player.interior = null;
  sh().pos = { x: ast.pos.x + ast.radius + 15, y: ast.pos.y, z: ast.pos.z };
  sh().vel = { ...ast.vel };
  const p0 = { ...sh().pos };
  G.input.press('KeyK');
  step(1);
  assert.ok(sh().anchoredTo, 'anchored');
  const startAngle = ast.spinAngle;
  step(600);
  const moved = Math.hypot(sh().pos.x - p0.x, sh().pos.y - p0.y, sh().pos.z - p0.z);
  assert.ok(moved > 0.5, `ship rides rock, moved ${moved.toFixed(2)}`);
  G.input.press('KeyK');
  step(1);
  assert.ok(!sh().anchoredTo, 'released');
});

console.log('— interiors —');
ok('station interiors connected, terminals match services', () => {
  for (const st of G.world.stations) {
    const map = interiors.buildStationInterior(st);
    // flood fill from spawn
    const seen = new Set();
    const q = [[Math.floor(map.spawn.x), Math.floor(map.spawn.y)]];
    const walk = (ch) => ch !== '#' && ch !== undefined;
    while (q.length) {
      const [x, y] = q.pop();
      const key = x + ',' + y;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (walk(charAt(map, x + dx, y + dy))) q.push([x + dx, y + dy]);
      }
    }
    assert.ok(seen.has(map.airlocks[0].x + ',' + map.airlocks[0].y), `${st.id} airlock reachable`);
    assert.equal(map.terminals.length, st.services.length, `${st.id} terminals`);
    for (const t of map.terminals) assert.ok(seen.has(t.x + ',' + t.y), `${st.id} terminal reachable`);
  }
});
ok('cave has ore veins and entry', () => {
  const caveAst = G.world.asteroids.find(a => a.cave);
  const map = interiors.buildCave(caveAst.seed, caveAst.caveId);
  assert.ok(map.ores.length >= 3, 'ore veins');
  assert.ok(map.airlocks.length === 1, 'entry airlock');
});
ok('derelict wreck has loot', () => {
  const der = G.world.derelicts[0];
  const map = interiors.buildDerelictInterior(der);
  assert.ok(map.crates.length >= 2 || map.techs.length >= 1, 'loot present');
});

console.log('— EVA / walking / death —');
ok('EVA exit and re-board cycle', () => {
  G.player.mode = 'ship';
  G.input.press('KeyJ');
  step(1);
  assert.equal(G.player.mode, 'eva');
  G.player.eva.pos = { ...sh().pos };
  G.player.eva.vel = { ...sh().vel };
  G.input.press('KeyJ');
  step(1);
  assert.equal(G.player.mode, 'ship');
});
ok('landing on moon then exiting on foot works', () => {
  sh().pos = { x: 610, y: 0, z: 0 }; sh().vel = { x: -1, y: 0, z: 0 };
  sh().gearDown = true; sh().dockedTo = null; sh().anchoredTo = null; sh().landedOn = null;
  sh().hull = sh().maxHull; sh().shield = sh().maxShield;
  G.settings.dampeners = true;
  step(600);
  assert.ok(sh().landedOn === G.world.moon, 'landed');
  game.interact(G); // exit on foot
  assert.equal(G.player.mode, 'walk');
  step(120);
  assert.ok(G.player.foot.attached, 'foot attached to surface');
});
ok('death and insurance respawn', () => {
  G.drones.length = 0; G.projectiles.length = 0;
  G.settings.dampeners = false;
  G.player.mode = 'ship'; G.player.interior = null;
  sh().pos = { x: 30000, y: 30000, z: 30000 }; sh().vel = { x: 0, y: 0, z: 0 };
  sh().dockedTo = null; sh().landedOn = null; sh().anchoredTo = null;
  sh().quat = { x: 0, y: 0, z: 0, w: 1 };
  sh().hull = 5; sh().shield = 0;
  const dr = npc.spawnDrone(G, { x: 30080, y: 30000, z: 30000 }, 'TEST');
  let guard = 0;
  while (G.uiMode !== 'dead' && guard++ < 8000) {
    if (dr && !dr.dead) { dr.pos = { x: 30080, y: 30000, z: 30000 }; dr.vel = { x: 0, y: 0, z: 0 }; }
    game.update(G, 1 / 60); G.input.endFrame();
  }
  assert.equal(G.uiMode, 'dead', 'died');
  G.input.press('Enter');
  step(1);
  assert.equal(G.uiMode, 'play', 'respawned');
  assert.ok(sh().hull > 90, 'hull restored');
  if (dr && !dr.dead) dr.dead = true;
  G.settings.dampeners = true;
});

console.log('— market / caves / wrecks / rescue —');
ok('market sell earns credits', () => {
  const st = G.world.stations.find(s => s.id === 'kolvik');
  const map = G._interiors['st_kolvik'] || (G._interiors['st_kolvik'] = interiors.buildStationInterior(st));
  G.player.mode = 'interior';
  G.player.interior = { map, pos: { x: 18, y: 19 }, prevMode: 'ship' };
  G.player.ship.cargo = { metal: 5, ice: 2 };
  const c0 = G.player.ship.credits;
  const term = map.terminals.find(t => t.kind === 'market');
  G.player.interior.pos = { x: term.x + 0.5, y: term.y + 0.5 };
  G.input.pressed.add('KeyE');
  step(1);
  assert.equal(G.uiMode, 'market', 'market opened');
  G.input.pressed.add('Digit1');
  step(1);
  assert.ok(G.player.ship.credits > c0, 'paid');
  assert.equal(Object.values(G.player.ship.cargo).reduce((a, b) => a + b, 0), 0, 'hold emptied');
  G.player.mode = 'ship'; G.player.interior = null; G.uiMode = 'play';
});
ok('enter cave and exit back to surface', () => {
  const ast = G.world.asteroids.find(a => a.cave);
  G.player.mode = 'walk';
  G.player.ship.landedOn = ast;
  const n = vnorm(vsub({ x: ast.pos.x + 1, y: ast.pos.y, z: ast.pos.z }, ast.pos));
  G.player.foot.pos = { x: ast.pos.x + n.x * (ast.radius + 1), y: ast.pos.y + n.y * (ast.radius + 1), z: ast.pos.z + n.z * (ast.radius + 1) };
  G.player.foot.up = n;
  // stand exactly at the entrance
  const ent = game.caveEntrance(ast);
  G.player.foot.pos = { x: ent.x, y: ent.y, z: ent.z };
  G.input.pressed.add('KeyE');
  step(1);
  const entered = G.player.mode === 'interior';
  assert.ok(entered, 'cave interior entered');
  const map = G.player.interior.map;
  assert.ok(map.ores.length >= 3);
  // walk to airlock tile and exit
  const al = map.airlocks[0];
  G.player.interior.pos = { x: al.x + 0.5, y: al.y + 0.5 };
  G.input.pressed.add('KeyE');
  step(1);
  assert.equal(G.player.mode, 'walk', 'back outside');
  G.player.ship.landedOn = null;
});
ok('derelict boarding and crate loot', () => {
  const der = G.world.derelicts[0];
  G.player.mode = 'walk';
  G.player.foot.pos = { x: der.pos.x + der.radius + 0.8, y: der.pos.y, z: der.pos.z };
  G.player.foot.up = { x: 1, y: 0, z: 0 };
  G.input.pressed.add('KeyE');
  step(1);
  assert.equal(G.player.mode, 'interior', 'boarded wreck');
  const map = G.player.interior.map;
  const crate = map.crates.find(c => !c.looted);
  if (crate) {
    const c0 = G.player.ship.credits;
    G.player.interior.pos = { x: crate.x + 0.5, y: crate.y + 0.5 };
    G.input.pressed.add('KeyE');
    step(1);
    assert.ok(crate.looted && G.player.ship.credits > c0, 'looted');
  }
  const al = map.airlocks[0];
  G.player.interior.pos = { x: al.x + 0.5, y: al.y + 0.5 };
  G.input.pressed.add('KeyE');
  step(1);
  assert.equal(G.player.mode, 'walk');
});
ok('rescue tug when out of fuel', () => {
  G.player.mode = 'ship';
  sh().fuel = 1; sh().credits = 100;
  const stId = (G.lastDock && G.lastDock.id) || 'hregg';
  G.input.pressed.add('KeyB');
  step(1);
  assert.ok(sh().fuel > 5, 'fuel delivered');
  assert.equal(sh().credits, 50, 'fee charged');
});

console.log('— save / load —');
ok('save then applySave restores state', () => {
  sh().credits = 777;
  sh().fuel = 42;
  sh().cargo = { metal: 5 };
  game.saveGame(true);
  assert.ok(store[SAVE_KEY], 'save written');
  sh().credits = 1; sh().fuel = 2; sh().cargo = {};
  game.applySave(JSON.parse(store[SAVE_KEY]));
  assert.equal(sh().credits, 777);
  assert.equal(sh().fuel, 42);
  assert.equal(sh().cargo.metal, 5);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
