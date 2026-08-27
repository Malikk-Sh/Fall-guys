import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { PLATFORM, resolvePlatform, supportsOnlinePlay } from '../client/core/PlatformResolver.js';
import { applyOnlinePlayGate } from '../client/core/onlinePlayGate.js';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Минимальный корень: шлюзу нужен поиск узлов и возможность их скрыть.
function fakeRoot(selectors) {
  const touched = new Map();
  return {
    touched,
    node(selector) {
      return touched.get(selector);
    },
    querySelectorAll(selector) {
      const count = selectors[selector] ?? 0;
      return Array.from({ length: count }, () => {
        const node = { attrs: {}, setAttribute: (name, value) => (node.attrs[name] = value) };
        touched.set(selector, node);
        return node;
      });
    }
  };
}

const ONLINE_MARKUP = {
  '.mode-tab[data-mode="multi"]': 1,
  '.mode-tab[data-mode="coop"]': 1,
  '#multi': 1,
  '#coop': 1,
  '#accountChip': 1,
  '#profileOpen': 1
};

test('площадка объявляется файлом сборки, а неизвестное значение читается как свой домен', () => {
  assert.equal(resolvePlatform({ WOBBLE_PLATFORM: 'yandex' }), PLATFORM.YANDEX);
  assert.equal(resolvePlatform({ WOBBLE_PLATFORM: 'web' }), PLATFORM.WEB);
  // Ошибка односторонняя: чужой платформой себя не объявляем, поэтому чужой SDK не поднимется.
  assert.equal(resolvePlatform({ WOBBLE_PLATFORM: 'yadnex' }), PLATFORM.WEB);
  assert.equal(resolvePlatform({}), PLATFORM.WEB);
  assert.equal(resolvePlatform(undefined), PLATFORM.WEB);
});

test('онлайн-режимы доступны на своём домене и недоступны на площадке', () => {
  assert.equal(supportsOnlinePlay(PLATFORM.WEB), true);
  assert.equal(supportsOnlinePlay(PLATFORM.YANDEX), false);
});

test('на своём домене шлюз не трогает меню', () => {
  const root = fakeRoot(ONLINE_MARKUP);
  assert.deepEqual(applyOnlinePlayGate(PLATFORM.WEB, root), { hidden: 0 });
  assert.equal(root.touched.size, 0);
});

// Скрывается именно СЕТЕВОЕ, а не что попало: одиночная игра обязана уцелеть целиком.
//
// Кнопки аккаунта входят сюда наравне с вкладками, хотя вкладками не выглядят. Пропустить один лишь
// `signIn()` мало: `bindMenu` вешает на них обработчики, и нажатие уходит в `/api/auth/*`, а
// открытие профиля зовёт `accountProfile()` — то есть игрок видит рабочие на вид элементы, которые
// на площадке всегда кончаются ошибкой.
test('на площадке скрываются онлайн-вкладки, панели и вход в аккаунт', () => {
  const root = fakeRoot({ ...ONLINE_MARKUP, '.mode-tab[data-mode="single"]': 1, '#single': 1 });
  const result = applyOnlinePlayGate(PLATFORM.YANDEX, root);

  assert.equal(result.hidden, 6);
  assert.deepEqual([...root.touched.keys()].sort(), [
    '#accountChip',
    '#coop',
    '#multi',
    '#profileOpen',
    '.mode-tab[data-mode="coop"]',
    '.mode-tab[data-mode="multi"]'
  ]);
});

