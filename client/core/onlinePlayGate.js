// Убрать из меню то, что на этой площадке работать не может.
//
// Портальная сборка живёт на чужом домене, а наш сервер однодоменный: запросы аккаунта идут
// относительными путями с `credentials: 'same-origin'`, сессионная кука выставлена `SameSite=Lax`,
// CORS-заголовков сервер не отдаёт, а WebSocket пускает только свой origin. Поэтому «Гонка онлайн»
// и кооператив с портального адреса не заработают — не из-за площадки, а из-за нас (подробности и
// список того, что для этого нужно, — в `docs/MONETIZATION.md` §4.7).
//
// Показывать неработающую кнопку хуже, чем не показывать её вовсе: игрок нажмёт, увидит вечное
// «соединение потеряно» и решит, что сломана игра.
//
// УЗЛЫ ПРИ ЭТОМ ОСТАЮТСЯ В ДЕРЕВЕ, и это не полумера. Первая версия их удаляла — казалось надёжнее,
// раз спрятанное достижимо с клавиатуры. Но `bindMenu` (`client/ui/menuBindings.js`) рассчитывает на
// полную разметку: его `click()` вешает обработчик без проверки, и на первом же отсутствующем узле
// клиент падал с `Cannot read properties of null`. Терпимость к отсутствию я проверил у
// `MenuStageExperience` и распространил на всё меню — она там есть, а в соседнем модуле её нет.
//
// Атрибут `hidden` решает исходное возражение полностью: он убирает узел и из фокуса, и из дерева
// доступности. Берётся именно АТРИБУТ, а не класс `hidden`, которым меню переключает панели: класс
// оно снимет при переключении режима, атрибут — нет. Кнопки вдобавок отключаются, чтобы их нельзя
// было нажать из кода.

import { supportsOnlinePlay } from './PlatformResolver.js';

const ONLINE_TABS = ['.mode-tab[data-mode="multi"]', '.mode-tab[data-mode="coop"]'];
const ONLINE_PANELS = ['#multi', '#coop'];

function hide(node) {
  node.hidden = true;
  node.setAttribute?.('hidden', '');
}

export function applyOnlinePlayGate(platform, root = globalThis.document) {
  if (supportsOnlinePlay(platform)) return { hidden: 0 };
  if (!root?.querySelectorAll) return { hidden: 0 };

  let count = 0;
  for (const selector of ONLINE_TABS) {
    for (const node of root.querySelectorAll(selector) || []) {
      hide(node);
      node.disabled = true;
      node.setAttribute?.('aria-hidden', 'true');
      count += 1;
    }
  }
  for (const selector of ONLINE_PANELS) {
    for (const node of root.querySelectorAll(selector) || []) {
      hide(node);
      count += 1;
    }
  }
  return { hidden: count };
}
