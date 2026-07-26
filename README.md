# Wobble Rush 3D

An original, lightweight browser obstacle race for keyboard and touch. Race solo against the clock or create a WebSocket room for up to 16 players.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. Open a second browser window/device on the same URL to test a multiplayer room. The client derives its `ws://` or `wss://` endpoint from the page URL; deployments needing a separate socket host can set `window.WOBBLE_WS_URL` before `main.js` loads.

## Deploy on Render

1. Push this repository to GitHub or GitLab and choose **New → Blueprint** in Render.
2. Select the repository. `render.yaml` creates one free Node Web Service which serves both the static client and `/ws` WebSocket endpoint, so no CORS configuration is required.
3. Deploy and wait for the health check. `PORT` is supplied automatically by Render; `NODE_ENV=production` is configured in the Blueprint.
4. Visit the generated HTTPS URL on desktop and mobile. The first multiplayer connection after idle may take a few seconds while the free service wakes; the lobby displays a connecting message.

For mobile testing, use the Render HTTPS URL (rather than a local file). Rotate between portrait and landscape and verify the joystick, Jump, and Dive controls remain clear of device safe areas.

## Controls

- Desktop: WASD or arrows, Space to jump, Shift to dive.
- Touch: drag the left joystick; use the large Jump and Dive buttons at lower right.
