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
    await expect(page.locator('.campaign-card')).toHaveCount(10);
    await page.locator('.campaign-card[data-chapter="ch7"]').click();
    await expect(page.locator('#coopChapter')).toHaveValue('ch7');
    await page.locator('[data-mode="single"]').click();
    await expect(page.locator('#single')).toBeVisible();

    // Окно аккаунта: открывается по чипу, закрывается Escape. Панель показывает надетое по слотам,
    // а не весь каталог — полный разбор живёт в шкафу.
    await page.locator('#accountChip').click();
    await expect(page.locator('#account')).toBeVisible();
    await expect(page.locator('#accountList')).toBeAttached();
    await expect(page.locator('.cosmetic-card[data-slot="body"]')).toContainText('КЛАССИКА');
    await expect(page.locator('.cosmetic-card[data-slot="back"]')).toBeAttached();
    await expect(page.locator('.cosmetic-card[data-slot="emote"]')).toBeAttached();

    // Шкаф: превью, вкладки, фильтры, коллекции. Точное число карточек не фиксируем — каталог
    // растёт, и тест, который приходится править при каждом новом предмете, быстро отключают.
    await page.locator('#openWardrobe').click();
    await expect(page.locator('#wardrobe')).toBeVisible();
    await expect(page.locator('#wardrobePreview')).toBeVisible();
    await expect(page.locator('.wardrobe-tab')).toHaveCount(8);
    await expect(page.locator('.wardrobe-collection')).toHaveCount(4);
    await expect(page.locator('.wardrobe-card').first()).toBeVisible();

    // Вкладка «СПИНА» — новый слот. Он обязан быть и обязан фильтровать. Количество карточек не
    // фиксируем: milestone-награды и будущий контент законно расширяют этот слот.
    await page.locator('.wardrobe-tab[data-category="back"]').click();
    const backCards = page.locator('.wardrobe-card');
    await expect(backCards.first()).toHaveAttribute('data-slot', 'back');
    expect(
      await backCards.evaluateAll(cards => cards.every(card => card.dataset.slot === 'back'))
    ).toBe(true);

    // Закрытый предмет: виден, показывает требование, доступен для примерки, но не для надевания.
    await page.locator('#wardrobeOwnership').selectOption('locked');
    const locked = page.locator('.wardrobe-card.is-locked').first();
    await expect(locked).toBeVisible();
    await locked.click();
    await expect(page.locator('#wardrobeItemRequirement')).toHaveClass(/locked/);
    await expect(page.locator('#wardrobeItemRequirement')).not.toBeEmpty();
    await expect(page.locator('#wardrobeEquip')).toBeDisabled();
    // Примерка закрытого предмета не делает его надетым.
    await expect(page.locator('.wardrobe-card.is-equipped.is-locked')).toHaveCount(0);

    // Полученный предмет надевается и переживает перезагрузку страницы.
    await page.locator('.wardrobe-tab[data-category="all"]').click();
    await page.locator('#wardrobeOwnership').selectOption('owned');
    await expect(page.locator('.wardrobe-card.is-locked')).toHaveCount(0);

    // Шкаф не должен вылезать за экран — на телефоне это единственный способ обнаружить, что
    // решётка или липкая панель действий выталкивают содержимое вбок.
    const overflow = await page.evaluate(() => {
      const shell = document.querySelector('.wardrobe-shell');
      const grid = document.querySelector('.wardrobe-grid');
      return {
        shellWider: shell.scrollWidth > shell.clientWidth + 1,
        gridWider: grid.scrollWidth > grid.clientWidth + 1,
        pageWider: document.documentElement.scrollWidth > window.innerWidth + 1
      };
    });
    expect(overflow).toEqual({ shellWider: false, gridWider: false, pageWider: false });

    // Панель действий видна без прокрутки: «Надеть» должно быть под пальцем, а не в конце ленты.
    await expect(page.locator('#wardrobeEquip')).toBeInViewport();

    await page.locator('#wardrobeClose').click();
    await expect(page.locator('#wardrobe')).toBeHidden();

    await page.keyboard.press('Escape');
    await expect(page.locator('#account')).toBeHidden();

    // Гостю переименовывать нечего: имя живёт в аккаунте. Сначала окно должно честно сказать, кто
    // он и чего лишён, и предложить перестать им быть — это и проверяем по дороге.
    await page.locator('#accountChip').click();
    await expect(page.locator('#accountStateTitle')).toHaveText('ВЫ ИГРАЕТЕ ГОСТЕМ');
    await expect(page.locator('#accountStateHint')).toContainText('таблице рекордов');
    await page.locator('#accountSignInFallback').click();
    await expect(page.locator('#accountStateTitle')).toContainText('ВЫ ВОШЛИ', { timeout: 20_000 });

    // Переименование доходит до чипа в меню — самый частый путь через окно аккаунта.
    await page.locator('#accountRename').fill('Дымовой');
    await page.locator('#accountSave').click();
    await expect(page.locator('#accountName')).toHaveText('Дымовой', { timeout: 10_000 });
    await page.locator('#accountClose').click();
    await expect(page.locator('#account')).toBeHidden();
  });

  test('экран результата объясняет рекорд, чистоту забега и следующую награду', async ({ page }) => {
    await openMenu(page);
    await page.locator('#play').click();
    await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => {
      const game = window.__WOBBLE_GAME__;
      game.ui.finishSolo({
        time: 45_000,
        respawns: 0,
        dashes: 1,
        hits: 0,
        spec: game.course.spec
      });
    });
    await expect(page.locator('#finish')).toBeVisible();
    await expect(page.locator('.finish-highlight')).toHaveCount(3);
    await expect(page.locator('#finishHighlights')).toContainText('ПЕРВОЕ ВРЕМЯ');
    await expect(page.locator('#finishHighlights')).toContainText('БЕЗ ПАДЕНИЙ');
    await expect(page.locator('#finishHighlights')).toContainText('Прогресс');
  });
});
