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

  test(
    'в коопе карточка сама выбирает главу, а private room раскрывается вторым уровнем',
    async ({ page }) => {
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
    }
  );

  test('режим reduced motion превращает смену вкладки почти в мгновенную', async ({ page }) => {
    await openMenu(page);
    await page.evaluate(() => window.__WOBBLE_GAME__.settings.set('motion', 'reduced'));
    await page.locator('[data-mode="multi"]').click();
    await expect(page.locator('#multi')).toBeVisible();
    const activeAnimations = await page
      .locator('#multi')
      .evaluate(node => node.getAnimations().filter(animation => animation.playState === 'running').length);
    expect(activeAnimations).toBe(0);
  });
});
