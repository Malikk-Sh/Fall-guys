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
// `admin/` — панель управления: на площадке ей делать нечего, а её присутствие в архиве было бы
// раздачей внутреннего интерфейса кому угодно. Остальное — PWA-обвязка: service worker внутри
// чужого iframe не нужен и мешает, а манифест установки на площадке не значит ничего.
const CLIENT_EXCLUDE = new Set([
  'admin',
  'service-worker.js',
  'pwa-entry.js',
  'pwa.css',
  'manifest.webmanifest',
  'offline.html'
]);

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

  // PWA-обвязка не уезжает на площадку (`CLIENT_EXCLUDE`), поэтому из разметки убираются и ССЫЛКИ
  // на неё. Иначе билд грузится, но с 404 на каждый исключённый файл: браузер такую ошибку не
  // считает фатальной, и без проверки она уехала бы на площадку незамеченной. Так и случилось с
  // `pwa.css` — файл исключили, ссылку забыли.
  out = out.replace(/\s*<script[^>]*pwa-entry\.js[^>]*><\/script>/g, '');
  out = out.replace(/\s*<link[^>]*manifest\.webmanifest[^>]*>/g, '');
  out = out.replace(/\s*<link[^>]*href="pwa\.css"[^>]*>/g, '');

  // Имя платформы приходит отдельным файлом, а не инлайном: инлайн пришлось бы вносить в хеши CSP
  // нашего же сервера, хотя к нему этот билд отношения не имеет.
  const marker = `    <script src="./platform-config.js"></script>\n`;
  out = out.replace('</head>', `${marker}  </head>`);

  // SDK площадки подключается до модулей игры: `PlatformResolver` спрашивает его при старте.
  if (platform === 'yandex') {
    out = out.replace('</head>', `    <script src="https://yandex.ru/games/sdk/v2"></script>\n  </head>`);
  }
  return out;
}

export function buildPortal({ platform = 'yandex', outDir } = {}) {
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
  const out = buildPortal({ platform });
  console.log(`Собрано в ${path.relative(ROOT, out)} для площадки ${platform}`);
}
