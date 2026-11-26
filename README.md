# Games

A collection of browser games, hosted on GitHub Pages.

**Play:** https://mustafasaleh.github.io/games/

| Game | Play | Source |
|---|---|---|
| Dust Rally — top-down rally: stages, endless procedural roads, daily challenge | [Play](https://mustafasaleh.github.io/games/dust-rally/) | [`dust-rally/`](dust-rally/) |

## How it works

Each game lives in its own folder with its own `package.json`. On every push to `main`, the workflow in `.github/workflows/pages.yml`:

1. builds every top-level folder that has a `package.json` (`npm ci`, `npm test` if present, `npm run build`),
2. copies each game's `dist/` to `<folder-name>/` on the site,
3. publishes the landing page `index.html` at the root.

So a game in `my-game/` is served at `https://mustafasaleh.github.io/games/my-game/`.

## Adding a new game

1. Create a folder, e.g. `my-game/`, with a `package.json` whose `build` script outputs to `dist/`.
2. Use **relative asset paths**, because the game is served from a sub-folder. With Vite: `base: './'` in `vite.config.ts`.
3. Add a card for it in the root `index.html` and a row in the table above.
4. Push to `main`. The game is live a couple of minutes later.

## One-time setup

Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
