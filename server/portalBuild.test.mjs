import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { PLATFORMS, buildPortal, relativeSpecifier, rewriteModuleSource } from '../tools/buildPortal.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Билд собирается один раз на весь файл: он копирует Three.js целиком, и делать это в каждом тесте
// значило бы платить секунды за одно и то же дерево.
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-portal-'));
buildPortal({ platform: 'yandex', outDir: OUT });

test.after(() => fs.rmSync(OUT, { recursive: true, force: true }));

function walk(dir, filter = () => true, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, found);
    else if (filter(full)) found.push(full);
  }
  return found;
}

test('глубина решает префикс, а не таблица путей', () => {
  assert.equal(relativeSpecifier('/shared/protocol.js', 0), './shared/protocol.js');
  assert.equal(relativeSpecifier('/shared/protocol.js', 1), '../shared/protocol.js');
  assert.equal(relativeSpecifier('/shared/protocol.js', 2), '../../shared/protocol.js');
});

test('переписывается спецификатор импорта, а не всякая строка со слэшем', () => {
  const source = ["import { a } from '/shared/a.js';", "const url = '/vendor/keep.js';"].join('\n');
  const out = rewriteModuleSource(source, 1);
  assert.match(out, /from '\.\.\/shared\/a\.js'/);
  // Строковый литерал — не импорт: трогать его сборка не имеет права, иначе она чинила бы
  // то, чего не понимает.
  assert.match(out, /const url = '\/vendor\/keep\.js'/);
});

// ГЛАВНАЯ ПРОВЕРКА: путь не просто перестал быть абсолютным, а ведёт к существующему файлу.
//
// Проверка «не начинается со слэша» прошла бы и на пути, промахнувшемся мимо каталога на уровень, —
// а именно так ошибается расчёт глубины. Здесь каждый спецификатор резолвится от места самого
// файла и проверяется на существование.
test('каждый относительный импорт в билде ведёт к файлу, который в билде есть', () => {
  const scripts = walk(OUT, file => file.endsWith('.js'));
  assert.ok(scripts.length > 50, `в билде должны быть модули, найдено ${scripts.length}`);

  const misses = [];
  let checked = 0;
  for (const file of scripts) {
    // Три.js и его дополнения приезжают как есть и своих путей не меняют — их не проверяем.
    if (file.startsWith(path.join(OUT, 'vendor'))) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/from '(\.[^']*)'/g)) {
      checked += 1;
      const target = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(target)) misses.push(`${path.relative(OUT, file)} → ${specifier}`);
    }
  }

  assert.ok(checked > 100, `относительных импортов должно быть много, проверено ${checked}`);
  assert.deepEqual(misses, [], `битые пути в билде:\n${misses.join('\n')}`);
});

test('абсолютных спецификаторов в билде не остаётся', () => {
  const leftovers = [];
  for (const file of walk(OUT, name => name.endsWith('.js'))) {
    if (file.startsWith(path.join(OUT, 'vendor'))) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/from '\//.test(source)) leftovers.push(path.relative(OUT, file));
  }
  assert.deepEqual(leftovers, []);
});

test('внутренние каталоги и обвязка service worker на площадку не уезжают', () => {
  // Панель управления в архиве означала бы раздачу внутреннего интерфейса кому угодно.
  assert.equal(fs.existsSync(path.join(OUT, 'admin')), false, 'admin/ не должен попадать в билд');
  // Установка приложения и офлайн-страница существуют только вместе с service worker.
  for (const name of ['service-worker.js', 'manifest.webmanifest', 'offline.html']) {
    assert.equal(fs.existsSync(path.join(OUT, name)), false, `${name} не должен попадать в билд`);
  }
});

// Интерфейс обязан уехать целиком, и это отдельная проверка, потому что ошибиться тут легко и тихо.
//
// В первой версии `pwa-entry.js` и `pwa.css` были исключены «как PWA-обвязка» — по имени. На деле
// первый поднимает ВЕСЬ интерфейс (мобильный опыт, меню, обучение, результаты, гардероб, награды),
// а второй стилизует в том числе мобильный опыт. Портальный билд оставался с голым канвасом и без
// стилей на телефоне — и грузился при этом без единой ошибки, поэтому ни один тест путей и ни
// открытие в браузере этого не показали.
test('интерфейс уезжает на площадку целиком', () => {
  for (const name of ['pwa-entry.js', 'pwa.css', 'styles.css', 'main.js']) {
    assert.ok(fs.existsSync(path.join(OUT, name)), `${name} обязан быть в билде`);
  }
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  assert.match(html, /pwa-entry\.js/, 'бутстрап интерфейса обязан остаться подключённым');
  assert.match(html, /href="pwa\.css"/, 'стили мобильного опыта обязаны остаться подключёнными');
});

