import { test, expect } from '@playwright/test';

async function openWardrobe(page) {
  await page.goto('/');
  await expect(page.locator('#accountName')).not.toHaveText('…');
  await page.locator('#openWardrobeMenu').click();
  await expect(page.locator('#wardrobe')).toBeVisible();
}

test('showroom renders real thumbnails, previews locked costumes and keeps equipment reachable', async ({
  page
}, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openWardrobe(page);
  await expect(page.locator('.wardrobe-card')).toHaveCount(5);
  await expect(page.locator('.wardrobe-card-swatch img')).toHaveCount(5);
  const backgroundFrame = await page.evaluate(() => window.__WOBBLE_GAME__.renderer.info.render.frame);
  const initial = await page.evaluate(
    () => window.__WOBBLE_GAME__.player.character.cosmetics.loadout.body?.id
  );
  await page.locator('[data-cosmetic-id="space-astronaut"]').click();
  await expect(page.locator('#wardrobeStageName')).toHaveText('АСТРОНАВТ');
  await expect(page.locator('#wardrobeEquip')).toBeDisabled();
  await expect(page.locator('#wardrobeEquip')).toBeInViewport();
  await expect
    .poll(() =>
      page.evaluate(() => window.__WOBBLE_GAME__.ui.wardrobe.preview.character.cosmetics.loadout.body.id)
    )
    .toBe('space-astronaut');
  expect(await page.evaluate(() => window.__WOBBLE_GAME__.player.character.cosmetics.loadout.body?.id)).toBe(
    initial
  );
  await expect(page.locator('.wardrobe-card-swatch img')).toHaveCount(5);
  const state = await page.evaluate(() => {
    const wardrobe = window.__WOBBLE_GAME__.ui.wardrobe;
    return {
      facing: Math.cos(wardrobe.preview.character.group.rotation.y) < 0,
      overflow:
        document.querySelector('.wardrobe-shell').scrollWidth >
        document.querySelector('.wardrobe-shell').clientWidth + 1,
      upright: Math.abs(wardrobe.preview.character.visual.rotation.z) < 0.1,
      thumbs: [...document.querySelectorAll('.wardrobe-card-swatch img')].every(img => {
        const caption = img.closest('.wardrobe-card').querySelector('strong').getBoundingClientRect();
        return img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().bottom <= caption.top;
      })
    };
  });
  expect(state).toEqual({ facing: true, overflow: false, upright: true, thumbs: true });
  const wardrobeScreenshot = testInfo.outputPath('wardrobe.png');
  await page.screenshot({ path: wardrobeScreenshot });
  await testInfo.attach('wardrobe', { path: wardrobeScreenshot, contentType: 'image/png' });
  const stability = await page.evaluate(() => {
    const preview = window.__WOBBLE_GAME__.ui.wardrobe.preview;
    const phase = preview.character.phase;
    preview.update(-1);
    const attachment = preview.character.cosmetics.attachments.get('body');
    preview.character.visual.rotation.z = 0.18;
    preview.snapshot(preview.loadout, 'pose-isolation');
    return {
      phaseUnchanged: preview.character.phase === phase,
      poseUnchanged: preview.character.visual.rotation.z === 0.18,
      outfitUnchanged: preview.character.cosmetics.attachments.get('body') === attachment,
      neutralThumbnail: preview.thumbnailCharacter.visual.rotation.z === 0
    };
  });
  expect(Object.values(stability).every(Boolean)).toBe(true);
  expect(await page.evaluate(() => window.__WOBBLE_GAME__.renderer.info.render.frame)).toBe(backgroundFrame);
  await page.locator('.wardrobe-filter-drawer > summary').click();
  await page.locator('#wardrobeSearch').fill('несуществующий предмет');
  await expect(page.locator('.wardrobe-empty')).toBeVisible();
  await expect(page.locator('#wardrobeDetails')).toBeHidden();
  await page.locator('#wardrobeSearch').fill('кот');
  await expect(page.locator('.wardrobe-card')).toHaveCount(1);
  await expect(page.locator('#wardrobeItemName')).toHaveText('ЛУННЫЙ КОТ');
  await page.locator('#wardrobeClose').click();
  await expect(page.locator('#wardrobe')).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.__WOBBLE_GAME__.renderer.info.render.frame))
    .toBeGreaterThan(backgroundFrame);
  expect(errors).toEqual([]);
});

test('wardrobe supports keyboard rotation, roving tabs, Escape and repeat opening', async ({ page }) => {
  await openWardrobe(page);
  await page.locator('#wardrobePreview').focus();
  const before = await page.evaluate(() => window.__WOBBLE_GAME__.ui.wardrobe.preview.targetAngle);
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.__WOBBLE_GAME__.ui.wardrobe.preview.targetAngle)).toBeGreaterThan(
    before
  );
  await page.keyboard.press('Home');
  expect(await page.evaluate(() => window.__WOBBLE_GAME__.ui.wardrobe.preview.targetAngle)).toBe(before);
  await page.locator('[data-category="signature"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-category="all"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-category="all"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#wardrobe')).toBeHidden();
  await expect(page.locator('#openWardrobeMenu')).toBeFocused();
  for (let index = 0; index < 3; index++) {
    await page.locator('#openWardrobeMenu').click();
    await expect(page.locator('#wardrobePreview')).toBeVisible();
    await page.locator('#wardrobeClose').click();
    expect(await page.evaluate(() => window.__WOBBLE_GAME__.ui.wardrobe.preview)).toBeNull();
  }
});

test('desktop results show the equipped character and release the showroom after leaving', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The second 3D stage is reserved for desktop.');
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/');
  await page.locator('#play').click();
  await expect(page.locator('#hud')).toBeVisible();
  await page.evaluate(() => {
    const game = window.__WOBBLE_GAME__;
    game.ui.finishSolo({ time: 45000, respawns: 0, dashes: 1, hits: 0, spec: game.course.spec });
  });
  await expect(page.locator('#resultsCharacter')).toBeVisible();
  await expect(page.locator('#finish')).toHaveClass(/results-ready/);
  await expect(page.locator('#finishTitle')).toHaveCSS('opacity', '1');
  await expect(page.locator('#again')).toBeInViewport();
  const resultsScreenshot = testInfo.outputPath('results.png');
  await page.screenshot({ path: resultsScreenshot });
  await testInfo.attach('results', { path: resultsScreenshot, contentType: 'image/png' });
  expect(
    await page.evaluate(() => {
      const presentation = window.__WOBBLE_RESULTS_PRESENTATION__;
      const player = window.__WOBBLE_GAME__.player.character;
      return presentation.showcase.character.cosmetics.loadout.body?.id === player.cosmetics.loadout.body?.id;
    })
  ).toBe(true);
  await page.locator('#finish .back').click();
  await expect(page.locator('#finish')).toBeHidden();
  await expect(page.locator('#menu')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        showroom: window.__WOBBLE_RESULTS_PRESENTATION__.showcase,
        frame: window.__WOBBLE_RESULTS_PRESENTATION__.showcaseFrame
      }))
    )
    .toEqual({ showroom: null, frame: 0 });
});
