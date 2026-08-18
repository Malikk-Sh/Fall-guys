import { test, expect } from '@playwright/test';

function mobileOnly(testInfo) {
  test.skip(
    testInfo.project.name !== 'mobile-chromium',
    'Mobile landscape suite runs only in the touch project.'
  );
}

async function installFullscreenMock(
  page,
  { supported = true, rejectRequest = false, rejectLock = false, armOnModePointerDown = false } = {}
) {
  await page.addInitScript(
    ({ supported, rejectRequest, rejectLock, armOnModePointerDown }) => {
      let fullscreenElement = null;
      let fullscreenEnabled = supported && !armOnModePointerDown;
      window.__orientationLocks = [];

      // Базовый mobile project хранит явный выбор «продолжить в браузере». Fullscreen-suite
      // намеренно снимает его до старта приложения, чтобы тестировать настоящий onboarding.
      try {
        localStorage.removeItem('wobble-fullscreen-prompt-v1');
      } catch {}

      Object.defineProperty(document, 'fullscreenEnabled', {
        configurable: true,
        get: () => fullscreenEnabled
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

      // Регрессия: capability становится доступной ровно во время pointerdown по mode-tab.
      // Bubble phase намеренно идёт после capture-guard MobileExperience, но ещё до pointerup/click.
      if (supported && armOnModePointerDown) {
        document.addEventListener('pointerdown', event => {
          if (fullscreenEnabled || !event.target?.closest?.('.mode-tab')) return;
          fullscreenEnabled = true;
          document.dispatchEvent(new Event('fullscreenchange'));
        });
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
    { supported, rejectRequest, rejectLock, armOnModePointerDown }
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

function boxesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function expectMenuModeFits(page, mode) {
  const tab = page.locator(`.mode-tab[data-mode="${mode}"]`);
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(page.locator(`#${mode}`)).toBeVisible();
  const card = page.locator('.menu-card');
  await expectInsideViewport(card, page);
  const geometry = await card.evaluate(node => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight
  }));
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
}

test('target landscape sizes keep Single, Race and Co-op scroll-free without the rotate gate', async ({
  page
}, testInfo) => {
  mobileOnly(testInfo);
  await page.goto('/');

  for (const viewport of [
    { width: 667, height: 375 },
    { width: 740, height: 360 },
    { width: 844, height: 390 },
    { width: 873, height: 393 },
    { width: 915, height: 412 },
    { width: 1024, height: 576 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.locator('body')).toHaveAttribute('data-mobile-orientation', 'landscape');
    await expect(page.locator('#rotateDevice')).toBeHidden();
    await expect(page.locator('#menu')).toBeVisible();
    for (const mode of ['single', 'multi', 'coop']) await expectMenuModeFits(page, mode);
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

test('portrait gate suppresses paired-keyboard gameplay input', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/');
  await page.locator('#play').click();
  await expect(page.locator('#hud')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#rotateDevice')).toBeVisible();
  await page.keyboard.down('KeyW');
  await page.keyboard.press('Space');
  const blocked = await page.evaluate(() => {
    const input = window.__WOBBLE_GAME__.input;
    input.update();
    return {
      enabled: input.enabled,
      movement: input.movement(),
      jumpQueued: input.jumpQueued,
      keys: input.keys.size
    };
  });
  await page.keyboard.up('KeyW');

  expect(blocked.enabled).toBe(false);
  expect(blocked.movement.magnitude).toBe(0);
  expect(blocked.jumpQueued).toBe(false);
  expect(blocked.keys).toBe(0);
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

test('fullscreen onboarding waits until the mode click has completed', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 844, height: 390 });
  await installFullscreenMock(page, { supported: true, armOnModePointerDown: true });
  await page.goto('/');
  await expect(page.locator('#mobileGameModePrompt')).toBeHidden();

  const coopTab = page.locator('.mode-tab[data-mode="coop"]');
  await coopTab.click();

  await expect(coopTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#coop')).toBeVisible();
  await expect(page.locator('#mobileGameModePrompt')).toBeVisible();
});

test('fullscreen advisory disappears immediately when gameplay leaves the menu', async ({
  page
}, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 844, height: 390 });
  await installFullscreenMock(page, { supported: true });
  await page.goto('/');
  await expect(page.locator('#mobileGameModePrompt')).toBeVisible();

  await page.locator('#play').click();
  await expect(page.locator('#hud')).toBeVisible();
  await expect(page.locator('#menu')).toBeHidden();
  await expect(page.locator('#mobileGameModePrompt')).toBeHidden();
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

test('landscape HUD and permanent touch controls stay separated inside viewport edges', async ({
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

  for (const hand of ['left', 'right']) {
    await page.locator('body').evaluate((body, value) => {
      body.dataset.hand = value;
    }, hand);
    const [stickBox, jumpBox, diveBox] = await Promise.all([
      stick.boundingBox(),
      jump.boundingBox(),
      dive.boundingBox()
    ]);
    expect(boxesOverlap(jumpBox, diveBox)).toBe(false);
    if (hand === 'left') {
      expect(stickBox.x + stickBox.width / 2).toBeLessThan(667 * 0.36);
      expect(jumpBox.x + jumpBox.width / 2).toBeGreaterThan(667 * 0.64);
      expect(diveBox.x + diveBox.width / 2).toBeGreaterThan(667 * 0.55);
    } else {
      expect(stickBox.x + stickBox.width / 2).toBeGreaterThan(667 * 0.64);
      expect(jumpBox.x + jumpBox.width / 2).toBeLessThan(667 * 0.36);
      expect(diveBox.x + diveBox.width / 2).toBeLessThan(667 * 0.45);
    }
  }
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
