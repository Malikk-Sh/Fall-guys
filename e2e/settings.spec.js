// Настройки управления в живом браузере.
//
// Модульные тесты держат сам модуль настроек: границы, конфликты клавиш, приоритет доступности.
// Чего они увидеть не могут — доходит ли выбранное до игры. Между «настройка сохранена» и
// «джойстик переехал» лежат разметка, стили и ввод, и сломаться может любое из трёх, не тронув
// ни одной проверки в модуле.
//
// Поэтому здесь проверяется не наличие экрана, а последствия: сдвинулся ли джойстик к другому
// краю, выросла ли кнопка, переживает ли выбор перезагрузку, и — главное — попадает ли
// переназначенная клавиша в игру.

import { test, expect } from '@playwright/test';

async function openMenu(page) {
  await page.goto('/');
  await expect(page.locator('#menu')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#accountName')).not.toHaveText('…', { timeout: 20_000 });
}

const boxOf = (page, selector) =>
  page.locator(selector).evaluate(node => node.getBoundingClientRect().toJSON());

test.describe('настройки управления', () => {
  test.setTimeout(90_000);

  // Экранное управление рисуется только там, где к экрану прикасаются: на настольном браузере
  // #touch скрыт целиком, и прямоугольники джойстика и кнопок нулевые. Мерить раскладку там —
  // значит проверять пустоту.
  test('сторона джойстика меняется, применяется к игре и переживает перезагрузку', async ({
    page,
    isMobile
  }) => {
    test.skip(!isMobile, 'экранное управление есть только на сенсорном устройстве');
    await openMenu(page);
    await page.locator('#openSettings').click();
    await expect(page.locator('#settings')).toBeVisible();
    // Экран настроек — оверлей поверх меню: не закрыв его, до кнопки старта не добраться.
    await page.locator('#settingsClose').click();
    await expect(page.locator('#settings')).toBeHidden();

    await page.locator('#play').click();
    await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });

    const width = await page.evaluate(() => window.innerWidth);
    const left = await boxOf(page, '#stick');
    expect(left.x, 'по умолчанию джойстик у левого края').toBeLessThan(width / 2);
    const leftJump = await boxOf(page, '#jump');
    expect(leftJump.x, 'кнопка прыжка при этом справа').toBeGreaterThan(width / 2);

    // Настройка меняется прямо во время забега: за этим и нужна кнопка «управление» — понять,
    // что раскладка не та, можно только когда уже бежишь.
    await page.evaluate(() => window.__WOBBLE_GAME__.settings.set('hand', 'right'));
    const right = await boxOf(page, '#stick');
    expect(right.x, 'после смены руки джойстик у правого края').toBeGreaterThan(width / 2);
    const rightJump = await boxOf(page, '#jump');
    expect(rightJump.x, 'кнопки уехали на освободившуюся сторону').toBeLessThan(width / 2);

    // Зона обзора обязана переехать вместе с джойстиком, иначе половина экрана перестанет
    // отзываться на что бы то ни было.
    const zoneMatches = await page.evaluate(
      w => window.__WOBBLE_GAME__.input.inStickZone(w - 10) && !window.__WOBBLE_GAME__.input.inStickZone(10),
      width
    );
    expect(zoneMatches, 'зона джойстика считается от правого края').toBe(true);

    await page.reload();
    await expect(page.locator('#menu')).toBeVisible({ timeout: 20_000 });
    const stored = await page.evaluate(() => window.__WOBBLE_GAME__.settings.get('hand'));
    expect(stored, 'выбор переживает перезагрузку').toBe('right');
  });

  test('размер интерфейса растит кнопки, а размер джойстика — только джойстик', async ({
    page,
    isMobile
  }) => {
    test.skip(!isMobile, 'экранное управление есть только на сенсорном устройстве');
    await openMenu(page);
    await page.locator('#play').click();
    await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });

    const before = { jump: await boxOf(page, '#jump'), stick: await boxOf(page, '#stick') };

    await page.evaluate(() => window.__WOBBLE_GAME__.settings.set('uiScale', 160));
    const scaled = { jump: await boxOf(page, '#jump'), stick: await boxOf(page, '#stick') };
    expect(scaled.jump.width, 'кнопка выросла вместе с интерфейсом').toBeGreaterThan(before.jump.width);
    // Два множителя на один размер дают джойстик в треть экрана; у него для этого есть свой
    // регулятор, и масштаб интерфейса его намеренно не трогает.
    expect(scaled.stick.width, 'джойстик от масштаба интерфейса не зависит').toBeCloseTo(
      before.stick.width,
      0
    );

    await page.evaluate(() => window.__WOBBLE_GAME__.settings.set('stickSize', 200));
    const bigStick = await boxOf(page, '#stick');
    expect(bigStick.width, 'свой регулятор джойстик слушает').toBeGreaterThan(scaled.stick.width);
  });

  test('переназначенная клавиша управляет игрой, а прежняя перестаёт', async ({ page }) => {
    await openMenu(page);
    await page.locator('#play').click();
    await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(4200);

    // На действие приходится до двух клавиш, и одно назначение прежнюю не вытесняет: после
    // bind('forward','KeyI') раскладка равна ['KeyI','KeyW'], то есть W всё ещё работает — и это
    // правильно. Чтобы проверить «прежняя перестала», нужны два назначения подряд.
    await page.evaluate(() => {
      const settings = window.__WOBBLE_GAME__.settings;
      settings.bind('forward', 'KeyI');
      settings.bind('forward', 'KeyU');
    });

    const startZ = await page.evaluate(() => window.__WOBBLE_GAME__.player.position.z);
    await page.keyboard.down('KeyI');
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyI');
    const afterNew = await page.evaluate(() => window.__WOBBLE_GAME__.player.position.z);
    expect(afterNew, 'новая клавиша ведёт игрока вперёд').toBeLessThan(startZ - 2);

    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1000);
    await page.keyboard.up('KeyW');
    const afterOld = await page.evaluate(() => window.__WOBBLE_GAME__.player.position.z);
    expect(afterOld, 'прежняя клавиша больше не двигает').toBeGreaterThan(afterNew - 2);
  });

  test('сброс возвращает всё к умолчаниям', async ({ page }) => {
    await openMenu(page);
    await page.evaluate(() => {
      const settings = window.__WOBBLE_GAME__.settings;
      settings.set('hand', 'right');
      settings.set('uiScale', 150);
      settings.bind('jump', 'KeyZ');
    });
    await page.locator('#openSettings').click();
    await page.locator('#settingsReset').click();

    const values = await page.evaluate(() => {
      const settings = window.__WOBBLE_GAME__.settings;
      return {
        hand: settings.get('hand'),
        uiScale: settings.get('uiScale'),
        jump: settings.get('keys').jump
      };
    });
    expect(values.hand).toBe('left');
    expect(values.uiScale).toBe(100);
    expect(values.jump).toEqual(['Space']);
  });
});
