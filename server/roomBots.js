'use strict';

// Боты как участники комнаты.
//
// Задача этого файла — сделать так, чтобы остальной сервер о ботах НЕ ЗНАЛ. Бот появляется в
// room.players обычной записью игрока, только без сокета, и дальше рассылка, подсчёт финиша и
// завершение матча работают с ним ровно теми же путями, что и с человеком:
//
//   broadcast   пропускает участника, которому некуда слать (canSend(null) — ложь);
//   checkMatchEnd ждёт, пока все finished, и бот выставляет этот признак так же, как живой игрок;
//   leaderboard  строится по finished и time, и бот попадает в него на общих основаниях.
//
// Единственное, чего сервер не делает сам, — не двигает бота. Живому игроку состояние присылает
// его клиент; за бота шаг физики делает snapshot-цикл, вызывая stepBots.
//
// Почему модуль загружается через динамический import. Модель бота (raceBot.mjs) тянет за собой
// клиентские модули — Player, Course, — а те написаны для браузера и импортируют зависимости по
// абсолютным путям вида '/shared/...'. В Node это разрешает client-loader, и до его регистрации
// импорт невозможен. Поэтому загрузка отложена и асинхронна, а до её завершения боты просто
// недоступны: сервер при этом работает как раньше, без единого ветвления в игровом коде.

const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const { raceSpawnFor } = require('../shared/raceGrid.js');

// Ботов в одной комнате не больше этого числа. Ограничение не про процессор — замер дал 0.28 мс на
// тик при восьми ботах против бюджета 16.7, — а про смысл: комната, где живых меньше, чем ботов,
// перестаёт быть многопользовательской игрой и становится одиночной с декорациями.
const MAX_BOTS_PER_ROOM = 8;

let runtime = null;
let loading = null;
let registered = false;

// Регистрация загрузчика клиентских модулей. Идемпотентна: повторный вызов ничего не делает, иначе
// загрузчики стопкой накладывались бы друг на друга.
function enableClientModules() {
  if (registered) return;
  registered = true;
  register('./client-loader.mjs', pathToFileURL(path.join(__dirname, '/')));
}

// Загрузить модель бота. Вызывается один раз при старте сервера; до её завершения spawnBots
// возвращает 0 и комната просто остаётся без ботов.
function preloadBots() {
  if (runtime) return Promise.resolve(runtime);
  if (loading) return loading;
  enableClientModules();

  // Не начинаем ESM import в том же синхронном tick, в котором index.js ещё загружает CommonJS
  // модули. В Node 24 одновременные import()/require() одного ESM-графа могут попасть в состояние
  // "module not yet fully loaded". В нашем графе бот через CosmeticRenderer импортирует
  // shared/cosmetics.js, а серверная SocialCosmetics требует тот же файл во время startup.
  // Микрозадача даёт index.js закончить синхронные require, после чего зависимости импортируются
  // последовательно — без нескольких конкурирующих loader requests одного графа.
  loading = Promise.resolve()
    .then(async () => {
      const bots = await import('./raceBot.mjs');
      const course = await import('../client/game/Course.js');
      const three = await import('three');
      runtime = {
        RaceBot: bots.RaceBot,
        BotField: bots.BotField,
        FIXED_DT: bots.FIXED_DT,
        Course: course.Course,
        THREE: three
      };
      return runtime;
    })
    .catch(error => {
      loading = null;
      throw error;
    });
  return loading;
}

const botsReady = () => runtime !== null;

function nextBotIndex(room) {
  for (let index = 0; index < MAX_BOTS_PER_ROOM; index += 1) {
    if (!room.players.has(`bot:${index}`)) return index;
  }
  return -1;
}

// Серверная модель бота должна начинать там же, где клиент рисует его слот. Без этого живые
// игроки расходятся по решётке, а боты на первом snapshot всё равно схлопываются в центре.
function placeBotsOnGrid(room) {
  const bots = room?.bots;
  if (!bots || !runtime) return;
  const total = room.players.size;
  for (const entry of bots.list) {
    const player = room.players.get(entry.id);
    if (!player) continue;
    const start = raceSpawnFor(room.spec, player.slot, total);
    const position = new runtime.THREE.Vector3(start.x, start.y, start.z);
    // Player.respawn() без авторитетной позиции возвращается в player.spawn. Один teleport менял
    // только текущую физику, поэтому первый промах бота снова схлопывал его в общий центр.
    entry.bot.player.spawn.copy(position);
    entry.bot.player.teleport(position);
  }
}

