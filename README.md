# Pixel Realm

A tiny real-time multiplayer 2D sandbox that runs in the browser. Players
enter a name and pick a color, then walk around an open pixel-art world
(WASD or arrow keys) and see everyone else who's currently connected,
moving in real time. Includes simple chat.

Everything is self-contained: a Node.js/Express + Socket.io backend, and a
vanilla HTML5 canvas frontend (no build step, no framework). The tileset
and character sprites are procedurally generated (see `tools/gen_assets.py`)
so there are no external art dependencies or licensing concerns.

## Run it locally

```bash
npm install
npm start
```

Then open http://localhost:3000 in a couple of browser tabs/windows (or
share your local IP on a LAN) to see multiple players at once.

Requires Node.js 18+.

## Project structure

```
server/
  index.js     Express + Socket.io server, authoritative game loop
  map.js       Procedural tile map + collision grid generation
public/
  index.html   Login screen + canvas markup
  js/game.js   Client: rendering, input, prediction, networking
  assets/      Generated tileset.png + char_<color>.png spritesheets
tools/
  gen_assets.py         Regenerates the pixel art (requires Pillow)
  test_multiplayer.js   Headless Socket.io test (two simulated clients)
  visual_test.js        Playwright test: loads the page, logs in, screenshots
```

## How it works

- **Login**: name + color only, no passwords. The server assigns a socket
  id and spawns the player near the plaza in the middle of the map.
- **Movement**: the client predicts its own movement locally for instant
  response, while the server runs the authoritative simulation at 20 ticks/sec
  and broadcasts everyone's position. Remote players are smoothed with simple
  interpolation. The local player is gently reconciled toward the server's
  position to prevent drift.
- **World**: a single shared 60x42 tile map, generated once when the server
  starts (deterministic seed), with a lake, a dirt path, a fenced spawn
  plaza, and scattered trees/rocks that block movement.
- **Chat**: press Enter to open the chat box; messages are broadcast to all
  connected players.

## Deploying so others can play

This needs a host that keeps a persistent Node.js process running (for the
WebSocket connection) — a plain static host (like GitHub Pages) won't work.
Good free-tier options:

- **Render** (render.com): "New +" → "Web Service" → point it at this
  repo/folder → build command `npm install`, start command `npm start`.
- **Railway** (railway.app): `railway init` then `railway up` from this
  folder, or connect a repo from the dashboard.
- **Fly.io**: `fly launch` from this folder (it auto-detects Node).

Any of these auto-detect the `PORT` environment variable, which the server
already reads (`process.env.PORT`), so no code changes are needed.

## Regenerating art

```bash
pip install pillow --break-system-packages
python3 tools/gen_assets.py
```

This rewrites everything in `public/assets/`.
