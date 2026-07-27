# Wobble Rush 3D

Wobble Rush 3D is an original procedural obstacle racer built with Three.js, plain browser modules, Node.js, and WebSockets. The same deterministic course runs in solo mode and in online parties of up to 16 players.

## What is in version 2

- Deterministic procedural courses assembled from sweepers, moving sky steps, bumper alleys, narrow bridges, punchers, spring gardens, windmills, and a final victory climb.
- Camera-relative arcade movement, coyote time, jump buffering, dive recovery, moving-platform carry, obstacle impulses, checkpoints, and fast respawns.
- A multipart animated runner with independent limbs, visor, antenna, run/jump/dive poses, landing squash, and network nameplates.
- Touch-first controls with a floating joystick, large action buttons, swipe-to-orbit camera, auto-follow, and one-tap camera recentering.
- Daily and remixed solo courses, three difficulty levels, medal targets, respawn stats, and per-course personal bests.
- Server-owned room seed and difficulty, server-derived checkpoints, movement validation and reconciliation, authoritative respawns and finish order, batched snapshots, ping display, heartbeat cleanup, rematch voting, and host migration.
- Adaptive render quality, reduced mobile pixel ratio/shadows, capped particles, safe-area-aware responsive UI, and portrait/landscape layouts.

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm start
```

Open `http://localhost:3000`. To test multiplayer, open a second browser or device on the same address, create a party, join with the four-letter room code, ready both runners, and start from the host.

The client uses the current page origin for `/ws`. A separate socket host can be supplied before `main.js` loads:

```html
<script>window.WOBBLE_WS_URL = "wss://your-socket-host.example/ws";</script>
```

## Controls

- Desktop: WASD or arrow keys to move, Space to jump, Shift to dive, mouse drag (or Q/E) to orbit, R to recenter.
- Touch: drag the left joystick, use Jump and Dive at lower right, swipe the open right side of the game view to orbit, and tap the crosshair button to recenter.

## Test

```bash
npm test
npm run check
```

The suite covers international name sanitization, deterministic course rules, server-side checkpoint/finish validation, teleport rejection, and a real two-client WebSocket lobby/start flow.

## Deploy on Render

1. Push the repository to GitHub and create a Render Blueprint from it.
2. Render reads `render.yaml`, runs `npm ci --omit=dev`, and starts one Node Web Service. That service serves both the client and `/ws`, so a separate CORS setup is not needed.
3. `PORT` is assigned by Render. `NODE_ENV=production` and Node 20 are declared in the Blueprint.
4. Wait for `/health` to report `{"ok":true,...}` and open the HTTPS service URL.
5. Test one desktop window plus a phone, or two devices, on the live URL. A sleeping free-tier service may take several seconds to wake; the multiplayer panel shows a connecting state and queues the first create/join request.

For mobile QA, test at least one narrow portrait viewport and one short landscape viewport. Verify that the HUD stays above the action area and all controls remain inside device safe-area insets.
