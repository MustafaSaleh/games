# Games

A collection of browser games, hosted on GitHub Pages.

**Play:** https://mustafasaleh.github.io/games/

| Game | Play | Source |
|---|---|---|
| Dust Rally — top-down rally: stages, endless procedural roads, daily challenge, split-screen and online multiplayer | [Play](https://mustafasaleh.github.io/games/dust-rally/) | [`dust-rally/`](dust-rally/) |
| Dust Titans — tank and robot-suit battles: drone waves (phase 1), co-op, alliances and city maps planned | [Play](https://mustafasaleh.github.io/games/dust-titans/) | [`dust-titans/`](dust-titans/) |

## How it works

Each game lives in its own folder with its own `package.json`. The repository is an **npm workspace** (root `package.json`): run `npm install` once at the root and every game shares one `node_modules` (one copy of three.js). Dust Titans reuses the Dust Rally engine through the `@engine/...` alias.

On every push to `main`, the workflow in `.github/workflows/pages.yml`:

1. runs `npm ci` at the root, then builds every top-level folder that has a `package.json` (`npm test` if present, `npm run build`),
2. copies each game's `dist/` to `<folder-name>/` on the site,
3. publishes the landing page `index.html` at the root.

So a game in `my-game/` is served at `https://mustafasaleh.github.io/games/my-game/`.

## Adding a new game

1. Create a folder, e.g. `my-game/`, with a `package.json` whose `build` script outputs to `dist/`, and add it to `workspaces` in the root `package.json`.
2. Use **relative asset paths**, because the game is served from a sub-folder. With Vite: `base: './'` in `vite.config.ts`.
3. Add a card for it in the root `index.html` and a row in the table above.
4. Push to `main`. The game is live a couple of minutes later.

## One-time setup

Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
