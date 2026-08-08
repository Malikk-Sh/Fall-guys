// Дымовой тест одиночной игры и меню.
//
// Всё, что проверялось браузером до сих пор, — сетевые сценарии на двоих. Одиночный забег, меню,
// окно аккаунта и переключение трасс не проверялись ничем: клиентский вход `main.js` в модульные
// тесты не берётся, потому что при загрузке трогает document и WebGL.
//
// Между тем именно там живёт большая часть кода, к которому игрок прикасается каждый раз. Этот
// набор не заменяет сетевые тесты — он держит то, что они не видят: что игра запускается с меню,
// идёт, показывает время и отпускает обратно.

import { test, expect } from '@playwright/test';

// Игра доходит до готового меню не мгновенно: грузится Three.js, собирается предпросмотр трассы,
// уходит запрос аккаунта.
async function openMenu(page) {
  await page.goto('/');
  await expect(page.locator('#menu')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#accountName')).not.toHaveText('…', { timeout: 20_000 });
}

test.describe('одиночная игра и меню', () => {
  test.setTimeout(90_000);

  test('забег запускается из меню, идёт время и выход возвращает в меню', async ({ page }) => {
    await openMenu(page);

    // Сложность и тип трассы читаются из меню — забег обязан стартовать с любыми.
    await page.locator('#runType').selectOption('random');
    await page.locator('#difficulty').selectOption('easy');
    const courseName = (await page.locator('#courseName').textContent()).trim();
    expect(courseName.length).toBeGreaterThan(0);

    await page.locator('#play').click();
    await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#menu')).toBeHidden();

    // Часы идут. Проверяется не «таймер не пуст», а что он ИЗМЕНИЛСЯ: остановившийся секундомер
    // тоже не пуст, и именно его отсутствие здесь и ловится.
    const first = await page.locator('#timer').textContent();
    await expect(page.locator('#timer')).not.toHaveText(first, { timeout: 10_000 });

    // Персонаж под управлением: бег вперёд обязан менять положение. Это самая дешёвая проверка
    // того, что цикл идёт, ввод доходит и физика работает.
    const startZ = await page.evaluate(() => window.__WOBBLE_GAME__?.player?.position?.z ?? 0);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyW');
    const movedZ = await page.evaluate(() => window.__WOBBLE_GAME__?.player?.position?.z ?? 0);
    expect(movedZ, 'бег вперёд обязан двигать игрока по трассе').toBeLessThan(startZ - 2);

    // Прогресс на месте: сцена собрана, чекпоинты известны.
    await expect(page.locator('#checks')).toContainText('/');
    await expect(page.locator('#stageName')).not.toBeEmpty();

    // Выход из забега — двумя нажатиями, как задумано.
    await page.locator('#leaveMatch').click();
    await expect(page.locator('#leaveMatch')).toHaveText('ТОЧНО?');
    await page.locator('#leaveMatch').click();
    await expect(page.locator('#menu')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#hud')).toBeHidden();
  });

  test('меню переключает режимы, трассы и открывает окно аккаунта', async ({ page }) => {
    await openMenu(page);

    // Испытание дня и случайная трасса — разные трассы, и меню обязано это показывать.
    await page.locator('#runType').selectOption('daily');
    await expect(page.locator('#challengeRule')).toBeVisible();
    const daily = (await page.locator('#courseName').textContent()).trim();
    await page.locator('#runType').selectOption('random');
    const random = (await page.locator('#courseName').textContent()).trim();
    expect(random, 'у случайной трассы своё название').not.toBe(daily);

    // Вкладки режимов показывают свои панели и прячут чужие.
    await page.locator('[data-mode="multi"]').click();
    await expect(page.locator('#multi')).toBeVisible();
    await expect(page.locator('#single')).toBeHidden();
    await page.locator('[data-mode="coop"]').click();
    await expect(page.locator('#coop')).toBeVisible();
    await expect(page.locator('#multi')).toBeHidden();
    await page.locator('[data-mode="single"]').click();
    await expect(page.locator('#single')).toBeVisible();

    // Окно аккаунта: открывается по чипу, закрывается Escape.
    await page.locator('#accountChip').click();
    await expect(page.locator('#account')).toBeVisible();
    await expect(page.locator('#accountList')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#account')).toBeHidden();

    // Переименование доходит до чипа в меню — самый частый путь через окно аккаунта.
    await page.locator('#accountChip').click();
    await page.locator('#accountRename').fill('Дымовой');
    await page.locator('#accountSave').click();
    await expect(page.locator('#accountName')).toHaveText('Дымовой', { timeout: 10_000 });
    await page.locator('#accountClose').click();
    await expect(page.locator('#account')).toBeHidden();
  });
});
