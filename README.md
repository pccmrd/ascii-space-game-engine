# STARFARER — ascii-space-game-engine

A high-detail **ASCII 4X space engine** that runs in your browser: Newtonian flight,
manual docking & landing, EVA, magnetic-boot surface walking, station interiors,
caves, wreck scavenging, mining, scanning and belt combat — one moon, five orbital
stations, an asteroid/comet belt, and a gas giant on the skyline.

Everything is rendered as characters on a canvas: shaded celestial discs, wireframe
rotating stations, spinning asteroids, terrain grids, particles, radar, and a full
box-drawn HUD. No dependencies, no build step.

## Run it

Any static file server works:

```bash
cd ascii-space-game-engine
python3 -m http.server 8000        # or: npm run serve
# open http://localhost:8000
```

Optional seed in the URL hash: `http://localhost:8000/#SEED=MY-SEED`

## The loop

**Scan the belt [V] → mag-anchor to a rock [K] → mine ore [C] → haul it to
KOLVIK REFINERY or HREGG'S GATE → get paid.** Rich rocks attract RED JACKAL
drone patrols. Derelicts hide crates and tech. Some big rocks have caves.

## Controls

| Context | Keys |
| --- | --- |
| Flight | `W/S` main/retro · `R/F` vertical · `A/D` lateral · arrows pitch/yaw · `Q/E` roll · `SHIFT` boost |
| Flight systems | `X` brake · `G` flight-assist on/off (Newtonian drift) · `L` landing gear |
| Combat / tools | `SPACE`/click lasers · `TAB` target · `V` (hold) scan · `C` mining beam |
| Docking | approach a blinking port `< 26 m` at `< 5 m/s` relative → `F` dock · `U` undock |
| Anchoring | near a rock's surface → `K` mag-anchor (rides the spin) · `K` again release |
| EVA / surface | `J` exit/board ship · `WASD+RF` jets · `M` magnetic boots · `SPACE` jump |
| Interiors | `F` airlock / terminal / loot · walk with `WASD` |
| View / time | `Z` isometric↔top-down · `+/−` zoom · `1/2/3` time ×0.25/×1/×4 |
| System | `H` manual · `ESC/P` pause · `N` mute · `U` save · `B` rescue tug (fuel < 5%) |

## Physics model

* Full Newtonian integration (semi-implicit Euler, fixed 60 Hz timestep).
* Keplerian circular orbits for stations/belt/derelicts; analytic comet (Newton-solved Kepler equation).
* Two-body gravity (moon + distant gas giant) with sphere-of-influence-style falloff.
* Rotating reference frames: docking ports ride station rotation; anchored ships ride
  asteroid spin; walking uses body-local velocities so you can stand on a tumbling rock.
* Landing: gear down + closure < 3.5 m/s = touchdown; harder hits bounce and damage hull.

## Repository layout

```
index.html          shell
style.css           CRT frame: scanlines + vignette
js/core.js          vec3/quaternion math, seeded RNG, formatting
js/state.js         shared game state container
js/world.js         procedural Kveld system generation (seeded)
js/physics.js       gravity, surface queries, projectiles, particles
js/player.js        SHIP / EVA / WALK / INTERIOR mode controllers
js/interiors.js     station/cave/derelict tile-map builders
js/npc.js           pirate drone AI
js/renderer.js      ASCII cell buffer -> canvas (iso + top projections)
js/hud.js           HUD panels, radar, interior view, menus
js/game.js          rules: docking, anchoring, scan/mine/loot, market, save/load
js/main.js          boot + main loop
test/sim-test.mjs   headless logic tests        (node test/sim-test.mjs)
test/render-test.mjs headless render smoke test (node test/render-test.mjs)
test/frame-dump.mjs print a rendered frame      (node test/frame-dump.mjs orbit)
```

## Tests

```bash
node test/sim-test.mjs     # 25 gameplay/logic checks
node test/render-test.mjs  # boots the real UI against a DOM stub, drives every mode
```

Progress auto-saves to localStorage every 25 s; `U` saves manually.