// ГОРЛОВИНА: все двадцать вызовов `/api/auth/*` идут через один `post`, и заслон стоит в нём.
//
// Это вывод из трёх подряд пропущенных мест: кнопки аккаунта, кооп-рейтинг, отправка соло-рекорда.
// Каждый раз я перечислял сетевые входы вручную и каждый раз ошибался. Заслон у горловины закрывает
// и то, чего в списке нет, и то, что напишут после.
test('запросы аккаунта не уходят с портальной сборки', async () => {
  const account = await import('../client/core/account.js');
  const calls = [];
  const fetchImpl = url => {
    calls.push(url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };

  const saved = globalThis.WOBBLE_PLATFORM;
  try {
    globalThis.WOBBLE_PLATFORM = 'yandex';
    const result = await account.authConfig({ fetchImpl });
    assert.deepEqual(calls, [], 'на площадке транспорт не должен трогать сеть');
    // Форма ответа — как у неудачного запроса: вызывающие уже умеют обрабатывать отказ.
    assert.equal(result?.google ?? null, null);

    globalThis.WOBBLE_PLATFORM = 'web';
    await account.authConfig({ fetchImpl });
    assert.equal(calls.length, 1, 'на своём домене запрос обязан уйти как прежде');
  } finally {
    if (saved === undefined) delete globalThis.WOBBLE_PLATFORM;
    else globalThis.WOBBLE_PLATFORM = saved;
  }
});

// Кооп-рейтинг не должен зависеть от того, что аккаунта случайно нет.
//
// Сегодня `loadCampaignRank` выходит по `playerId()`, и замер в браузере показывает ноль запросов к
// нашему домену. Но это побочное следствие: появится локальная личность — и десять запросов к чужому
// домену поедут сами. Условие, от которого зависит поведение, обязано быть названо в коде.
test('кооп-рейтинг закрыт признаком платформы, а не отсутствием аккаунта', () => {
  const source = fs.readFileSync(path.join(ROOT, 'client', 'ui', 'UI.js'), 'utf8');
  const guard = source.indexOf('if (!supportsOnlinePlay(resolvePlatform())) return;');
  const playerCheck = source.indexOf('if (!target || !this.playerId()) return;');
  assert.ok(guard > 0, 'заслон платформы обязан стоять в loadCampaignRank');
  assert.ok(guard < playerCheck, 'заслон обязан стоять ДО проверки игрока, а не после');
});

// Скрытие обязано быть АТРИБУТОМ, а не классом: класс `hidden` меню снимает при переключении
// режима, атрибут — нет. И кнопка вдобавок отключается, чтобы её нельзя было нажать из кода.
test('вкладка скрыта атрибутом и отключена, а не просто помечена классом', () => {
  const root = fakeRoot(ONLINE_MARKUP);
  applyOnlinePlayGate(PLATFORM.YANDEX, root);

  const tab = root.node('.mode-tab[data-mode="multi"]');
  assert.equal(tab.hidden, true);
  assert.equal(tab.attrs.hidden, '');
  assert.equal(tab.disabled, true);

  const panel = root.node('#multi');
  assert.equal(panel.hidden, true);
  assert.equal(panel.attrs.hidden, '');
});

// Узлы остаются в дереве, и это существенно.
//
// Первая версия их удаляла, и `bindMenu` падал с `Cannot read properties of null`: он вешает
// обработчики без проверки и рассчитывает на полную разметку. Терпимость к отсутствию есть у
// `MenuStageExperience`, но не у соседнего модуля — обобщать её было нельзя.
test('шлюз не удаляет узлы из дерева', () => {
  const root = fakeRoot(ONLINE_MARKUP);
  applyOnlinePlayGate(PLATFORM.YANDEX, root);
  for (const node of root.touched.values()) {
    assert.equal('remove' in node, false, 'шлюз не должен звать remove(): разметка нужна bindMenu');
  }
});

test('шлюз не падает без DOM и без узлов', () => {
  // Тот же модуль исполняется в тестах и в сборке ботов, где документа нет вовсе.
  assert.deepEqual(applyOnlinePlayGate(PLATFORM.YANDEX, null), { hidden: 0 });
  assert.deepEqual(applyOnlinePlayGate(PLATFORM.YANDEX, fakeRoot({})), { hidden: 0 });
});

// СТОРОЖ: каждый сетевой вход в `main.js` закрыт признаком, а не оставлен безусловным.
//
// Проверок в шлюзе недостаточно: он убирает кнопки, но если рядом останется безусловный
// `ensureNetwork()` или `signIn()`, портальная сборка всё равно полезет на чужой домен — молча, с
// 404 в консоли и «сервер не ответил» в интерфейсе. Именно так это и выглядело до правки.
test('сетевые входы в main.js не остаются безусловными', () => {
  const source = fs.readFileSync(path.join(ROOT, 'client', 'main.js'), 'utf8');
  const guarded = [
    /this\.accountReady = this\.onlinePlay \? this\.account\.signIn\(\)/,
    /if \(this\.onlinePlay\) this\.handleInvite\(\);/,
    /if \(this\.onlinePlay && NetworkManager\.hasSavedSession\(\)\) this\.ensureNetwork\(\);/
  ];
  for (const pattern of guarded) {
    assert.match(source, pattern, `сетевой вход обязан быть закрыт признаком: ${pattern}`);
  }
});
