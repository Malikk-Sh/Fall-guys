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

// Аккаунт — тоже сетевая игра, хотя вкладкой не выглядит: «сменить» уходит в `/api/auth/*`, а
// профиль зовёт `accountProfile()` и `listAvoidedPlayers()`. Сами запросы закрыты в транспорте
// (`post` в `client/core/account.js`), поэтому здесь речь только о том, чтобы не показывать игроку
// органы управления, которые на площадке ничего не сделают.
//
// НО ЧИП АККАУНТА ОСТАЁТСЯ, и это важнее, чем кажется. Он открывает экран `#account`, а внутри него
// лежит единственная кнопка «открыть шкаф». Спрятав чип, я закрыл игроку доступ к косметике —
// локальной, хранимой в браузере и к серверу отношения не имеющей, то есть к части одиночной игры.
// Скрывать надо сетевое внутри панели, а не вход в панель целиком.
const ONLINE_ACCOUNT = ['#profileOpen'];

// Сетевое внутри экрана аккаунта. Для этих узлов прячется вся секция `.account-section`, иначе от
// неё остался бы заголовок без содержимого.
const ONLINE_ACCOUNT_SECTIONS = ['#accountRename', '#accountList'];

// А это — отдельные органы управления, у которых своей секции нет: вход стоит внутри блока
// личности, где рядом лежит текст «вы играете гостем», и его убирать не нужно.
const ONLINE_ACCOUNT_CONTROLS = ['#accountSignIn'];

function hide(node) {
  node.hidden = true;
  node.setAttribute?.('hidden', '');
}

export function applyOnlinePlayGate(platform, root = globalThis.document) {
  if (supportsOnlinePlay(platform)) return { hidden: 0 };
  if (!root?.querySelectorAll) return { hidden: 0 };

  let count = 0;
  for (const selector of [...ONLINE_TABS, ...ONLINE_ACCOUNT]) {
    for (const node of root.querySelectorAll(selector) || []) {
      hide(node);
      node.disabled = true;
      count += 1;
    }
  }
  for (const selector of ONLINE_ACCOUNT_CONTROLS) {
    for (const node of root.querySelectorAll(selector) || []) {
      hide(node);
      count += 1;
    }
  }
  // Секцию целиком, а не только орган управления: иначе останется заголовок без содержимого.
  for (const selector of ONLINE_ACCOUNT_SECTIONS) {
    for (const node of root.querySelectorAll(selector) || []) {
      hide(node.closest?.('.account-section') || node);
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
