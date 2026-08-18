import { test, expect } from '@playwright/test';

function fullscreenOnly(testInfo) {
  test.skip(
    testInfo.project.name !== 'mobile-fullscreen',
    'Fullscreen lifecycle suite runs only in the dedicated touch project.'
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

      // Regression harness: capability becomes available during pointerdown on the mode button.
      // Bubble phase runs after MobileExperience's capture guard, but before pointerup/click.
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

async function armFullscreenPrompt(page) {
  await expect(page.locator('#mobileGameModePrompt')).toBeHidden();
  await page.locator('.mode-tab[data-mode="single"]').click();
  await expect(page.locator('#mobileGameModePrompt')).toBeVisible();
}

test('missing and rejected Fullscreen API never block normal play', async ({ page }, testInfo) => {
  fullscreenOnly(testInfo);
  await installFullscreenMock(page, { supported: false });
  await page.goto('/');
  await expect(page.locator('#mobileGameModePrompt')).toBeHidden();
  await expect(page.locator('#fullscreenToggle')).toBeHidden();
  await page.locator('.mode-tab[data-mode="single"]').click();
  await expect(page.locator('#mobileGameModePrompt')).toBeHidden();
  await expect(page.locator('#play')).toBeVisible();

  const rejected = await page.context().newPage();
  await rejected.setViewportSize({ width: 844, height: 390 });
  await installFullscreenMock(rejected, { supported: true, rejectRequest: true, rejectLock: true });
  await rejected.goto('/');
  await armFullscreenPrompt(rejected);
  await rejected.locator('#mobileFullscreenStart').click();
  await expect(rejected.locator('#mobileGameModePrompt')).toBeHidden();
  await expect(rejected.locator('body')).not.toHaveClass(/is-fullscreen/);
  await expect(rejected.locator('#play')).toBeVisible();
  await rejected.close();
});

test('fullscreen onboarding waits until the mode click has completed', async ({ page }, testInfo) => {
  fullscreenOnly(testInfo);
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
  fullscreenOnly(testInfo);
  await page.setViewportSize({ width: 844, height: 390 });
  await installFullscreenMock(page, { supported: true });
  await page.goto('/');
  await armFullscreenPrompt(page);

  await page.locator('#play').evaluate(node => node.click());
  await expect(page.locator('#hud')).toBeVisible();
  await expect(page.locator('#menu')).toBeHidden();
  await expect(page.locator('#mobileGameModePrompt')).toBeHidden();
});

test('fullscreenchange owns button state and orientation-lock rejection is harmless', async ({
  page
}, testInfo) => {
  fullscreenOnly(testInfo);
  await page.setViewportSize({ width: 844, height: 390 });
  await installFullscreenMock(page, { supported: true, rejectLock: true });
  await page.goto('/');
  await armFullscreenPrompt(page);

  await page.locator('#mobileFullscreenStart').click();
  await expect(page.locator('#fullscreenToggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).toHaveClass(/is-fullscreen/);
  expect(await page.evaluate(() => window.__orientationLocks)).toEqual(['landscape']);

  await page.locator('#fullscreenToggle').click();
  await expect(page.locator('#fullscreenToggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('body')).not.toHaveClass(/is-fullscreen/);
});
