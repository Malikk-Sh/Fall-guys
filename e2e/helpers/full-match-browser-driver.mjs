import { DRIVER_CONTROL_PERIOD_MS, STEER_PULSE_MS } from './full-match-driver.mjs';
import { summarizeIntervals } from './full-match-telemetry.mjs';

export async function startFullMatchBrowserDriver(page) {
  await page.evaluate(
    async ({ controlPeriodMs, steerPulseMs }) => {
      const { steeringKey } = await import('/shared/e2eFullMatchDriver.js');
      window.__WOBBLE_E2E_BROWSER_DRIVER__?.stop?.();

      const telemetry = {
        startedAt: performance.now(),
        lastControlAt: null,
        controlIntervals: [],
        iterations: 0,
        maxAbsX: 0,
        maxAbsVx: 0,
        running: true,
        finished: false
      };
      const keyValue = { KeyW: 'w', KeyA: 'a', KeyD: 'd', Space: ' ' };
      let currentSteer = null;
      let steerUntil = 0;
      let nextControlAt = performance.now();
      let rafId = 0;

      const send = (type, code) =>
        window.dispatchEvent(
          new KeyboardEvent(type, {
            code,
            key: keyValue[code] || '',
            bubbles: true,
            cancelable: true
          })
        );

      const releaseSteer = () => {
        if (currentSteer) send('keyup', currentSteer);
        currentSteer = null;
        steerUntil = 0;
      };

      const stop = () => {
        if (!telemetry.running) return;
        telemetry.running = false;
        cancelAnimationFrame(rafId);
        releaseSteer();
        send('keyup', 'KeyW');
        telemetry.stoppedAt = performance.now();
      };

      const tick = now => {
        if (!telemetry.running) return;
        if (currentSteer && now >= steerUntil) releaseSteer();

        const player = window.__WOBBLE_GAME__?.player;
        const results = !document.querySelector('#finish')?.classList.contains('hidden');
        if (player) {
          const x = player.position?.x ?? 0;
          const vx = player.velocity?.x ?? 0;
          telemetry.maxAbsX = Math.max(telemetry.maxAbsX, Math.abs(x));
          telemetry.maxAbsVx = Math.max(telemetry.maxAbsVx, Math.abs(vx));

          if (player.finished || results) {
            telemetry.finished = true;
            stop();
            return;
          }

          if (now >= nextControlAt) {
            if (telemetry.lastControlAt !== null) {
              telemetry.controlIntervals.push(now - telemetry.lastControlAt);
              if (telemetry.controlIntervals.length > 600) telemetry.controlIntervals.shift();
            }
            telemetry.lastControlAt = now;
            telemetry.iterations++;
            nextControlAt = now + controlPeriodMs;

            const key = steeringKey({ x, vx });
            if (key) {
              if (currentSteer && currentSteer !== key) releaseSteer();
              if (!currentSteer) {
                send('keydown', key);
                currentSteer = key;
              }
              steerUntil = now + steerPulseMs;
            } else {
              releaseSteer();
            }

            // Как и прежний Playwright-driver, каждый управляющий такт делает отдельное нажатие
            // прыжка. Это не удержание: InputManager ставит jumpQueued на каждый новый keydown.
            send('keydown', 'Space');
            send('keyup', 'Space');
          }
        }

        rafId = requestAnimationFrame(tick);
      };

      window.__WOBBLE_E2E_BROWSER_DRIVER__ = { telemetry, stop };
      send('keydown', 'KeyW');
      rafId = requestAnimationFrame(tick);
    },
    { controlPeriodMs: DRIVER_CONTROL_PERIOD_MS, steerPulseMs: STEER_PULSE_MS }
  );
}

export async function waitForFullMatchBrowserDriver(page, timeout) {
  try {
    await page.waitForFunction(
      () => window.__WOBBLE_E2E_BROWSER_DRIVER__?.telemetry?.finished === true,
      null,
      { polling: 'raf', timeout }
    );
    return true;
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return false;
  }
}

export async function stopFullMatchBrowserDriver(page) {
  await page.evaluate(() => window.__WOBBLE_E2E_BROWSER_DRIVER__?.stop?.());
}

export async function readFullMatchBrowserDriverTelemetry(page) {
  const telemetry = await page.evaluate(() => {
    const value = window.__WOBBLE_E2E_BROWSER_DRIVER__?.telemetry;
    if (!value) return null;
    return {
      iterations: value.iterations,
      intervals: value.controlIntervals.slice(),
      maxAbsX: value.maxAbsX,
      maxAbsVx: value.maxAbsVx
    };
  });
  if (!telemetry) return null;
  return {
    iterations: telemetry.iterations,
    intervals: summarizeIntervals(telemetry.intervals),
    maxAbsX: telemetry.maxAbsX,
    maxAbsVx: telemetry.maxAbsVx
  };
}
