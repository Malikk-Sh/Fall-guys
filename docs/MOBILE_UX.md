# Mobile UX

Wobble Rush is landscape-first on touch/mobile devices. This document describes the browser shell policy implemented by `client/ui/MobileExperience.js`.

## Orientation policy

- Touch/coarse-pointer devices use landscape as the primary gameplay orientation.
- Portrait shows an opaque rotate-device gate instead of maintaining a second full HUD layout.
- Entering portrait never reloads the page, leaves the network/session alive, and does not change the current AppState.
- Gameplay input is reset and suspended while the gate is active.
- Returning to landscape resets pointers again, resizes the renderer, and restores input only for `race` or `spectate` AppStates.
- Players who cannot rotate the device can use the accessibility action in the gate and continue in a simplified portrait layout for the current session.

Desktop is not orientation-gated.

## Fullscreen and installed PWA

Installed-PWA display mode and the DOM Fullscreen API are independent:

- `manifest.webmanifest` prefers `orientation: landscape`.
- `display` remains `standalone` until real-device installed-PWA smoke confirms that manifest `fullscreen` is consistently better on Android Chromium/Samsung Internet and iOS Home Screen.
- The in-game fullscreen action calls `requestFullscreen()` only from a user gesture.
- Orientation lock is best-effort and happens after the fullscreen request.
- A rejected/missing Fullscreen or Screen Orientation API is not an error state and never blocks gameplay.
- `fullscreenchange` is the source of truth for the fullscreen button state.
- The first landscape fullscreen suggestion is non-blocking; choosing browser mode stores only the UX dismissal, never a fake fullscreen state.

## Safe areas and controls

The shell continues to use the existing `--safe-top/right/bottom/left` variables backed by `env(safe-area-inset-*)`.

On mobile landscape:

- HUD and permanent touch controls are inset from the appropriate safe edge.
- Left/right-hand layout remains owned by the existing `data-hand` setting.
- Joystick and action controls remain on opposite outer edges so the center of the 3D scene stays available for camera swipes and course reading.
- The HUD is compressed for common 375–412 px landscape heights; network quality remains secondary on the smallest width.
- Existing `uiScale`, stick size/opacity and floating/fixed stick settings remain authoritative.

## Accessibility and motion

- The portrait fallback is a real escape hatch, not a hidden developer option.
- `Settings.reducedMotion` and `prefers-reduced-motion` remove the phone-rotation animation.
- Fullscreen is optional.
- Orientation-lock failure is silent and non-fatal.
- The rotate gate uses dialog semantics and readable text in addition to the phone graphic.

## Performance budget

`MobileExperience` is presentation-only. It does not own gameplay, physics, matchmaking, timers or WebSocket lifecycle.

- Orientation work is coalesced through `requestAnimationFrame`.
- Resize does not rebuild the UI tree.
- The controller creates its small shell DOM once and reuses it.
- No per-frame allocations or polling are added after the game reference has been attached.

## Tests

`e2e/mobile-landscape.spec.js` covers target landscape sizes, portrait → landscape recovery, state preservation, accessibility fallback, missing/rejected fullscreen, orientation-lock rejection, fullscreenchange state, touch-control bounds and reduced motion.

The normal `mobile-chromium` Playwright project runs at 915×412 landscape. Portrait is exercised explicitly by the mobile landscape suite rather than making every mobile E2E start behind the orientation gate.