// Убрать одного бота — последний добавленный исчезает первым. Возвращаем -1, а не 1: текущий
// вызывающий код проверяет только truthy/falsy и после любого изменения пересчитывает слоты и
// рассылает лобби; знак при этом остаётся полезным для тестов и диагностики.
function removeOneBot(room) {
  const bots = room?.bots;
  if (!bots?.list?.length) return 0;
  const entry = bots.list.pop();
  room.players.delete(entry.id);
  const fieldIndex = bots.field.bots.indexOf(entry.bot);
  if (fieldIndex >= 0) bots.field.bots.splice(fieldIndex, 1);
  entry.bot.dispose();

  if (!bots.list.length) {
    // BotField уже не содержит удалённого бота, поэтому dispose освобождает только общую трассу.
    bots.field.dispose();
    room.bots = null;
  } else {
    placeBotsOnGrid(room);
  }
  return -1;
}

// Завести ботов в комнате. `count > 0` теперь означает размер ДОБАВЛЯЕМОЙ партии, а count === 0 —
// убрать одного. Такой ноль сохраняет старый wire-type addBots и совместимость с прежними клиентами:
// старое сообщение {count:3} по-прежнему добавляет троих, а новый интерфейс может слать +1/-1 без
// второго почти идентичного обработчика протокола.
// skill принимает либо один уровень на всех, либо список — тогда уровень выбирается по стабильному
// индексу бота. Поэтому последовательные +1 дают тот же микс, что и добавление всей группы сразу.
function spawnBots(room, { count = 1, skill = 'steady' } = {}) {
  const skills = Array.isArray(skill) && skill.length ? skill : [skill];
  if (!room) return 0;
  const requested = Math.floor(Number(count));
  if (requested === 0) return removeOneBot(room);
  if (!runtime || !Number.isFinite(requested) || requested < 0) return 0;

  const existing = room.bots?.list?.length || 0;
  const wanted = Math.max(0, Math.min(requested, MAX_BOTS_PER_ROOM - existing));
  if (!wanted) return 0;

  // Одна трасса на всю комнату. Отдельная копия каждому боту стоила бы около мегабайта: геометрия
  // у всех одна и та же, и держать её в одном экземпляре — не оптимизация, а очевидность. Общая
  // трасса означает и общие часы — их держит поле (BotField), а не каждый бот сам по себе.
  if (!room.bots) {
    const course = new runtime.Course(new runtime.THREE.Scene(), room.spec, { quality: 'low' });
    room.bots = { field: new runtime.BotField(course), course, list: [], spec: room.spec, run: 0 };
  }
  const bots = room.bots;

  // Бот встаёт в очередь входа после всех, кто уже в комнате: по этому порядку раздаются слоты, и
  // сравнение с undefined давало бы в компараторе NaN — то есть «равно» для любой пары.
  let joinOrder = Number.isFinite(room.nextJoinOrder) ? room.nextJoinOrder : room.players.size;
  let added = 0;
  for (; added < wanted; added += 1) {
    const index = nextBotIndex(room);
    if (index < 0) break;
    const bot = new runtime.RaceBot(bots.course, {
      skill: skills[index % skills.length],
      seed: room.spec.seed,
      index
    });
    bots.field.bots.push(bot);
    const id = `bot:${index}`;
    const entry = { id, bot };
    bots.list.push(entry);
    room.players.set(id, {
      id,
      name: bot.name,
      // Бот всегда готов: спрашивать у него готовность не у кого, а неготовый участник не дал бы
      // комнате стартовать.
      ready: true,
      finished: false,
      time: null,
      resultChoice: null,
      color: 0,
      // Аккаунта нет — и это не упущение. Именно поэтому бот не попадает в таблицу рекордов:
      // правило «строка требует подтверждённой личности» уже написано и распространяется на него
      // само собой, без отдельной проверки на ботов.
      accountId: null,
      anonymousId: null,
      disconnectedAt: null,
      away: false,
      slot: room.players.size,
      joinOrder: joinOrder++,
      loadout: null,
      // Признак, по которому клиент рисует пометку. Игрок должен знать, с кем соревнуется.
      bot: true,
      ws: null,
      last: null,
      checkpoint: 0
    });
  }
  if (Number.isFinite(room.nextJoinOrder)) room.nextJoinOrder = joinOrder;
  placeBotsOnGrid(room);
  return added;
}

