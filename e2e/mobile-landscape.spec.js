import { test, expect } from '@playwright/test';

function mobileOnly(testInfo) {
  test.skip(
    testInfo.project.name !== 'mobile-chromium',
    'Mobile landscape suite runs only in the touch project.'
  );
}

async function installFullscreenMock(
  page,
  { supported = true, rejectRequest = false, rejectLock = false } = {}
) {
  await page.addInitScript(
    ({ supported, rejectRequest, rejectLock }) => {
      let fullscreenElement = null;
      window.__orientationLocks = [];

      Object.defineProperty(document, 'fullscreenEnabled', {
        configurable: true,
        get: () => supported
      });
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => fullscreenElement
      });

      if (supported) {
        Element.prototype.requestFullscreen = async function () {
          if (rejectRequest) throw new Error('fullscreen rejected for test');
          fullscreenElement = this;
          document.dispatchEvent(new Event('fullscreenchange'));
        };
        document.exitFullscreen = async () => {
          fullscreenElement = null;
          document.dispatchEvent(new Event('fullscreenchange'));
        };
      } else {
        Element.prototype.requestFullscreen = undefined;
        document.exitFullscreen = undefined;
      }

      const orientation = {
        type: 'landscape-primary',
        angle: 90,
        addEventListener() {},
        removeEventListener() {},
        async lock(value) {
          window.__orientationLocks.push(value);
          if (rejectLock) throw new Error('orientation lock rejected for test');
        }
      };
      try {
        Object.defineProperty(screen, 'orientation', { configurable: true, value: orientation });
      } catch {
        try {
          Object.defineProperty(screen.orientation, 'lock', {
            configurable: true,
            value: orientation.lock.bind(orientation)
          });
        } catch {}
      }
    },
    { supported, rejectRequest, rejectLock }
  );
}

async function expectInsideViewport(locator, page) {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('target landscape sizes show the game shell without the rotate gate', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  await page.goto('/');

  for (const viewport of [
    { width: 667, height: 375 },
    { width: 844, height: 390 },
    { width: 915, height: 412 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.locator('body')).toHaveAttribute('data-mobile-orientation', 'landscape');
    await expect(page.locator('#rotateDevice')).toBeHidden();
    await expect(page.locator('#menu')).toBeVisible();
    await expectInsideViewport(page.locator('.menu-card'), page);
  }
});

test('portrait gate survives orientation changes without reload or UI-state loss', async ({
  page
}, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/');
  await page.locator('.mode-tab[data-mode="coop"]').click();
  await expect(page.locator('#coop')).toBeVisible();
  const navigationEntries = await page.evaluate(() => performance.getEntriesByType('navigation').length);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#rotateDevice')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-mobile-orientation', 'portrait');
  expect(await page.evaluate(() => window.__WOBBLE_GAME__.input.enabled)).toBe(false);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#rotateDevice')).toBeHidden();
  await expect(page.locator('#coop')).toBeVisible();
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(
    navigationEntries
  );
  expect(await page.evaluate(() => window.__WOBBLE_GAME__.state.name)).toBe('menu');
});

test('portrait accessibility fallback provides a real escape hatch', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ПОВЕРНИТЕ УСТРОЙСТВО' })).toBeVisible();

  await page.getByRole('button', { name: 'НЕ МОГУ ПОВЕРНУТЬ УСТРОЙСТВО' }).click();
  await page.getByRole('button', { name: 'ПРОДОЛЖИТЬ В PORTRAIT' }).click();

  await expect(page.locator('#rotateDevice')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/portrait-accessibility/);
  await expect(page.locator('#menu')).toBeVisible();
});

test('missing and rejected Fullscreen API never block normal play', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  await installFullscreenMock(page, { supported: false });
  await page.goto('/');
  await expect(page.locator('#mobileGameModePrompt')).toBeHidden();
  await expect(page.locator('#fullscreenToggle')).toBeHidden();
  await expect(page.locator('#play')).toBeVisible();

  const rejected = await page.context().newPage();
  await rejected.setViewportSize({ width: 844, height: 390 });
  await installFullscreenMock(rejected, { supported: true, rejectRequest: true, rejectLock: true });
  await rejected.goto('/');
  await expect(rejected.locator('#mobileGameModePrompt')).toBeVisible();
  await rejected.locator('#mobileFullscreenStart').click();
  await expect(rejected.locator('#mobileGameModePrompt')).toBeHidden();
  await expect(rejected.locator('body')).not.toHaveClass(/is-fullscreen/);
  await expect(rejected.locator('#play')).toBeVisible();
  await rejected.close();
});

test('fullscreenchange owns button state and orientation-lock rejection is harmless', async ({
  page
}, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 844, height: 390 });
  await installFullscreenMock(page, { supported: true, rejectLock: true });
  await page.goto('/');

  await expect(page.locator('#mobileGameModePrompt')).toBeVisible();
  await page.locator('#mobileFullscreenStart').click();
  await expect(page.locator('#fullscreenToggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).toHaveClass(/is-fullscreen/);
  expect(await page.evaluate(() => window.__orientationLocks)).toEqual(['landscape']);

  await page.locator('#fullscreenToggle').click();
  await expect(page.locator('#fullscreenToggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('body')).not.toHaveClass(/is-fullscreen/);
});

test('landscape HUD and permanent touch controls stay inside the viewport edges', async ({
  page
}, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 667, height: 375 });
  await page.goto('/');
  await page.evaluate(() => {
    document.querySelector('#hud')?.classList.remove('hidden');
    document.querySelector('#touch')?.classList.remove('hidden');
  });

  const hud = page.locator('#hud');
  const stick = page.locator('#stick');
  const jump = page.locator('#jump');
  const dive = page.locator('#dive');
  await expectInsideViewport(hud, page);
  await expectInsideViewport(stick, page);
  await expectInsideViewport(jump, page);
  await expectInsideViewport(dive, page);

  const hudBox = await hud.boundingBox();
  expect(hudBox.height).toBeLessThanOrEqual(60);
  const centers = await page.evaluate(() => {
    const center = selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return rect.left + rect.width / 2;
    };
    return { width: innerWidth, stick: center('#stick'), jump: center('#jump'), dive: center('#dive') };
  });
  expect(centers.stick).toBeLessThan(centers.width * 0.36);
  expect(centers.jump).toBeGreaterThan(centers.width * 0.64);
  expect(centers.dive).toBeGreaterThan(centers.width * 0.64);
});

test('reduced motion removes the rotate-device animation', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  await page.addInitScript(() => {
    localStorage.setItem('wobble-controls-v1', JSON.stringify({ motion: 'reduced' }));
  });
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/');
  await expect(page.locator('#rotateDevice')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/reduced-motion/);
  expect(await page.locator('.rotate-phone').evaluate(node => getComputedStyle(node).animationName)).toBe(
    'none'
  );
});
