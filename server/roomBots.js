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
  loading = Promise.all([import('./raceBot.mjs'), import('../client/game/Course.js'), import('three')])
    .then(([bots, course, three]) => {
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

// Завести ботов в комнате. Возвращает, сколько их получилось: вызывающему не нужно знать, почему
// их меньше, чем он просил, — правила потолка живут здесь.
// skill принимает либо один уровень на всех, либо список — тогда уровни раздаются по кругу.
// Одинаковые боты бегут плотной группой и выглядят одним соперником, размноженным трижды.
function spawnBots(room, { count = 1, skill = 'steady' } = {}) {
  const skills = Array.isArray(skill) && skill.length ? skill : [skill];
  if (!runtime || !room || room.bots) return 0;
  const wanted = Math.max(0, Math.min(Math.floor(count), MAX_BOTS_PER_ROOM));
  if (!wanted) return 0;

  // Одна трасса на всю комнату. Отдельная копия каждому боту стоила бы около мегабайта: геометрия
  // у всех одна и та же, и держать её в одном экземпляре — не оптимизация, а очевидность. Общая
  // трасса означает и общие часы — их держит поле (BotField), а не каждый бот сам по себе.
  const course = new runtime.Course(new runtime.THREE.Scene(), room.spec, { quality: 'low' });
  const field = new runtime.BotField(course);
  const list = [];
  // Бот встаёт в очередь входа после всех, кто уже в комнате: по этому порядку раздаются слоты, и
  // сравнение с undefined давало бы в компараторе NaN — то есть «равно» для любой пары.
  let joinOrder = Number.isFinite(room.nextJoinOrder) ? room.nextJoinOrder : room.players.size;
  for (let index = 0; index < wanted; index += 1) {
    const bot = new runtime.RaceBot(course, {
      skill: skills[index % skills.length],
      seed: room.spec.seed,
      index
    });
    field.bots.push(bot);
    const id = `bot:${index}`;
    list.push({ id, bot });
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
  // spec запоминается, чтобы отличить реванш на той же трассе от смены настроек: во втором случае
  // геометрия под ботами уже не та, и переигрывать на ней нельзя.
  room.bots = { field, course, list, spec: room.spec, run: 0 };
  return list.length;
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
  isBot
};
