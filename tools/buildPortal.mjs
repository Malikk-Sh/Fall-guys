// Сборка статического билда для игровых площадок.
//
// Свой сервер раздаёт клиент сырыми модулями с трёх точек монтирования: `client/` в корень,
// `shared/` в `/shared`, Three.js из `node_modules` в `/vendor` и `/vendor/addons`
// (`server/httpAssets.js`). Площадка ничего не монтирует — она принимает архив и раздаёт его со
// своего пути, поэтому всё, что начинается со слэша, там сломается.
//
// Сборка делает ровно три вещи: собирает эти четыре источника в одно дерево, переписывает
// абсолютные пути в относительные и кладёт рядом файл с именем платформы. Ни минификации, ни
// бандлинга здесь нет намеренно: игра и так грузится модулями, а лишний шаг сборки — это лишний
// источник расхождения между тем, что отлажено, и тем, что уехало на площадку.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Что НЕ уезжает на площадку.
//
// Список короткий, и каждая строка в нём обоснована ОТДЕЛЬНО. Имя файла обоснованием не является:
// в первой версии сюда попали `pwa-entry.js` и `pwa.css` «как PWA-обвязка», и оба оказались не тем,
// чем назывались. `pwa-entry.js` поднимает ВЕСЬ интерфейс — мобильный опыт, оформление меню,
// обучение, обратную связь, кооп-презентации, экран результатов, гардероб и награды, — а `pwa.css`
// стилизует в том числе `.fullscreen-toggle`, `.mobile-game-mode` и `.rotate-device`, то есть тот
// самый мобильный опыт. Портальный билд оставался бы с голым канвасом и без стилей на телефоне.
//
// Поэтому исключается только то, что на площадке не работает по устройству самой площадки:
//
// - `admin/` — панель управления. В архиве это была бы раздача внутреннего интерфейса кому угодно.
// - `service-worker.js` — в чужом iframe не нужен и мешает; сама PWA-обвязка гасится по платформе
//   в `client/pwa-entry.js`, поэтому регистрировать нечего.
// - `manifest.webmanifest` и `offline.html` — установка приложения и офлайн-страница существуют
//   только вместе с service worker.
const CLIENT_EXCLUDE = new Set(['admin', 'service-worker.js', 'manifest.webmanifest', 'offline.html']);

// Абсолютные ссылки в разметке. Ключ — что искать, значение — чем заменить относительно корня
// билда. `index.html` лежит в корне, поэтому префикс здесь всегда `./`.
const HTML_REWRITES = [
  ['"/vendor/', '"./vendor/'],
  ['"/privacy/', '"./privacy/']
];

function walkFiles(dir, filter = () => true, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, filter, found);
    else if (filter(full)) found.push(full);
  }
  return found;
}

// Импорты в файле: и `from './x.js'`, и `from"./x.js"` — минифицированный движок пишет без пробела
// и в двойных кавычках.
function importSpecifiers(source) {
  return [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
}

// Копирование ПО ЗАМЫКАНИЮ ИМПОРТОВ, а не каталогом целиком.
//
// Свой сервер монтирует `node_modules/three` и отдаёт из него только то, что браузер попросит, —
// лишние мегабайты никуда не едут. Архив площадки так не умеет: в него уезжает всё, что положили.
// Каталоги движка вместе с дополнениями весят 23 МБ, тогда как игре нужны два файла сборки и
// четыре дополнения со своими соседями.
//
// Поэтому копируются только достижимые файлы: от точек входа по относительным импортам вглубь.
// Голое имя `three` и префикс `three/addons/` разрешает import map, поэтому здесь они разбираются
// отдельно — иначе замыкание оборвалось бы на первом же таком импорте.
function copyModuleClosure(entries, { addonsRoot, addonsOut }) {
  const queue = [...entries];
  const done = new Set();
  while (queue.length) {
    const { from, to } = queue.shift();
    if (done.has(from)) continue;
    done.add(from);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);

    const source = fs.readFileSync(from, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (specifier === 'three') continue;
      let nextFrom;
      let nextTo;
      if (specifier.startsWith('three/addons/')) {
        const relative = specifier.slice('three/addons/'.length);
        nextFrom = path.join(addonsRoot, relative);
        nextTo = path.join(addonsOut, relative);
      } else if (specifier.startsWith('.')) {
        nextFrom = path.resolve(path.dirname(from), specifier);
        nextTo = path.resolve(path.dirname(to), specifier);
      } else continue;
      if (fs.existsSync(nextFrom)) queue.push({ from: nextFrom, to: nextTo });
    }
  }
  return done.size;
}

