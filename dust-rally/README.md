# Dust Rally

**Play:** https://mustafasaleh.github.io/games/dust-rally/

A lightweight, mobile-first, top-down rally game for the browser. Vite + TypeScript + Three.js, no physics engine, no model files: every mesh is built procedurally. Production bundle: ~160 KB gzipped JS plus a few KB of CSS and icons.

- **Stages**: hand-designed point-to-point tracks (JSON), with checkpoints, splits against your best, a best time and a ghost of your best run. Five stages: Forest Ridge, Dune Run, Frost Line (night), **Redwood Pass** (giant redwoods, big climbs, snowy mountain ranges on the horizon) and **Ghost Bay**: an abandoned city overgrown with grass, wrecked cars and barriers on the road, and a broken red suspension bridge over the bay: hit the ramp fast and fly the gap, or splash into the water and restart on the bridge.
- **Endless**: an infinite seeded procedural road. Biomes blend from one to the next, and difficulty rises with distance. Gates add time to a countdown. Your score is the distance driven, and the run can be replayed or shared by seed.
- **Daily Challenge**: Endless with a seed derived from today's UTC date, so everyone gets the same road.
- **Multiplayer**: split-screen for two players on one device, or online races for 2–4 friends in a private room.

## Run, build, deploy

```bash
npm install
npm run dev        # http://localhost:5173 (also exposed on your LAN for phone testing)
npm test           # physics + track sanity tests (vitest)
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/ locally
```

`dist/` is fully static, so you can deploy it to any static host: GitHub Pages, Netlify, Cloudflare Pages, S3 or nginx. `base` is `./`, so it also works from a sub-folder.

- **Netlify / Cloudflare Pages**: build command `npm run build`, output directory `dist`.
- **GitHub Pages**: push the contents of `dist/` to the `gh-pages` branch, or use the `actions/upload-pages-artifact` workflow.
- Serve over **HTTPS**. Service workers, tilt steering (iOS) and installability all require it.

### PWA / offline
The build writes `dist/sw.js` with a precache list of every built file (see `vite.config.ts` and `src/sw-template.js`). After the first load the game works offline and can be installed from the browser menu ("Add to Home Screen"). Each build changes the cache version, and old caches are deleted when the new worker activates.

## Garage

**Garage** in the main menu: choose one of five cars and one of 10 colour liveries. Cars drive differently (`spec` in `src/config/cars.ts`: power, top speed, weight, tarmac grip, off-road grip, steering; the Garage shows them as bars):

| Car | Character |
|---|---|
| Hatch | all-rounder (reference) |
| Coupe | fast and planted on tarmac, slippery on dirt |
| Raid | heavy truck: slower, great off-road, shoves other cars and rocks aside |
| Roadster | open-top two-seater: light, quick, sharp on tarmac |
| Buggy | two-seat dune buggy with a roll cage: quickest off the line, loves sand and dirt, easy to bump around |

Weight matters in car crashes (impulse by both masses) and when knocking rocks. The colour is cosmetic. The car is shown on a turntable that slowly spins; drag it to see it from every side (360°). The choice is saved, used in every mode, and purely cosmetic: all cars handle the same.

- Add a livery: append `{ id, name, body, stripe, roof }` to `CAR_LIVERIES` in `src/config/cars.ts`.
- Add a body style: add it to `CAR_STYLES` (`src/config/cars.ts`), write a builder function next to `hatch`/`coupe`/`truck` in `src/render/models.ts`, and give it wheel dimensions in `WHEELS`.

## Multiplayer

**Multiplayer** in the main menu has two modes. Both race the hand-made stages; first across the line wins. Cars collide: they bounce off each other, get pushed and spun by side hits, and throw sparks (`resolveCarCar` in `physics/collisions.ts`; sparks in `render/effects.ts`). In split-screen both cars are simulated together; online, each device moves only its own car off the other players' (interpolated) cars, so both sides feel the bump.

### Tomato fight 🍅

