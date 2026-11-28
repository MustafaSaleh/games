# Dust Titans

A kid-friendly tank & robot-suit battle game, built on the **Dust Rally** engine (same repository, same style, same multiplayer). You and your friends pilot tanks and giant robot suits to defend famous cities from an alien-machine invasion, team up against waves of drones, robots and giant bosses, or test your skills against each other in arena battles. **Mody (#08)** is the pilot.

**Play:** https://mustafasaleh.github.io/games/dust-titans/ (from phase 1 on)

---

## The game in one minute

- **Story:** alien machines land in Earth's great cities. The Titans (you and your friends) defend them.
- **Play:** drive a tank or walk a robot suit, aim, shoot, dodge, use abilities, grab power-ups.
- **Together or against each other:** co-op against waves and bosses, player-vs-player arenas, and **team battles** (alliances: 2 v 2 with enemy waves in between).
- **For an 8-year-old:** energy blasts, sparks and robots falling apart. No blood, no human enemies. In PvP you get "knocked out" like laser tag and respawn after a few seconds. Real cities are always *defended*, never destroyed: only alien structures, crates and barriers break; landmarks are **inspired by** the real ones and are never damaged (especially religious sites).

## Units

| Unit | Feel | Strengths | Weakness |
|---|---|---|---|
| **Tank** | Tracks, turret aims on its own | Heavy armour, big cannon, pushes enemies, rocks and wrecks aside | Slow to turn, can't jump |
| **Mech** (an original walking robot suit, Mody in the cockpit) | Walks, runs, jump-jets, dash | Climbs anything, punch + arm cannon | Lighter armour |
| **Scout** (bonus: Dust Rally cars with a mini turret) | Fast | Speed, grabs power-ups first | Fragile |

Each unit has a **spec** like Dust Rally cars (armour, speed, weight, turn rate, weapon slots) shown as bars in the Garage, plus liveries and decals.

**Weapons / abilities:** Cannon · Laser beam · Rocket swarm · EMP pulse (stuns robots) · Shield bubble · Jump-jets (mech) · Ram (tank) · **Tomato cannon** (silly mode, a Dust Rally nod).

**Progress:** coins from matches unlock armour, speed, weapons, colours and decals. No real-money purchases, ever.

## Enemies

| Enemy | Behaviour |
|---|---|
| **Drones** | Small flying swarms, keep their distance and shoot slow glowing orbs |
| **Robot walkers** | Patrol in groups, take cover, shoot bursts |
| **Aliens** (glowing jelly-like, not scary) | Fast, dodge shots, try to grab power cores |
| **Giant Robot (boss)** | Huge walking robot with glowing weak points on legs and back; destroy it part by part until it collapses. Needs teamwork |

## Modes

1. **Defend the City** (co-op, 1-4): waves with a boss every few waves.
2. **Arena** (PvP): free-for-all or teams, first to N knockouts, or capture the energy cores.
3. **Alliance battle** (2 v 2): two teams, each fighting the other *and* the enemy waves; helping your ally scores bonus.
4. **Missions** (single player): short objectives (escort a truck across Ghost Bay, destroy an alien tower in Riyadh).
5. **Split-screen**: two players on one device in any of the above.

## Maps

- **From Dust Rally, as arenas:** Desert dunes (first map), Forest, Snow, Redwoods, Ghost Bay (broken bridge, abandoned city).
- **Cairo:** the Nile through the middle, pyramids on the desert edge, minarets on the skyline, market streets, feluccas. Golden hour.
- **Riyadh:** wide boulevards, a tall tower with a "sky bridge" landmark, desert, and huge cliffs ("Edge of the World") for mech jump-jets. Hot afternoon.
- **Dubai:** the tallest tower on Earth at the centre, the sea, a palm-shaped island, highways, dunes. Night map with neon.

## How it's built

The Dust Rally engine is reused directly: terrain + biomes + props + skyline + water, collisions, loose rocks, sparks, particles, cameras (top-down and chase), renderer, Mody, the music engine, audio, settings, online rooms (PeerJS), emojis, the version check, split-screen. The repository is an **npm workspace**: one `node_modules` at the root, so both games share one copy of three.js. Dust Titans imports the engine with the `@engine/...` alias (`dust-rally/src`); Dust Rally itself is unchanged.

New for Dust Titans: combat (health, damage, projectiles, explosions), track-less **arena worlds**, tank and mech controllers, twin-stick aiming (mouse / right stick / touch), enemy AI and waves, bosses, and city maps.

**Online combat:** like the tomato fight in Dust Rally, each player drives their own unit and the room's host runs the enemies and confirms hits, so it stays responsive and fair.

## Roadmap

Each phase ends with something playable and deployed.

- [x] **0. Shared engine:** npm workspace at the repo root, `@engine` alias, CI builds every game; Dust Rally unchanged.
- [x] **1. First playable:** tank in the desert arena (drive, aim, shoot), drones that fight back, explosions, health, waves, score, title screen with Mody.
- [ ] **2. Mech + Garage:** walking robot suit with jump-jets and dash (procedural walk like Mody's animations), Mody climbs in, unit garage with stats and liveries.
- [ ] **3. Enemies + bosses:** robot walkers, aliens, power-ups, first Giant Robot boss with breakable weak points.
- [ ] **4. Co-op multiplayer:** online rooms (up to 4, host runs enemies) and split-screen co-op.
- [ ] **5. PvP + alliances:** arena knockouts/respawn, teams 2 v 2 with enemy waves between, scoreboard, emojis, watching after you're out.
- [ ] **6. Cities:** Cairo, Riyadh, Dubai arena maps (landmark-inspired, never damaged).
- [ ] **7. Polish:** upgrades and coins, missions, more weapons/abilities, battle music themes, effects.

## Mech design: image prompt

Same workflow as Mody: generate a concept sheet, turn it into a 3D model (Meshy), rig it, and drop the GLB in.

```
Create an original, kid-friendly 3D robot suit ("mech") for a family game called Dust Titans.
A two-legged walking robot suit about 4 metres tall, piloted by a boy of about 8 who is visible
inside a glass cockpit canopy on the chest (keep the pilot's face from the attached character
reference). Chunky, rounded, friendly proportions (big feet, sturdy legs, broad shoulders),
not scary, no weapons that look like real guns: the right arm is a glowing energy cannon,
the left arm a big three-finger hand with a round shield.
COLOURS: amber-yellow (#ffb52e) armour with flame-orange (#ff6a3d) panels, cream (#f4f1ea)
stripes, dark grey joints; a "DUST TITANS" logo and the number "08" on the shoulder.
Small jump-jet thrusters on the back glowing orange. Light dust and scratches like it has been in
the desert.
STYLE: stylized 3D, smooth clean shapes, like a premium family animated film or a mobile game
hero. NOT realistic military, NOT a copy of any existing robot, movie or franchise.
OUTPUT: turnaround sheet on a plain light-grey background: front, 3/4, side and back,
full body in a neutral A-pose (arms slightly away from the body), even studio lighting.
```

Then: front A-pose image → Meshy image-to-3D (GLB, about 15-25k triangles, 1024 textures) → auto-rig (humanoid) → upload the GLB like Mody's and it will be optimised and wired in during phase 2.

## Run

```bash
npm install          # once, at the repository root (installs both games)
npm run dev -w dust-titans
npm test -w dust-titans
npm run build -w dust-titans
```

## Controls (phase 1)

| | |
|---|---|
| Keyboard + mouse | W/S drive, A/D turn the hull, mouse aims the turret, click or Space fires, C camera, M music, Esc pause |
| Gamepad | Left stick drive, right stick aim, RT fire |
| Touch | Left thumb: drive joystick. Right thumb: aim joystick (fires while pushed) |
