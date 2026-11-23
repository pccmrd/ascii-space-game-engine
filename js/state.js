// state.js — shared mutable game state container.
export const G = {
  seed: 'STARFARER-1',
  started: false,
  time: 8 * 3600,        // mission clock (seconds), start 08:00
  day: 1,
  timeScale: 1,
  uiMode: 'title',       // title | play | help | pause | dead | market | scanlog | settings
  prevUiMode: 'play',

  input: null,
  renderer: null,
  hud: null,
  audio: null,

  world: null,
  player: null,
  cam: { x: 0, y: 0, z: 0, mode: 'iso', zoom: 1.0 },  // zoom = multiplier on base px/m

  drones: [],
  projectiles: [],
  particles: [],
  pickups: [],

  target: null,          // current targeted entity
  log: [],
  stats: { mined: 0, kills: 0, earned: 0, deaths: 0, dockedAt: {}, scanned: {} },
  settings: { dampeners: true, iso: true, mute: false },

  paused: false,
  lastDock: null,        // {type:'station'|'interior'|..., id, label}
  deathInfo: null,
};

export const SAVE_KEY = 'starfarer.save.v1';
export const SETTINGS_KEY = 'starfarer.settings.v1';