function copyTree(from, to, { exclude = new Set(), root = from } = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const relative = path.relative(root, path.join(from, entry.name));
    if (exclude.has(relative)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target, { exclude, root });
    else fs.copyFileSync(source, target);
  }
}

// Абсолютный спецификатор → относительный, с учётом глубины файла в дереве билда.
//
// Раскладка билда повторяет раскладку раздачи один в один, поэтому `/shared/x.js` из файла на
// глубине 1 — это `../shared/x.js`, а из корневого `main.js` — `./shared/x.js`. Считается по
// фактическому положению файла, а не по таблице: таблица разошлась бы с деревом при первом же
// новом каталоге.
export function relativeSpecifier(specifier, depth) {
  const prefix = depth === 0 ? './' : '../'.repeat(depth);
  return prefix + specifier.replace(/^\//, '');
}

export function rewriteModuleSource(source, depth) {
  return source.replace(/from '(\/[^']*)'/g, (_match, specifier) => {
    return `from '${relativeSpecifier(specifier, depth)}'`;
  });
}

function rewriteModulesInPlace(dir, root = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteModulesInPlace(full, root);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    const depth = path.relative(root, dir).split(path.sep).filter(Boolean).length;
    const before = fs.readFileSync(full, 'utf8');
    const after = rewriteModuleSource(before, depth);
    if (after !== before) fs.writeFileSync(full, after);
  }
}

// Разметка: import map, modulepreload и ссылка на политику.
//
// Import map правится отдельно от модулей: его значения резолвятся относительно АДРЕСА ДОКУМЕНТА, а
// не импортирующего файла, поэтому для голого `three` достаточно одного `./` независимо от того,
// из какой глубины его просят.
export function rewriteHtml(html, { platform }) {
  let out = html;
  for (const [from, to] of HTML_REWRITES) out = out.split(from).join(to);

  // У исключённых файлов убираются и ССЫЛКИ на них. Иначе билд грузится, но с 404 на каждый: браузер
  // такую ошибку фатальной не считает, и без проверки она уехала бы на площадку незамеченной.
  // Ровно так и случилось однажды — файл исключили, ссылку забыли.
  out = out.replace(/\s*<link[^>]*manifest\.webmanifest[^>]*>/g, '');

  // Имя платформы приходит отдельным файлом, а не инлайном: инлайн пришлось бы вносить в хеши CSP
  // нашего же сервера, хотя к нему этот билд отношения не имеет.
  const marker = `    <script src="./platform-config.js"></script>\n`;
  out = out.replace('</head>', `${marker}  </head>`);

  // SDK ПЛОЩАДКИ ЗДЕСЬ НЕ ПОДКЛЮЧАЕТСЯ, и это не забывчивость.
  //
  // В первой версии тег стоял, и он нарушал порядок из `docs/MONETIZATION.md` §9 сразу дважды: SDK
  // идёт ПОСЛЕ серверного контура rewarded-попыток, а до первого живого игрока обязан быть пройден
  // гейт — privacy с поимённым перечислением провайдеров, видимая пометка, маркировка, отчисления.
  // Ничего этого пока нет, а тег означал бы, что любой открытый артефакт грузит и исполняет чужой
  // SDK. Тот самый порядок я в соседнем PR приводил в согласие с выводами — и тут же нарушил его в
  // коде.
  //
  // Тег появится вместе с интеграционным срезом, когда контур будет готов и гейт пройден.
  return out;
}

// Площадки, для которых портальная сборка имеет смысл.
//
// `web` сюда НЕ входит: свой домен обслуживает наш сервер прямо из исходников, со своими точками
// монтирования и своим service worker. Портальная цель `web` была бы заведомо сломанной — билд
// объявляет платформу `web`, отчего `client/pwa-entry.js` поднимает `PwaController`, а тот
// регистрирует `service-worker.js`, которого в архиве нет по построению. Список — он же и проверка.
export const PLATFORMS = Object.freeze(['yandex']);

