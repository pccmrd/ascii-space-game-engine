// Headless render smoke test: stubs DOM/canvas, boots main.js, drives frames
// through every UI mode and player mode to catch runtime errors in drawing code.
// Run: node test/render-test.mjs

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
function fakeCanvas() {
  return { width: 1280, height: 800, getContext: () => fakeCtx(), style: {} };
}

const listeners = {};
globalThis.window = {
  innerWidth: 1280, innerHeight: 800,
  addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  AudioContext: undefined, webkitAudioContext: undefined,
};
globalThis.document = {
  readyState: 'complete',
  getElementById: (id) => (id === 'screen' ? fakeCanvas() : { remove() {} }),
  createElement: () => fakeCanvas(),
  addEventListener() {},
};
let rafCb = null;
globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
globalThis.location = { hash: '', reload() {} };

const { G } = await import('../js/state.js');
await import('../js/main.js'); // boots

if (typeof rafCb !== 'function') { console.error('FAIL: no rAF registered'); process.exit(1); }

let t = 0;
let passed = 0, failed = 0;
function frames(n, label) {
  try {
    for (let i = 0; i < n; i++) { t += 16.67; rafCb(t); }
    passed++;
  } catch (e) {
    failed++;
    console.error(`  FAIL frames(${label}) :: ${e.stack.split('\n').slice(0, 4).join(' | ')}`);
  }
}
function key(code) { G.input.pressed.add(code); }

frames(30, 'title');
key('Enter'); frames(5, 'title->play');
console.log('  mode after start:', G.uiMode, G.player.mode);

G.input.keys.add('KeyW'); frames(240, 'flight thrust');
G.input.keys.delete('KeyW');
key('Tab'); frames(3, 'target cycle');
key('Tab'); frames(3, 'target cycle 2');
G.input.keys.add('KeyV'); frames(60, 'scan hold'); G.input.keys.delete('KeyV');
key('Equal'); frames(10, 'zoom in');
key('Minus'); frames(10, 'zoom out');
key('KeyZ'); frames(30, 'top view'); key('KeyZ'); frames(10, 'iso view');
key('Digit3'); frames(30, 'timewarp'); key('Digit2');

// teleport near an asteroid for close-up drawing, target it
const ast = G.world.asteroids.find(a => a.radius > 35);
G.player.ship.pos = { x: ast.pos.x + ast.radius + 90, y: ast.pos.y, z: ast.pos.z };
G.player.ship.vel = { ...ast.vel };
G.target = ast;
frames(60, 'asteroid closeup');

// dock prompt drawing near station port
const st = G.world.stations[1];
const port = st.ports[0];
G.player.ship.pos = { x: port.pos.x + 10, y: port.pos.y, z: port.pos.z };
G.player.ship.vel = { ...st.vel };
frames(40, 'dock approach');

// EVA
G.player.ship.pos = { x: 3000, y: 3000, z: 3000 }; G.player.ship.vel = { x: 0, y: 0, z: 0 };
key('KeyJ'); frames(120, 'EVA');
// walk on moon
G.player.mode = 'walk';
G.player.foot.pos = { x: 602, y: 0, z: 0 };
G.player.foot.up = { x: 1, y: 0, z: 0 };
G.player.foot.vel = { x: 0, y: 0, z: 0 };
G.player.foot.attached = true;
frames(120, 'moon walk');
// interior
const interiorsMod = await import('../js/interiors.js');
G.player.mode = 'interior';
G.player.interior = { map: interiorsMod.buildStationInterior(G.world.stations[0]), pos: { x: 18, y: 19 }, prevMode: 'ship' };
frames(120, 'station interior');
// market overlay
G.market = { station: G.world.stations[1], kind: 'market', prices: { metal: 12, ice: 8, rock: 5, carbon: 15 } };
G.uiMode = 'market'; frames(10, 'market'); G.uiMode = 'play';

// help & pause overlays
G.uiMode = 'help'; frames(5, 'help'); G.uiMode = 'play';
G.uiMode = 'pause'; frames(5, 'pause'); G.uiMode = 'play';

// combat fx
const npcMod = await import('../js/npc.js');
npcMod.spawnDrone(G, { x: G.player.ship.pos.x + 60, y: G.player.ship.pos.y, z: G.player.ship.pos.z }, 'X');
G.player.mode = 'ship';
G.input.mouse.down = true;
frames(120, 'combat');
G.input.mouse.down = false;

// death screen
G.player.ship.hull = 0;
frames(3, 'death');
G.uiMode = 'dead'; frames(5, 'death screen');
key('Enter'); frames(10, 'respawn');

// save + reload path
G.player.ship.credits = 999;
const gameMod = await import('../js/game.js');
gameMod.saveGame(true);
frames(10, 'post-save');

console.log(`\n${passed} frame-batches passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
