# Warbot model

| File | What it is |
|---|---|
| `warbot-reference.jpg` | Gemini design image used for Meshy image-to-3D. Reuse it as the reference for new Warbot art. |
| `source/warbot-rigged-mixamo.glb` | Meshy output: rigged (Mixamo skeleton) with `Idle_02`, `Walking`, `Running`, `Charged_Ground_Slam`, 6.7 MB |

The game loads `public/models/warbot.glb` (0.96 MB), built with the Mody script:

```
node ../../dust-rally/art/optimize-model.mjs source/warbot-rigged-mixamo.glb ../public/models/warbot.glb
```

(install its packages in a scratch folder first; see the comment at the top of the script).

In code: `src/units/warbotModel.ts` loads it once and makes a skinned clone per Warbot;
`WarbotView` in `src/units/views.ts` blends idle / walk / run by speed, plays the slam clip so
its hit lands when the unit's wind-up ends (`SLAM_IMPACT`), holds the gatling level
(`GUN_PITCH`) and twists the spine toward the aim. The built-in box model shows until the GLB has
loaded, or if it fails. The gun muzzle position lives in `WARBOT` (`src/units/warbot.ts`).