// Стили, которые модули подключают САМИ, сборка переписать не может — и не должна пытаться.
//
// Она правит спецификаторы импорта; `link.href = '/menu-ux.css'` спецификатором не является и
// прошёл бы мимо. Семь таких мест обнаружились ровно тогда, когда интерфейс перестали выкидывать
// из билда: на подпути площадки все семь давали 404, и меню, обучение, результаты, кооп и гардероб
// оставались без стилей.
//
// Правило поэтому источниковое: адрес считается от `import.meta.url`, а не от корня. Это верно и
// для площадки, и для глубоких маршрутов нашего SPA, где документ лежит не в корне. Сторож стоит
// здесь, чтобы правило не пришлось открывать заново.
test('модули не подключают свои стили от корня домена', () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'client'), name => name.endsWith('.js'))) {
    if (file.includes(`${path.sep}service-worker.js`)) continue; // свой список путей, свои правила
    const source = fs.readFileSync(file, 'utf8');
    if (/\.href\s*=\s*'\//.test(source)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `абсолютный путь к ассету сломается на подпути:\n${offenders.join('\n')}`);
});

// Вложенные страницы навигируют не хуже главной, и их ссылки тоже правятся.
test('обратные ссылки вложенной страницы ведут в корень игры, а не домена', () => {
  const privacy = fs.readFileSync(path.join(OUT, 'privacy', 'index.html'), 'utf8');
  assert.doesNotMatch(privacy, /href="\/"/, 'ссылка в корень домена уведёт игрока с площадки');
  assert.match(privacy, /href="\.\.\/"/, 'возврат обязан вести в корень игры по глубине страницы');
});

test('неизвестная площадка останавливает сборку, а не даёт негодный архив', () => {
  // Каталог берётся свой и заведомо несуществующий: проверка «его не создали» обязана говорить об
  // ЭТОМ запуске, а не наследовать остаток от прошлого.
  const never = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-never-'));
  fs.rmSync(never, { recursive: true, force: true });

  assert.throws(() => buildPortal({ platform: 'yadnex', outDir: never }), /yadnex/);
  // И каталог при этом не создан: проверка аргумента стоит до записи артефакта.
  assert.equal(fs.existsSync(never), false);
});

test('политика конфиденциальности едет вместе с билдом', () => {
  // Её требует гейт перед первой публикацией (`docs/MONETIZATION.md` §9), и ссылка обязана
  // работать из архива, а не вести на наш домен.
  assert.ok(fs.existsSync(path.join(OUT, 'privacy', 'index.html')));
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  assert.match(html, /href="\.\/privacy\//);
  assert.doesNotMatch(html, /href="\/privacy\//);
});

// На площадку едет ДРУГАЯ политика, и это не оформление, а достоверность.
//
// Полная описывает аккаунты, вход через Google и обработку технических данных нашим сервером. В
// портальной сборке всё это неправда: аккаунтов нет, входа нет, до сервера не доходит ни один
// запрос — последнее закреплено замером в `e2e/portal.spec.js`. Уехавшая полная политика заявляла
// бы игроку обработку, которой не происходит.
test('на площадку едет портальная политика, а не политика сайта', () => {
  const portal = fs.readFileSync(path.join(OUT, 'privacy', 'index.html'), 'utf8');
  const site = fs.readFileSync(path.join(ROOT, 'client', 'privacy', 'index.html'), 'utf8');
  assert.notEqual(portal, site, 'на площадку уехала политика сайта');

  // То, чего на площадке нет, не должно и упоминаться как происходящее.
  for (const claim of ['Google Identity Services', 'cookie сессии', 'код восстановления']) {
    assert.ok(!portal.includes(claim), `портальная политика заявляет то, чего там нет: ${claim}`);
  }

  // И наоборот: она обязана сказать главное — что данные не покидают браузер.
  assert.match(portal, /целиком в вашем браузере/);
});

// Исходник портальной политики лежит вне `client/`, и на нашем сайте её быть не должно: там
// действует полная. Заодно проверяется, что сборка не подсунет молча политику сайта, если файла
// вдруг не окажется.
test('портальная политика не раздаётся с нашего сайта и не подменяется молча', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'portalPrivacy.html')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'client', 'privacy', 'portal.html')));

  const source = fs.readFileSync(path.join(ROOT, 'tools', 'buildPortal.mjs'), 'utf8');
  assert.match(source, /throw new Error\('нет tools\/portalPrivacy\.html/);
});

