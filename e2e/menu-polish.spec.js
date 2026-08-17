import { test, expect } from '@playwright/test';

async function openMenu(page) {
  await page.goto('/');
  await expect(page.locator('#menu')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#accountName')).not.toHaveText('…', { timeout: 20_000 });
  await expect(page.locator('#soundToggle')).toBeVisible({ timeout: 10_000 });
}

test.describe('полировка главного меню', () => {
  test.setTimeout(60_000);

  test('на старте остаётся одно большое действие, а звук и графика живут в настройках', async ({ page }) => {
    await openMenu(page);

    // Ползунки и качество не конкурируют с CTA на главной карточке.
    await expect(page.locator('#menu #vol-master')).toHaveCount(0);
    await expect(page.locator('#menu #quality')).toHaveCount(0);
    await expect(page.locator('#soundToggle')).toHaveAttribute('aria-pressed', 'false');

    await page.locator('#soundToggle').click();
    await expect(page.locator('#soundToggle')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.__WOBBLE_GAME__.audio.muted)).toBe(true);

    await page.locator('#soundToggle').click();
    expect(await page.evaluate(() => window.__WOBBLE_GAME__.audio.muted)).toBe(false);
    await page.locator('#vol-master').evaluate(slider => {
      slider.value = '0';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#soundToggle')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.__WOBBLE_GAME__.audio.volumes.master)).toBe(0);
    await page.locator('#soundToggle').click();
    const recoveredAudio = await page.evaluate(() => ({
      muted: window.__WOBBLE_GAME__.audio.muted,
      master: window.__WOBBLE_GAME__.audio.volumes.master
    }));
    expect(recoveredAudio.muted).toBe(false);
    expect(recoveredAudio.master).toBeGreaterThan(0);

    await page.locator('#openSettings').click();
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#settings #vol-master')).toBeVisible();
    await expect(page.locator('#settings #vol-sfx')).toBeVisible();
    await expect(page.locator('#settings #vol-music')).toBeVisible();
    await expect(page.locator('#settings #quality')).toBeVisible();
    await expect(page.locator('#settings .eyebrow')).toHaveText('НАСТРОЙКИ');
    await page.locator('#settingsClose').click();

    await page.locator('[data-mode="multi"]').click();
    await expect(page.locator('#multi')).toBeVisible();
    await expect(page.locator('#raceFind')).toBeVisible();
    await expect(page.locator('#create')).toBeHidden();
    await expect(page.locator('#code')).toBeHidden();
    await page.locator('#raceFriendsToggle').click();
    await expect(page.locator('#create')).toBeVisible();
    await expect(page.locator('#code')).toBeVisible();
  });

  test('в коопе карточка сама выбирает главу, а private room раскрывается вторым уровнем', async ({
    page
  }) => {
    await openMenu(page);
    await page.locator('[data-mode="coop"]').click();
    await expect(page.locator('#coop')).toBeVisible();

    // Старого дублирующего select в живом интерфейсе больше нет.
    await expect(page.locator('#coopChapter')).toHaveCount(0);
    await expect(page.locator('#coopCreate')).toBeHidden();
    await expect(page.locator('#coopCode')).toBeHidden();

    const chapter = page.locator('.campaign-card[data-chapter="ch4"]');
    await chapter.click();
    await expect(chapter).toHaveClass(/selected/);
    await expect(chapter).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#coopFind')).toContainText('ИГРАТЬ ГЛАВУ 4');

    await page.locator('#coopAnyChapter').check();
    await expect(page.locator('#coopFind')).toContainText('НАЙТИ НАПАРНИКА');
    await page.locator('#coopAnyChapter').uncheck();
    await expect(page.locator('#coopFind')).toContainText('ИГРАТЬ ГЛАВУ 4');

    await page.locator('#coopFriendsToggle').click();
    await expect(page.locator('#coopCreate')).toBeVisible();
    await expect(page.locator('#coopCode')).toBeVisible();
  });

  test('режим reduced motion отключает и вкладки, и раскрытие private room', async ({ page }) => {
    await openMenu(page);
    await page.evaluate(() => window.__WOBBLE_GAME__.settings.set('motion', 'reduced'));
    await page.locator('[data-mode="multi"]').click();
    await expect(page.locator('#multi')).toBeVisible();
    const activeAnimations = await page
      .locator('#multi')
      .evaluate(node => node.getAnimations().filter(animation => animation.playState === 'running').length);
    expect(activeAnimations).toBe(0);

    await page.locator('#raceFriendsToggle').click();
    const drawerAnimations = await page
      .locator('#raceFriendsTogglePanel')
      .evaluate(node => node.getAnimations().filter(animation => animation.playState === 'running').length);
    expect(drawerAnimations).toBe(0);
  });

  test('отмена перехода не оставляет mode panel заблокированной', async ({ page }) => {
    await openMenu(page);
    await page.evaluate(() => {
      const ui = window.__WOBBLE_GAME__.ui;
      ui.selectMode('multi');
      ui.selectMode('single');
    });
    await expect(page.locator('#single')).toBeVisible();
    expect(await page.locator('#single').evaluate(node => node.style.pointerEvents)).toBe('');
  });

  test('desktop menu после entrance motion остаётся вертикально центрированным', async ({
    page
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop-only geometry invariant');
    await openMenu(page);
    await page.evaluate(() => window.__WOBBLE_GAME__.ui.show('menu'));
    await page.waitForTimeout(250);
    const offset = await page.locator('#menu .menu-card').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
    });
    expect(offset).toBeLessThan(4);
  });
});
