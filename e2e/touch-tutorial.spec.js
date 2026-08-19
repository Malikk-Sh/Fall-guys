import { test, expect } from '@playwright/test';

function mobileOnly(testInfo) {
  test.skip(
    testInfo.project.name !== 'mobile-chromium',
    'Touch tutorial acceptance runs only in the windowed touch project.'
  );
}

async function startSoloRace(page) {
  await page.setViewportSize({ width: 915, height: 412 });
  await page.goto('/');
  await expect(page.locator('#menu')).toBeVisible();
  await page.locator('#play').click();
  await expect(page.locator('#hud')).toBeVisible();
  await page.waitForFunction(() => window.__WOBBLE_GAME__?.state?.name === 'race');
}

async function expectTutorialStep(page, step) {
  const tutorial = page.locator('#touchTutorial');
  await expect(tutorial).toBeVisible();
  await expect(tutorial).toHaveAttribute('data-step', step);
  await expect(page.locator('.touch-tutorial-focus')).toHaveCount(step === 'look' ? 0 : 1);
}

test('first touch race teaches one action at a time and remembers completion', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  await startSoloRace(page);

  await expect(page.locator('#lookHint')).toBeHidden();
  await expectTutorialStep(page, 'move');
  await expect(page.locator('#stick .touch-tutorial-thumb')).toHaveCount(1);

  await page.locator('#stick').evaluate(stick => {
    window.__WOBBLE_GAME__.input.moveX = 0.65;
    stick.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 31,
        clientX: 80,
        clientY: 300
      })
    );
    window.__WOBBLE_GAME__.input.moveX = 0;
  });
  await expectTutorialStep(page, 'look');

  await page.locator('#game').evaluate(canvas => {
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 32,
        clientX: 500,
        clientY: 180
      })
    );
    canvas.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 32,
        clientX: 530,
        clientY: 180
      })
    );
    canvas.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 32,
        clientX: 530,
        clientY: 180
      })
    );
  });
  await expectTutorialStep(page, 'jump');

  await page.locator('#jump').dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 33
  });
  await page.locator('#jump').dispatchEvent('pointerup', {
    pointerType: 'touch',
    pointerId: 33
  });
  await expect(page.locator('#touchTutorial')).toBeHidden();
  await expectTutorialStep(page, 'dive');

  await page.locator('#dive').dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 34
  });
  await page.locator('#dive').dispatchEvent('pointerup', {
    pointerType: 'touch',
    pointerId: 34
  });
  await expect(page.locator('#touchTutorial')).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wobble-touch-tutorial-v1')))).toEqual({
    move: true,
    look: true,
    jump: true,
    dive: true
  });

  await page.reload();
  await expect(page.locator('#menu')).toBeVisible();
  await page.locator('#play').click();
  await expect(page.locator('#hud')).toBeVisible();
  await page.waitForFunction(() => window.__WOBBLE_GAME__?.state?.name === 'race');
  await expect(page.locator('#touchTutorial')).toBeHidden();
  await expect(page.locator('#lookHint')).toBeHidden();
});
