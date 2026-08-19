import { test, expect } from '@playwright/test';

const TARGET_LANDSCAPE_VIEWPORTS = [
  { width: 667, height: 375 },
  { width: 740, height: 360 },
  { width: 844, height: 390 },
  { width: 873, height: 393 },
  { width: 915, height: 412 },
  { width: 1024, height: 576 }
];

function mobileOnly(testInfo) {
  test.skip(
    testInfo.project.name !== 'mobile-chromium',
    'UX acceptance geometry runs only in the windowed touch project.'
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

test('target mobile landscape lobby keeps its outer card fixed while lists own scrolling', async ({
  page
}, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 915, height: 412 });
  await page.goto('/');
  await expect(page.locator('#menu')).toBeVisible();
  await expect(page.locator('#accountName')).not.toHaveText('…', { timeout: 20_000 });
  await page.locator('.mode-tab[data-mode="multi"]').click();

  const friendsToggle = page.locator('#raceFriendsToggle');
  if (await friendsToggle.count()) await friendsToggle.click();
  await expect(page.locator('#create')).toBeVisible();
  await page.locator('#create').click();
  await expect(page.locator('#lobby')).toBeVisible({ timeout: 15_000 });

  for (const viewport of TARGET_LANDSCAPE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect(page.locator('body')).toHaveAttribute('data-mobile-orientation', 'landscape');
    const card = page.locator('#lobby .lobby-card');
    await expectInsideViewport(card, page);
    const geometry = await card.evaluate(node => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight
    }));
    expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);

    for (const selector of ['#ready', '#addBots', '#start']) {
      const action = page.locator(selector);
      if (await action.isVisible()) await expectInsideViewport(action, page);
    }
  }
});

test('solo Results keeps primary actions reachable at every target mobile landscape size', async ({
  page
}, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 915, height: 412 });
  await page.goto('/');
  await expect(page.locator('#menu')).toBeVisible();

  await page.evaluate(() => {
    const game = window.__WOBBLE_GAME__;
    game.ui.finishSolo({
      time: 65_000,
      respawns: 0,
      dashes: 2,
      hits: 0,
      spec: game.previewSpec
    });
  });
  await expect(page.locator('#finish')).toBeVisible();
  await expect(page.locator('#again')).toBeVisible({ timeout: 3_000 });

  for (const viewport of TARGET_LANDSCAPE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect(page.locator('body')).toHaveAttribute('data-mobile-orientation', 'landscape');
    await expectInsideViewport(page.locator('#finish .finish-card'), page);
    await expectInsideViewport(page.locator('#again'), page);
    await expectInsideViewport(page.locator('#newCourse'), page);
  }
});