In both multiplayer modes, the first racer through each checkpoint earns a tomato (up to 3, shown in the HUD). Throw it back at whoever is chasing you: **F** (P1), **/** or **Right Ctrl** (P2), gamepad **LB**, or the 🍅 touch button. The throw aims at the nearest car behind and leads it; with nobody behind, it just flies back and splats on the road. A hit covers the victim's view (only their half in split-screen) with tomato until an automatic squeegee wipes it clean. Online, the host decides who was first through a checkpoint, and each player's own device decides whether a tomato hit them. Code: `src/core/tomatoes.ts`, `src/ui/splat.ts`; tuning in `TOMATO`.

### Split-screen (one device)

Two views side by side (stacked on a tall screen). Player 2 gets a different colour automatically.

| | Player 1 | Player 2 |
|---|---|---|
| Keyboard | WASD, Space = drift, R = reset | Arrow keys, Right Shift = drift, Enter = reset |
| Gamepad | first connected pad | second connected pad |

When one player finishes, the other has 30 seconds to cross the line (otherwise DNF).

### Online (each player on their own device)

1. One player taps **Create a room** and gets a code like `TIGER-42`, plus a **Copy invite link** button (`…/dust-rally/?room=TIGER-42`).
2. Friends type the code (or open the link) and tap **Join**. Up to 4 racers per room.
3. The host picks the stage and taps **Start race!** Everyone starts together, sees the others' cars with name tags and a live position (1st of 3), and gets a shared results table. The host can start another race or change the stage; anyone can change their car in the room's Garage button.

How it works: the game stays a static site on GitHub Pages. Browsers connect directly to each other over WebRTC using [PeerJS](https://peerjs.com/). PeerJS's free public server only introduces the players (the room code is the host's peer id), and its TURN relay helps when a direct connection isn't possible. The host relays positions (15 per second) to everyone else. Code: `src/net/transport.ts` (PeerJS and a local test transport), `src/net/session.ts` (room protocol), `src/core/racers.ts` (split-screen player 2, remote cars).

**Emojis**: instead of chat, players can send one of eight fixed emojis (👍 👋 😂 😮 🔥 🏁 🍅 😎): in the room, from the 😀 button or keys 1–8 during a race (they pop up above the sender's car), and on the results screen. The host passes them on and limits how often each player can send one.

**Room screen**: players with their car, a "Your car" card (Change opens the Garage), and stage tiles the host taps to choose.

Kid-safe by design: private rooms only, no public lobby, no typed chat (emojis only), names up to 12 characters.

Limitations: it depends on the public PeerJS server being up; some strict school or office networks block WebRTC; the room closes if the host leaves.

Every player must run the same build: the online screen shows the game version, and a friend on a different version is turned away with "reload the page" instead of failing silently.

For development, add `?net=local` to use a BroadcastChannel transport instead of PeerJS: open two tabs of the same browser, create a room in one and join it from the other.

## Music

The game makes its own background music with Web Audio: nothing is downloaded. Four tunes: **Sunny Garage** (menus), **Dust Devil** (desert), **Turbo Hatch** (forest) and **Night Frost** (snow). With **Track: Auto** the menu plays Sunny Garage and each stage plays its own tune; pick a track in Settings to hear it everywhere. Settings → Music has on/off and volume (separate from sound effects); there is also a 🎵 button on the home screen and in the race HUD, and the **M** key. Code: `src/core/music.ts` (each track is a short description: tempo, key, chords, drum patterns; the melody is generated from a seed).

## Controls

| | |
|---|---|
| Keyboard | WASD / arrows; Space = handbrake; R = reset car onto the road; C = switch camera; M = music on/off; F = throw a tomato (multiplayer); Esc / P = pause |
| Gamepad | Left stick steers; RT / A = gas; LT / X = brake/reverse; B / RB = handbrake; Y = reset; Back = switch camera; Start = pause |
| Touch | Left thumb: floating joystick (or ◀ ▶ zones). Right side: GAS, BRAKE (hold to reverse), DRIFT (handbrake) |
| Tilt | Settings → Steering → Tilt. On iOS this asks for motion permission. Calibrated level when a race starts |

**Camera**: the classic high top-down view, or a third-person **chase** view behind the car. Switch with C, the gamepad Back button, the 🎥 button in the race HUD, or Settings → Camera (the choice is saved). In chase view the terrain streams further ahead and the fog is pulled in so the edge of the world stays hidden. Tuning: `CHASE` in `src/render/camera.ts`.

**Settings** are grouped in three tabs: Controls (with a keyboard shortcut list), Graphics (camera, quality, time of day, art style) and Sound & Music.

**Phones and tablets**: page zoom is blocked (pinch, double tap, and iOS's automatic zoom into small text fields), because iOS ignores `user-scalable=no`.

Sound stays muted until your first tap or key press, because browsers block audio autoplay. Haptics use `navigator.vibrate` where it is supported (Android).

## Project layout

```
src/
  config/     all tunables: handling, surfaces, biomes/palettes, lighting, quality, game rules
  core/       game orchestrator, fixed-step loop, input, audio, race rules, ghost, rng/noise, settings, racers (multiplayer cars)
  net/        online rooms: PeerJS / local transports, room protocol
  physics/    arcade car model, circle collisions
  world/      track spline, terrain shape + carving, chunk streaming, props, stage + endless generators
  render/     renderer/lights/dynamic resolution, follow camera, procedural models, effects, gates
  ui/         menus, HUD, minimap, touch controls, CSS
  tracks/     *.json stages (every file here is picked up automatically)
tests/        vitest: physics behaviour, track validity, online room protocol
```

### How it fits together
- **Loop** (`core/loop.ts`): physics runs at a fixed 60 Hz. Rendering runs at display rate and interpolates between steps. The loop pauses when the page is hidden (`visibilitychange`).
- **Terrain** (`world/world.ts`, `world/terrain.ts`): seeded simplex fBm, with ridged dunes in the desert. The road spline carves a flat (banked) bed into it and blends back into the natural slope through a shoulder that widens with the height difference. The world is cut into 64 m chunks with a 1.6 m grid. Chunks are pooled. Each chunk is generated by a *generator function* that the scheduler advances in slices up to a per-frame millisecond budget, so a new chunk never causes a stutter. Vertex colours bake in the palette, patches, valley/ridge tint, steep-cut colour, road and a curvature-based AO term. Lighting is one hemisphere light plus one directional light, with no shadow maps.
- **Physics** (`physics/car.ts`): heading plus world velocity. Sideways velocity decays with surface grip, and grip drops once the car is sliding, so drifts hold. Yaw follows a kinematic bicycle target that is capped by grip, so full lock at speed gives a slide instead of a spin. Gravity is projected onto the terrain normal. The car snaps to the ground unless its ballistic path is above it, which is what produces airtime over crests. Height and normal come from bilinear sampling of the chunk heightmap; there are no raycasts.
- **Collisions**: trees, rocks and cacti are circles stored in an 8 m grid inside each chunk. The car is two circles. You can jump over low rocks.
- **Loose rocks** (`world/rocks.ts`): small and medium rocks (scale ≤ 1.2, `LOOSE_ROCK_MAX`) aren't solid. When a car touches one it is lifted out of the static scenery and becomes a live body: knocked away by an impulse that depends on both masses (a 1 m rock is ~190 kg against the 1100 kg car, so the car loses a little speed), slightly sideways so it leaves your path, then it flies, bounces, rolls, bumps off trees and settles. Big boulders stay solid. Online players' cars push rocks on your screen too; knocked rocks don't reappear when their chunk is rebuilt.
- **Props** (`world/props.ts`): one `InstancedMesh` per prop type for the whole world. Each chunk prebuilds its instance matrices. When the set of visible chunks changes (per-chunk frustum test), they are copied into the instance buffers.
- **Endless** (`world/endless.ts`): the road is a mean-reverting random walk of curvature, so it never loops back on itself. It is generated about 900 m ahead and discarded about 700 m behind, so memory stays flat.

## Tuning values

Everything is in `src/config/`:

| File | What to tweak |
|---|---|
| `handling.ts` | `engineAccel`, `topSpeed`, `maxSteer`, `steerSpeedFalloff` (steering at speed), `maxLatAccel` (cornering limit), `lateralGrip`, `slideGrip`/`slideAngle` (how drifts hold), `driftYawBoost`, `counterSteerAssist`, `handbrakeGrip`/`handbrakeYaw`, `slopeGravity`, `airGravity`, `landingSpeedLoss`, suspension and body roll, collision `restitution` |
| `surfaces.ts` | per surface: `grip`, `traction`, `rollDrag` (sand/mud bog down), `dust`, `mark`, `skid` |
| `biomes.ts` | palettes, terrain amplitudes, off-road surface and patch surface, endless road surfaces, prop rules (density, clustering, scale, gap from road), `MONOCHROME_PALETTE`, endless `BIOME_SPAN` and `BIOME_BLEND` |
| `lighting.ts` | day/dusk/night light colours and intensities, fog tint and distance, headlight strength, vignette; endless day/night cycle |
| `game.ts` | endless start time, gate spacing and bonus, difficulty distance, road width, curvature, jumps, rolls, hard-surface chance, roadside obstacles; stage defaults; banking |
| `quality.ts` | per-quality DPR cap and steps, view radius, prop density, particle and tire-mark pools, chunk-generation budget; dynamic-resolution thresholds; chunk size and resolution, shoulder blending |
| `render/camera.ts` (`CAMERA`) | FOV, pitch, distance, speed zoom, look-ahead, smoothing |
| `render/effects.ts` (`HEADLIGHT`) | headlight cone length, spread, colour, intensity |

`npm test` prints a handling report (0–100 km/h time, top speed, cornering radius and slip per surface, airtime over a crest). Re-run it after tuning.

## Add a new track

1. Create `src/tracks/my-track.json`:

```json
{
  "id": "my-track",
  "name": "My Track",
  "description": "Shown on the stage card.",
  "biome": "forest",
  "timeOfDay": "day",
  "seed": 4242,
  "width": 9,
  "checkpoints": 5,
  "rolls": 1.5,
  "elevation": 1,
  "bank": 1,
  "propDensity": 1,
  "points": [[0,0],[0,120],[60,240],[0,360]],
  "surfaces": [{ "from": 0, "to": 400, "type": "gravel" }, { "from": 400, "to": 9999, "type": "ice" }],
  "jumps": [{ "at": 200, "height": 2.5, "length": 24 }]
}
```

   - `points`: control points in metres on the XZ plane. A centripetal Catmull-Rom spline runs through them. +Z is "up" on screen. Keep separate parts of the road at least ~30 m apart.
   - `biome`: `forest`, `desert`, `snow` or `savanna`. `timeOfDay`: `day`, `dusk` or `night`.
   - `surfaces`: zones in metres along the track (`tarmac`, `gravel`, `dirt`, `sand`, `snow`, `ice`, `mud`, `grass`). Without zones, the biome's first road surface is used.
   - `jumps`: kicker ramps at a distance in metres. `rolls` is the amplitude of crests and dips. `elevation` scales the hills. `bank` scales the automatic banking in corners.
   - `seed` drives the terrain noise and prop placement.
2. Add the id to `order` in `src/main.ts` if you want a specific position in the list. Otherwise it is listed after the built-in stages.
3. `npm test` checks every stage for self-overlap and prints its length and checkpoint positions. Add your file to `tests/tracks.test.ts` to include it.
4. Quick look: `npm run dev`, then open `/?stage=my-track&autopilot`.

## Add a new biome palette

1. In `src/config/biomes.ts`, add a `BiomeDef` with:
   - `palette`: ground colours (`ground`, `groundAlt`, `groundLow`, `groundHigh`, `steep`), one colour per road surface, prop colours and `fog`.
   - `offroad`, `patch` and `patchAmount`: the off-road surface and the patches mixed into it.
   - `roadSurfaces`: endless-mode surfaces, easy to hard.
   - `terrain`: hill, mid, rough and dune amplitudes.
   - `props`: rules from the existing prop types `pine`, `round`, `rock`, `pebble`, `bush`, `shrub`, `cactus`, `redwood` (giant tree with its own bark/leaf colours).
   - optional `skyline`: rock, far-rock and snow colours for distant mountain ranges on the horizon (`render/skyline.ts`, visible in the chase camera).
2. Add it to `BIOMES` (stages can then use it by id) and to `BIOME_LIST` if endless mode should include it in its biome rotation automatically, and stages can use it by id.
3. Optional: add a `.card.biome-<id>` gradient in `src/ui/styles.css` for the stage card.

Stages can also have a **bay** (a capsule of water the terrain drops into), a **bridge** (`from`/`to` metres along the road: the deck is raised by `lift`, stands without embankments, has `towers` and an optional broken `gap` with no road) and **obstacles** (`wreck` / `barrier` at a distance along the road and a lateral position). See `src/tracks/city.json`; the bridge look is built in `src/render/bridge.ts`. Falling below the water level splashes and puts the car back on the road before the gap (`World.safeRespawn`).

New prop *shapes* go in `render/models.ts` (`propGeometry`, `PROP_COLLIDER`, `PROP_TYPES`) and `world/props.ts` (`CAPACITY`).

## Debug URL parameters

| Parameter | Effect |
|---|---|
| `?stage=<id>` | start a stage directly |
| `?mode=endless&seed=ABC12` | start an endless run with a seed (this is the format share links use) |
| `?mode=daily` | start today's daily challenge |
| `&autopilot` | a simple AI drives (used for soak and perf tests) |
| `&timescale=4` | run the simulation faster |
| `&notimer` | endless: the countdown never runs out |
| `&tod=day\|dusk\|night`, `&art=mono\|color` | temporary lighting / art-style override |
| `?room=TIGER-42` | open the online screen with this room code filled in (invite links) |
| `&net=local` | online mode between tabs of one browser (no internet needed) |

Settings → Show FPS displays fps, the current dynamic-resolution DPR and the number of instanced props.

## Performance notes
- DPR is capped at 2, and lower on lower presets. Dynamic resolution steps down (for example 2 → 1.5 → 1 → 0.75) when the average fps falls below 48, and steps back up after 6 s above 58.
- There are no real-time shadows. The car has a draped blob shadow, and the headlight is an additive gradient mesh draped on the terrain.
- A typical frame is about 25 draw calls and 30k triangles.
- The game loop does not allocate per frame. Vectors, chunks, particles, tire marks and gate meshes are all pooled or reused.