export function buildPortal({ platform = 'yandex', outDir } = {}) {
  // Опечатка в аргументе не должна давать «успешно собранный» архив.
  //
  // Без проверки `yadnex` прошёл бы насквозь: каталог удалён, файлы записаны, в консоли успех — а в
  // `platform-config.js` неизвестное значение, SDK не подключён, и `resolvePlatform` на площадке
  // молча откатится к `web`. Сборка выглядела бы рабочей и была бы негодной. Проверка стоит ДО
  // удаления каталога, чтобы ошибка не уносила с собой прошлый удачный билд.
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`неизвестная площадка ${JSON.stringify(platform)}; известны: ${PLATFORMS.join(', ')}`);
  }

  const out = outDir || path.join(ROOT, 'dist', platform);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  copyTree(path.join(ROOT, 'client'), out, { exclude: CLIENT_EXCLUDE });
  copyTree(path.join(ROOT, 'shared'), path.join(out, 'shared'));

  // Three.js лежит в `node_modules` и в репозиторий не входит — на своём сервере он монтируется
  // оттуда же (`server/index.js`). Путь берётся через resolve, а не собирается строкой: так сборка
  // сломается громко, если пакета нет, вместо того чтобы выдать архив без движка.
  // `exports` в пакете наружу отдаёт только главный вход, поэтому и `three/package.json`, и
  // `three/build/...` не резолвятся. Берём главный вход — он лежит в самом `build/`.
  const threeBuild = path.dirname(require.resolve('three'));
  const threeAddons = path.join(threeBuild, '..', 'examples', 'jsm');
  const vendorOut = path.join(out, 'vendor');
  const addonsOut = path.join(vendorOut, 'addons');

  // Точки входа: то, на что показывает import map, и дополнения, которые игра действительно
  // импортирует. Список дополнений собирается из исходников, а не пишется руками, — иначе он
  // разошёлся бы с кодом при первом же новом эффекте.
  const addonEntries = new Set();
  for (const file of walkFiles(path.join(ROOT, 'client'), name => name.endsWith('.js'))) {
    for (const specifier of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('three/addons/')) addonEntries.add(specifier.slice('three/addons/'.length));
    }
  }

  const entries = [
    { from: path.join(threeBuild, 'three.module.min.js'), to: path.join(vendorOut, 'three.module.min.js') },
    ...[...addonEntries].map(relative => ({
      from: path.join(threeAddons, relative),
      to: path.join(addonsOut, relative)
    }))
  ];
  copyModuleClosure(entries, { addonsRoot: threeAddons, addonsOut });

  rewriteModulesInPlace(out);

  const htmlPath = path.join(out, 'index.html');
  fs.writeFileSync(htmlPath, rewriteHtml(fs.readFileSync(htmlPath, 'utf8'), { platform }));

  // Вложенные страницы тоже навигируют, и их ссылки тоже абсолютные.
  //
  // `privacy/index.html` ведёт «Вернуться» на `/`. В корне своего домена это игра, а на площадке —
  // корень ЕЁ домена: игрок уходит на чужую страницу или в 404 и обратно не возвращается. Правится
  // по глубине самой страницы, как и модули.
  for (const nested of walkFiles(out, name => name.endsWith('.html'))) {
    if (nested === htmlPath) continue;
    const depth = path.relative(out, path.dirname(nested)).split(path.sep).filter(Boolean).length;
    const prefix = depth === 0 ? './' : '../'.repeat(depth);
    const before = fs.readFileSync(nested, 'utf8');
    const after = before.replace(
      /(src|href)="\/([^"]*)"/g,
      (_match, attr, rest) => `${attr}="${prefix}${rest}"`
    );
    if (after !== before) fs.writeFileSync(nested, after);
  }

  fs.writeFileSync(
    path.join(out, 'platform-config.js'),
    `// Создаётся сборкой. Определяет площадку явно, а не по имени хоста: iframe, CDN и превью\n` +
      `// адрес меняют, а этот файл едет вместе с билдом.\n` +
      `window.WOBBLE_PLATFORM = ${JSON.stringify(platform)};\n`
  );

  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const platform = process.argv[2] || 'yandex';
  try {
    const out = buildPortal({ platform });
    console.log(`Собрано в ${path.relative(ROOT, out)} для площадки ${platform}`);
  } catch (error) {
    // Ненулевой код обязателен: в CI молчаливо «успешная» сборка негодного архива хуже падения.
    console.error(`Сборка не выполнена: ${error.message}`);
    process.exitCode = 1;
  }
}
