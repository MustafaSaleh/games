# Mody, the Dust Rally driver

Mody (#08) is the game's driver character. He appears in the main menu and on the results screen.

| File | What it is |
|---|---|
| `mody-turnaround.jpg`, `mody-a-pose.jpg`, `mody-portrait.jpg` | Design references. Reuse these as the reference image for any new art, so he stays on-model. |
| `source/mody-rigged-mixamo.glb` | Rigged source model (Mixamo-style skeleton, `Running` + `Walking` clips), 4.5 MB |
| `source/mody-a-pose-unrigged.glb` | Original unrigged image-to-3D output, 21 MB |
| `optimize-model.mjs` | Script that builds `public/models/mody.glb` (0.58 MB) from the rigged source |

The game only loads `public/models/mody.glb`. Nothing in `art/` is shipped.

## In code

`src/render/character.ts` contains `CharacterView`, a small self-contained 3D view you can put in any element:

```ts
const mody = new CharacterView(someDiv); // own transparent canvas; loads the model lazily
mody.setActive(true);                    // renders only while active and the tab is visible
mody.playIntro();                        // runs in from the side, turns, waves
mody.play('wave');                       // 'idle' | 'wave' | 'cheer'
```

Idle, wave and cheer are procedural poses applied on top of the rest pose, so they work on any Mixamo-rigged model. To add a real animation clip, export it with the same skeleton, merge it into the GLB, and play it through the `AnimationMixer` the same way `Running` is played.