// Разметка не должна ссылаться на то, чего в билде нет.
//
// Проверка появилась после настоящего промаха: `pwa.css` исключили из билда, а `<link>` на него в
// разметке оставили. Браузер такую ошибку фатальной не считает — игра грузится, просто с 404 в
// консоли, — поэтому ни один статический тест путей её не заметил, и уехала бы она на площадку
// молча. Здесь проверяются ВСЕ локальные ссылки разметки разом, а не один забытый файл.
test('каждая локальная ссылка разметки ведёт к файлу, который в билде есть', () => {
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  const misses = [];
  let checked = 0;
  for (const [, attr] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    // Внешние адреса и якоря проверять нечем и незачем: SDK площадки живёт не в архиве.
    if (/^(https?:)?\/\//.test(attr) || attr.startsWith('#') || attr.startsWith('data:')) continue;
    checked += 1;
    const target = path.join(OUT, attr.replace(/^\.\//, '').split('?')[0]);
    const ok = fs.existsSync(target) || fs.existsSync(path.join(target, 'index.html'));
    if (!ok) misses.push(attr);
  }
  assert.ok(checked > 3, `ссылок должно быть больше, проверено ${checked}`);
  assert.deepEqual(misses, [], `разметка ссылается на отсутствующее:\n${misses.join('\n')}`);
});

test('движок лежит там, куда показывает import map', () => {
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  const map = JSON.parse(html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/)[1]);
  for (const target of Object.values(map.imports)) {
    assert.ok(target.startsWith('./'), `import map обязан быть относительным, а там ${target}`);
    // Значение с косой чертой на конце — префикс каталога, без неё — файл.
    const resolved = path.join(OUT, target);
    assert.ok(fs.existsSync(resolved), `import map ведёт в никуда: ${target}`);
  }
});

// Движок кладётся по замыканию импортов, а не каталогом целиком.
//
// Свой сервер отдаёт из `node_modules` только запрошенное, поэтому лишний вес там не виден. В архив
// же уезжает всё, что положили: каталоги движка с дополнениями весят 23 МБ против 0.8 МБ
// достижимого. Проверка держит именно это — она покраснеет, если копирование однажды заменят на
// «скопировать каталог», и разница уйдёт игроку в трафик.
test('в билд едет только достижимая часть движка', () => {
  const vendor = walk(path.join(OUT, 'vendor'), name => name.endsWith('.js'));
  assert.ok(vendor.length > 0, 'движок обязан быть в билде');
  assert.ok(vendor.length < 40, `в vendor попало ${vendor.length} файлов — похоже на копию каталога`);

  // Транзитивная зависимость обязана приехать: `three.module.min.js` тянет ядро сам, и без него
  // билд не заработал бы, хотя import map на ядро не показывает.
  assert.ok(fs.existsSync(path.join(OUT, 'vendor', 'three.core.min.js')));

  // Как и соседи дополнений, которых нет ни в одном импорте клиента.
  assert.ok(fs.existsSync(path.join(OUT, 'vendor', 'addons', 'postprocessing', 'Pass.js')));

  // А неиспользуемых наборов быть не должно: они и составляют те самые мегабайты.
  assert.equal(fs.existsSync(path.join(OUT, 'vendor', 'three.webgpu.js')), false);
  assert.equal(fs.existsSync(path.join(OUT, 'vendor', 'addons', 'loaders')), false);
});

test('площадка объявлена файлом сборки, а не именем хоста', () => {
  const config = fs.readFileSync(path.join(OUT, 'platform-config.js'), 'utf8');
  assert.match(config, /window\.WOBBLE_PLATFORM = "yandex"/);
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  assert.match(html, /<script src="\.\/platform-config\.js"><\/script>/);
  // Конфиг обязан исполниться ДО модулей игры: `PlatformResolver` читает его при старте.
  //
  // Сравнивается положение именно ИСПОЛНЯЕМОГО тега модуля, а не первого упоминания `main.js`:
  // выше по разметке стоит `modulepreload`, но это подсказка загрузчику, а не исполнение. Сам
  // порядок при этом соблюдается и без сравнения строк — классический скрипт в `head` исполняется
  // раньше отложенного модуля, — но проверка ловит перестановку тега в конец.
  const moduleTag = html.indexOf('<script type="module" src="main.js">');
  assert.ok(moduleTag > 0, 'входной модуль обязан остаться в разметке');
  assert.ok(html.indexOf('platform-config.js') < moduleTag);
});

// Сторонний код в архив не попадает, пока не пройден гейт.
//
// В первой версии сборка вставляла тег Yandex SDK, и любой открытый артефакт грузил чужой скрипт.
// Это нарушало порядок из `docs/MONETIZATION.md` §9 дважды: SDK идёт после серверного контура
// rewarded-попыток, а до первого живого игрока обязан быть пройден гейт — privacy с поимённым
// перечислением провайдеров, видимая пометка, маркировка, отчисления. Проверка нарочно шире, чем
// «нет тега Яндекса»: она держит правило, а не один его случай.
test('в билд не попадает сторонний код', () => {
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  const external = [...html.matchAll(/(?:src|href)="((?:https?:)?\/\/[^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(external, [], `до гейта сторонних ресурсов быть не должно:\n${external.join('\n')}`);
});

test('портальной целью может быть только площадка', () => {
  // `web` обслуживает наш сервер из исходников. Как портальная цель он был бы заведомо сломан:
  // `PwaController` запустился бы и полез регистрировать service worker, которого в архиве нет.
  assert.deepEqual([...PLATFORMS], ['yandex']);
  assert.throws(() => buildPortal({ platform: 'web', outDir: path.join(OUT, '..', 'nope') }), /web/);
});

test('исходное дерево сборка не трогает', () => {
  // Переписывание идёт по копии. Если бы оно шло по оригиналу, свой сервер сломался бы молча:
  // относительные пути в `client/` не разрешатся с его точек монтирования.
  const source = fs.readFileSync(path.join(ROOT, 'client', 'main.js'), 'utf8');
  assert.match(source, /from '\/shared\//, 'в исходниках абсолютные пути обязаны остаться');
});
