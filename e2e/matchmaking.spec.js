import { test, expect } from '@playwright/test';

async function openCoop(context) {
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#menu')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#accountName')).not.toHaveText('…', { timeout: 20_000 });
  await page.locator('[data-mode="coop"]').click();
  await expect(page.locator('#coopFind')).toBeVisible();
  return page;
}

async function findPartner(page) {
  await page.locator('#coopFind').click();
  // Второй игрок может получить match в том же сетевом такте и вообще не увидеть WAITING.
  // Проверяем пользовательское намерение здесь, а ожидание — только в сценариях без пары.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector('#coopFind')?.dataset.searching === 'true' ||
          !document.querySelector('#hud')?.classList.contains('hidden')
      )
    )
    .toBe(true);
}

async function expectMatched(page) {
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__WOBBLE_GAME__?.remotes?.size || 0)).toBe(1);
}

test.describe('быстрый подбор кооперативной пары', () => {
  test.setTimeout(90_000);

  test('два браузера проходят waiting, автоматически стартуют и восстанавливаются после reload', async ({
    browser
  }) => {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const first = await openCoop(firstContext);
    const second = await openCoop(secondContext);
    try {
      await findPartner(first);
      await findPartner(second);
      await Promise.all([expectMatched(first), expectMatched(second)]);

      await first.reload();
      await expectMatched(first);
      expect(await first.evaluate(() => window.__WOBBLE_GAME__?.mode)).toBe('coop');

      await first.locator('#leaveMatch').click();
      await first.locator('#leaveMatch').click();
      await expect(first.locator('#menu')).toBeVisible({ timeout: 15_000 });
    } finally {
      await Promise.all([firstContext.close(), secondContext.close()]);
    }
  });

  test('поиск можно отменить без создания комнаты', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await openCoop(context);
    try {
      await findPartner(page);
      await page.locator('#coopFind').click();
      await expect(page.locator('#coopStatus')).toContainText('Поиск отменён');
      await expect(page.locator('#coopFind')).toHaveAttribute('data-searching', 'false');
      await expect(page.locator('#coopFind')).toContainText('ИГРАТЬ ГЛАВУ 1');
      expect(await page.evaluate(() => window.__WOBBLE_GAME__?.net?.roomCode)).toBeFalsy();
    } finally {
      await context.close();
    }
  });

  test('закрытая вкладка удаляется из очереди, а следующий игрок ждёт четвёртого', async ({ browser }) => {
    const abandonedContext = await browser.newContext();
    const waitingContext = await browser.newContext();
    const abandoned = await openCoop(abandonedContext);
    const waiting = await openCoop(waitingContext);
    try {
      await findPartner(abandoned);
      await abandonedContext.close();
      await findPartner(waiting);
      await expect(waiting.locator('#coopStatus')).toContainText('Ищем напарника');
      await expect(waiting.locator('#hud')).toBeHidden();

      const fourthContext = await browser.newContext();
      const fourth = await openCoop(fourthContext);
      try {
        await findPartner(fourth);
        await Promise.all([expectMatched(waiting), expectMatched(fourth)]);
      } finally {
        await fourthContext.close();
      }
    } finally {
      await waitingContext.close();
    }
  });

  test('третий игрок остаётся в очереди, пока первая пара уже играет', async ({ browser }) => {
    const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    const [first, second, third] = await Promise.all(contexts.map(openCoop));
    try {
      await findPartner(first);
      await findPartner(second);
      await Promise.all([expectMatched(first), expectMatched(second)]);
      await findPartner(third);
      await expect(third.locator('#coopStatus')).toContainText('Ищем напарника');
      await expect(third.locator('#hud')).toBeHidden();
      expect(await third.evaluate(() => window.__WOBBLE_GAME__?.remotes?.size || 0)).toBe(0);
    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });
});
