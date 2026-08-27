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
  '#coop': 1
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

// Скрываются именно ВКЛАДКИ И ПАНЕЛИ, а не что попало: одиночная игра обязана уцелеть целиком.
test('на площадке скрываются обе онлайн-вкладки и обе панели', () => {
  const root = fakeRoot({ ...ONLINE_MARKUP, '.mode-tab[data-mode="single"]': 1, '#single': 1 });
  const result = applyOnlinePlayGate(PLATFORM.YANDEX, root);

  assert.equal(result.hidden, 4);
  assert.deepEqual([...root.touched.keys()].sort(), [
    '#coop',
    '#multi',
    '.mode-tab[data-mode="coop"]',
    '.mode-tab[data-mode="multi"]'
  ]);
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