// Перезапуск ботов на новый забег. Вызывается там же, где начинается отсчёт, — реванш, повторный
// старт после смены настроек.
//
// Без этого реванш выглядел так: у людей забег начинался заново, а боты стояли на ленте с прошлого
// раза и «финишировали» в первую же миллисекунду — их время сбрасывает комната, а внутреннее
// состояние модели не сбрасывал никто.
function resetBots(room) {
  const bots = room?.bots;
  if (!bots || !runtime) return 0;

  // Сменилась трасса — прежняя геометрия боту не годится: он бежал бы по плитам, которых на новой
  // трассе нет. Пересобираем тем же составом и с теми же уровнями.
  if (bots.spec !== room.spec) {
    const skills = bots.list.map(entry => entry.bot.skill.id);
    const count = bots.list.length;
    clearBots(room);
    return spawnBots(room, { count, skill: skills });
  }

  bots.run += 1;
  bots.lastStepAt = null;
  bots.field.reset(bots.run);
  placeBotsOnGrid(room);
  for (const entry of bots.list) {
    const player = room.players.get(entry.id);
    if (!player) continue;
    Object.assign(player, {
      finished: false,
      time: null,
      last: null,
      checkpoint: 0,
      ready: true,
      resultChoice: null
    });
  }
  return bots.list.length;
}

// Шаг всех ботов комнаты. Вызывается из snapshot-цикла — того же, что рассылает состояние живым
// игрокам, поэтому бот двигается ровно с той частотой, с какой его видят.
//
// onFinish вызывается один раз на бота, дошедшего до ленты: рассылка сообщения о финише и проверка
// конца матча — дело сервера, а не этого модуля.
function stepBots(room, { now = Date.now(), onFinish = () => {} } = {}) {
  const bots = room?.bots;
  if (!bots || !runtime) return;
  // До старта бот стоит: отсчёт идёт и живым игрокам, и ему.
  if (now < room.startedAt) return;

  // Сколько шагов физики отработать. Цикл вызывается примерно раз в 66 мс, то есть на четыре шага
  // по 1/60. Считаем от прошлого вызова, а не берём константу: при перегрузке сервер прореживает
  // рассылку, и бот, шагающий фиксированное число раз, начал бы отставать от собственного времени.
  const previous = bots.lastStepAt || room.startedAt;
  const seconds = Math.min(0.5, Math.max(0, (now - previous) / 1000));
  bots.lastStepAt = now;
  const steps = Math.round(seconds / runtime.FIXED_DT);

  // Шагает ПОЛЕ, а не каждый бот по очереди: трасса у них общая, и часы у неё должны быть одни.
  // Иначе второй бот отматывал бы движущуюся плиту назад, к своему моменту времени, и эта отмотка
  // прилетала бы подхватом первому — тот съезжал бы с плиты сам собой.
  for (let step = 0; step < steps; step += 1) bots.field.step(runtime.FIXED_DT);

  for (const entry of bots.list) {
    const player = room.players.get(entry.id);
    if (!player || player.finished) continue;
    const snapshot = entry.bot.snapshot();
    player.last = { ...snapshot, id: entry.id };
    player.checkpoint = snapshot.checkpoint;
    if (entry.bot.finished) {
      player.finished = true;
      player.time = Math.max(0, now - room.startedAt);
      onFinish(player);
    }
  }
}

// Убрать ботов. Вызывается при роспуске комнаты и при возврате в лобби: бот живёт ровно один матч,
// как и его место в протоколе.
function clearBots(room) {
  const bots = room?.bots;
  if (!bots) return 0;
  for (const entry of bots.list) room.players.delete(entry.id);
  try {
    bots.field.dispose();
  } catch {
    // Освобождение графики не должно мешать закрыть комнату.
  }
  room.bots = null;
  return bots.list.length;
}

const isBot = player => !!player?.bot;

module.exports = {
  MAX_BOTS_PER_ROOM,
  preloadBots,
  botsReady,
  spawnBots,
  resetBots,
  stepBots,
  clearBots,
  placeBotsOnGrid,
  isBot
};