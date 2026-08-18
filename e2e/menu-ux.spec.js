import { test, expect } from '@playwright/test';

function mobileOnly(testInfo) {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Menu landscape checks run in the touch project.');
}

async function previewState(page) {
  return page.evaluate(() => {
    const game = window.__WOBBLE_GAME__;
    return {
      uiMode: game?.ui?.mode,
      gameMode: game?.mode,
      previewMode: document.body.dataset.menuPreviewMode || '',
      chapterId: game?.course?.spec?.chapterId || '',
      remotes: game?.remotes?.size || 0,
      networkCreated: Boolean(game?.net)
    };
  });
}

test('landscape menu uses a mode rail, contextual panel and network-free live previews', async ({
  page
}, testInfo) => {
  mobileOnly(testInfo);
  await page.goto('/');

  await expect(page.locator('#menuModeRail')).toBeVisible();
  await expect(page.locator('#menuPreviewCaption')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-menu-preview-mode', 'single');

  await page.locator('.mode-tab[data-mode="multi"]').click();
  await expect(page.locator('#multi')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-menu-preview-mode', 'multi');
  await expect(page.locator('#raceFriendsToggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#raceFriendsTogglePanel')).toBeHidden();

  let state = await previewState(page);
  expect(state.uiMode).toBe('multi');
  expect(state.gameMode).toBe('preview');
  expect(state.chapterId).toBe('');
  expect(state.remotes).toBe(3);
  expect(state.networkCreated).toBe(false);

  await page.locator('.mode-tab[data-mode="coop"]').click();
  await expect(page.locator('#coop')).toBeVisible();
  await expect(page.locator('#coopChapter')).toHaveCount(0);
  await expect(page.locator('#coopCampaign .campaign-card')).toHaveCount(10);
  await expect(page.locator('#campaignContext')).toBeVisible();
  await expect(page.locator('#coopFriendsToggle')).toHaveAttribute('aria-expanded', 'false');

  const target = page.locator('#coopCampaign .campaign-card').nth(3);
  const targetId = await target.getAttribute('data-chapter');
  await target.click();
  await expect(target).toHaveClass(/selected/);
  await expect(page.locator('body')).toHaveAttribute('data-menu-preview-mode', 'coop');
  await expect(page.locator('body')).toHaveAttribute('data-menu-preview-chapter', targetId);

  state = await previewState(page);
  expect(state.uiMode).toBe('coop');
  expect(state.gameMode).toBe('preview');
  expect(state.chapterId).toBe(targetId);
  expect(state.remotes).toBe(1);
  expect(state.networkCreated).toBe(false);
});

test('audio controls live in Settings while the menu keeps a quick mute action', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#soundToggle')).toBeVisible();
  await expect(page.locator('#settingsEssentials .audio-panel')).toHaveCount(1);
  await expect(page.locator('#menu > .audio-panel')).toHaveCount(0);

  await page.locator('#openSettings').click();
  await expect(page.locator('#settings')).toBeVisible();
  await expect(page.locator('#settingsEssentials .audio-panel')).toBeVisible();
  await expect(page.locator('#vol-master')).toBeVisible();
  await expect(page.locator('#vol-sfx')).toBeVisible();
  await expect(page.locator('#vol-music')).toBeVisible();
});

test('campaign map and contextual menu remain scroll-free at the tallest target mobile viewport', async ({
  page
}, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 1024, height: 576 });
  await page.goto('/');
  await page.locator('.mode-tab[data-mode="coop"]').click();
  await expect(page.locator('#campaignContext')).toBeVisible();

  const geometry = await page.locator('.menu-card').evaluate(node => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth
  }));
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);

  const nodes = await page.locator('#coopCampaign .campaign-card').evaluateAll(items =>
    items.map(node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    })
  );
  expect(nodes).toHaveLength(10);
  expect(nodes.every((node, index) => index === 0 || node.left >= nodes[index - 1].left)).toBe(true);
});
