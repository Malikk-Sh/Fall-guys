// Разбор движения игрока по истории пакетов.
//
// Раньше сервер судил о движении по одному пакету за раз: скорость выше потолка, ускорение выше
// потолка. Такая проверка видит рывок и не видит систематики. Клиент, который бежит ровно на
// двадцати единицах вместо восьми, каждый отдельный пакет присылает безупречный — потолок
// наблюдаемой скорости был поднят до 22, потому что честный удар бампера выбивает и больше.
//
// Здесь появляются две вещи, которых по одному пакету не получить.
//
// ПЕРВОЕ — геометрия. Сервер знает план трассы (тип каждого сегмента), а из него — ширину опоры.
// Значит он знает, где пола нет вообще. Стоять там нельзя; лететь там можно, но только вниз.
//
// ВТОРОЕ — история. Средняя скорость за окно в две секунды переживает любой единичный удар и
// ловит именно систематику: у честного игрока она не поднималась выше 10.03 ни в одном из
// шестидесяти замерочных прогонов.
//
// Все пороги ниже — не догадки. Каждый получен прогоном ботов по настоящим трассам всех трёх
// сложностей (в том числе бота, который намеренно гуляет по краям и падает), выборкой раз в 66 мс,
// то есть ровно так, как эти пакеты видит сервер. Рядом с каждым порогом стоит замеренный максимум
// честной игры.

const {
  corridorZones,
  corridorHalfWidth,
  CORRIDOR_MARGIN,
  GROUND_Y_MIN,
  GROUND_Y_MAX,
  OBSTACLE_REACH_Y,
  SEGMENT_LENGTH,
  START
} = require('../shared/courseSpec.js');

// Потолки скорости по состоянию персонажа.
//
// Разделение по состояниям — главное, что здесь есть. Импульс препятствия не только задаёт
// скорость, но и ВЫТАЛКИВАЕТ игрока из его геометрии: молот сдвигает на 1.77 единицы разом, и
// наблюдаемая скорость за интервал в 66 мс подскакивает до 34 при честной игре. Но любой такой
// импульс снимает игрока с земли. Значит в состоянии «на земле» этих скачков не бывает — и там
// потолок можно опустить втрое.
//
// Замеренные максимумы честной игры (66 мс, 60 прогонов, 93 тысячи пакетов):
//   ground: заявленная 10.15, наблюдаемая 11.93
//   air:    заявленная 14.99, наблюдаемая 33.82
//   dive:   заявленная 17.34, наблюдаемая 27.36
const STATE_LIMITS = Object.freeze({
  // Бег ограничен RUN_SPEED = 7.7; сверху остаётся хвост затухания после удара, пока игрок уже
  // приземлился, но скорость ещё гасится.
  ground: { reported: 12, observed: 14 },
  air: { reported: 17, observed: 40 },
  // Рывок разгоняет до DIVE_SPEED = 10.8, и начаться он может сразу после удара вертушки.
  dive: { reported: 19, observed: 40 },
  // Удар сверху гасит горизонтальную скорость втрое, но начаться может на любой.
  slam: { reported: 17, observed: 40 },
  // После удара управление выключено, но импульс препятствия остаётся физически честным.
  knockdown: { reported: 24, observed: 45 },
  // Упавший в кооперативе не двигается сам — его переносят.
  downed: { reported: 12, observed: 40 }
});

// Окно истории и потолок средней скорости в нём. Честный максимум — 10.03.
const WINDOW_MS = 2000;
const WINDOW_MIN_SAMPLES = 20;
const MAX_SUSTAINED_SPEED = 13;

// Сколько игрок должен пробыть вне досягаемости препятствий, чтобы с него спросили за гравитацию.
// Полтора метра... полторы секунды: за это время самый сильный честный подброс (пружина, 11.4)
// успевает достичь вершины и уйти ниже точки отрыва. Замер: во всех 99 честных окнах такой длины
// игрок опускался, причём не меньше чем на 6.57.
const FREE_FALL_MS = 1500;

// Глубина буфера. Двух секунд окна при пакете раз в 66 мс хватает 30 записей; берём с запасом на
// случай, если клиент шлёт чаще положенного.
const HISTORY_LIMIT = 64;

// Минимальное время прохождения сегмента, по типу.
//
// Выведено из импульсов, а не из наблюдений: длина сегмента 18, поделённая на самую большую
// горизонтальную скорость, которую этот тип вообще способен придать. Вертушки бросают до 14 —
// значит на них теоретический предел 1.29 с. Там, где вертушек нет, потолок скорости задаёт рывок
// (10.8) — предел 1.67 с. Отсюда взяты пороги с запасом в четверть.
//
// Замеренный минимум честного прохождения — 1.90 с (сегмент «молоты»), то есть запас к порогу не
// меньше 50 %. Прежнее значение было общим для всех типов и равнялось 0.3 с: при длине сегмента 18
// это разрешало скорость 60 единиц в секунду, вшестеро выше беговой.
const MIN_SEGMENT_SECONDS = Object.freeze({
  sweepers: 1,
  bridge: 1,
  crosswind: 1,
  bumpers: 1.25,
  punchers: 1.25,
  movers: 1.25,
  bounce: 1.25
});
const DEFAULT_MIN_SEGMENT_SECONDS = 1.25;

// Финишный выкат короче сегмента: от последнего чекпоинта до ленты 13 единиц.
const FINISH_TAIL_SECONDS = 0.7;

// Запас отклонений на признак. Признаки делятся на два сорта, и запасы у них разные.
//
// Физически невозможное (стоять там, где нет пола; стоять на высоте, где нет опор; подниматься
// там, где ничто не толкает) не случается у честного игрока НИ РАЗУ — во всех замерах ровно ноль.
// Такому признаку хватает малого запаса: он нужен только на случай потерянного или переставленного
// пакета.
//
// Скоростное же бывает пограничным: удар на границе интервала, платформа под ногами, потеря связи.
// Там запас прежний.
const ANOMALY_BUDGET = Object.freeze({
  'off-platform': 3,
  'ground-height': 3,
  'sustained-speed': 3,
  flight: 2,
  // Ускорение — самый шумный признак из всех, и запас у него втрое больше прочих.
  //
  // Считается оно как |Δv| между соседними пакетами, делённое на промежуток между ними. Промежуток
  // выбирает клиент: обычно 66 мс, но сервер принимает и 32, а импульс препятствия меняет скорость
  // сразу на всю величину отброса. Одно и то же честное попадание в бампер даёт 150 при редких
  // пакетах и 500 при частых — то есть признак меряет не столько движение, сколько сеть.
  //
  // Замер живым браузером: честный забег набирает от 4 до 10 отклонений. При прежнем запасе 15 это
  // полтора зазора, и браузерный тест срывался примерно на каждом пятом прогоне — честный результат
  // не попадал в таблицу рекордов. Тридцать даёт трёхкратный зазор; клиент, подделывающий ускорение
  // на каждом пакете, исчерпает его за две секунды.
  'horizontal-acceleration': 30
});
const DEFAULT_ANOMALY_BUDGET = 15;

function budgetFor(reason) {
  return Object.hasOwn(ANOMALY_BUDGET, reason) ? ANOMALY_BUDGET[reason] : DEFAULT_ANOMALY_BUDGET;
}

// Зоны трассы считаются один раз на спеку и кешируются на ней же: они зависят только от плана.
function zonesFor(spec) {
  if (!spec?.segments?.length) return null;
  if (!spec.__corridorZones) {
    Object.defineProperty(spec, '__corridorZones', {
      value: corridorZones(spec),
      enumerable: false
    });
  }
  return spec.__corridorZones;
}

// Досягаемость препятствий: внутри коридора и не выше бампера. Всё, что снаружи, летит по одной
// гравитации — толкать там нечему.
function outOfReach(zones, state) {
  if (state.y > OBSTACLE_REACH_Y) return true;
  return Math.abs(state.x) > corridorHalfWidth(zones, state.z) + CORRIDOR_MARGIN;
}

function resetHistory(player) {
  player.movementHistory = [];
  player.freeFallSince = null;
}

// Разбор одного принятого состояния. Возвращает список признаков, у которых кончился запас.
//
// Функция вызывается только на состояниях, ПРОШЕДШИХ жёсткую проверку validateState: телепорт
// сюда не доходит. Здесь ищется то, что по одному пакету законно, а в совокупности — нет.
function auditMovement(player, state, spec, now, dtSeconds) {
  const findings = [];
  const anomalies = player.movementAnomalies || (player.movementAnomalies = {});
  const note = reason => {
    anomalies[reason] = (anomalies[reason] || 0) + 1;
    if (anomalies[reason] > budgetFor(reason)) findings.push(reason);
  };

  const limits = STATE_LIMITS[state.state] || STATE_LIMITS.air;
  const reported = Math.hypot(state.vx, state.vz);
  const observed = player.last ? Math.hypot(state.x - player.last.x, state.z - player.last.z) / dtSeconds : 0;
  if (reported > limits.reported) note('reported-speed');
  if (observed > limits.observed) note('observed-speed');

  const history = player.movementHistory || (player.movementHistory = []);
  // Вместе с точкой запоминается и НАЧАЛО того промежутка, за который посчитана `speed`. Без него
  // две меры окна считались бы по разным границам: среднее покрывает N промежутков, а смещение по
  // самим точкам — только N−1. Лишний промежуток в среднем — это ровно один удар, который может
  // поднять его и на совершенно прямой траектории, то есть подделать тот самый признак, ради
  // измерения которого замер и сделан.
  history.push({
    at: now,
    x: state.x,
    y: state.y,
    z: state.z,
    speed: observed,
    // Сама длина промежутка, а не только скорость: по скорости её не восстановить, потому что
    // делитель `dtSeconds` снизу подрезан сорока миллисекундами.
    dist: player.last ? Math.hypot(state.x - player.last.x, state.z - player.last.z) : 0,
    fromAt: player.lastAt ?? now,
    fromX: player.last?.x ?? state.x,
    fromZ: player.last?.z ?? state.z
  });
  while (history.length > HISTORY_LIMIT) history.shift();
  while (history.length > 1 && now - history[0].at > WINDOW_MS) history.shift();

  // Средняя скорость за окно. Один удар её не поднимает, а систематическая подделка — поднимает.
  if (history.length >= WINDOW_MIN_SAMPLES && now - history[0].at >= WINDOW_MS * 0.75) {
    const average = history.reduce((sum, item) => sum + item.speed, 0) / history.length;
    if (average > MAX_SUSTAINED_SPEED) note('sustained-speed');

    // Рядом, на том же окне, считаются ещё две меры той же величины. Решения они НЕ принимают и
    // принимать не должны: это замер.
    //
    // Зачем он. На проде `sustained-speed` срабатывает у честных игроков по шесть раз за забег при
    // запасе три, и пять таких забегов из шести теряют зачёт. Воспроизвести это ботом не удаётся
    // ни при какой частоте пакетов (0…400 мс), ни при петлянии, ни на chaos: у бота ноль.
    // Значит причина в том, чего бот не делает, и какая именно — неизвестно.
    //
    // Мер три, потому что решающая величина может завышать по ДВУМ независимым причинам, и по
    // одной паре их не различить:
    //
    //   average — среднее по пакетам БЕЗ веса. Ровно оно принимает решение. Завышается и от
    //             кривизны пути, и от неравных промежутков: короткий быстрый промежуток входит в
    //             него с тем же весом, что и длинный медленный. На прямой при 33 и 132 мс это
    //             даёт 12.5 против настоящих 8.0.
    //   path    — длина пути за то же окно, делённая на реально прошедшее время. Вес по времени,
    //             кривизна учтена. Разница с `average` — это ровно цена отсутствия веса.
    //   net     — прямая между концами окна за то же время. Разница с `path` — ровно кривизна.
    //
    // Отсюда и читается ответ: `average` заметно выше `path` — виновата формула, и виновата
    // неравномерностью пакетов; `path` заметно выше `net` — игрок вилял; обе близки к `average` —
    // он и правда ехал быстро, и разговор про порог. Кооператив свою меру считает как `net`
    // (см. coopMovementAudit.js), и это сделано намеренно.
    //
    // Пик берётся по среднему — это та величина, которая принимает решение, — а остальные
    // запоминаются те, что были в ТОТ ЖЕ момент, иначе пары не получится.
    //
    // Границы у всех трёх совпадают: знаменатель один, и отсчитывается он от НАЧАЛА первого
    // промежутка, а не от первой точки, — среднее включает промежуток, который в неё привёл.
    const first = history[0];
    const last = history.at(-1);
    const spanSeconds = Math.max(0.001, (last.at - first.fromAt) / 1000);
    let pathLength = 0;
    for (const item of history) pathLength += item.dist;
    const path = pathLength / spanSeconds;
    const net = Math.hypot(last.x - first.fromX, last.z - first.fromZ) / spanSeconds;
    const peak = player.sustainedSpeedPeak;
    if (!peak || average > peak.average) {
      player.sustainedSpeedPeak = { average, path, net, state: state.state };
    }
  }

  const zones = zonesFor(spec);
  if (zones) {
    const half = corridorHalfWidth(zones, state.z);
    if (state.state === 'ground') {
      // Стоять можно только там, где есть опора: и по ширине, и по высоте.
      if (Math.abs(state.x) > half + CORRIDOR_MARGIN) note('off-platform');
      if (state.y < GROUND_Y_MIN || state.y > GROUND_Y_MAX) note('ground-height');
    }

    // Вне досягаемости препятствий работает только гравитация: за полторы секунды игрок обязан
    // оказаться ниже, чем был. Этим ловится и полёт над трассой, и обход трассы сбоку — оба
    // сценария по отдельным пакетам выглядят безупречно.
    if (outOfReach(zones, state)) {
      if (!player.freeFallSince) player.freeFallSince = { at: now, y: state.y };
      else if (now - player.freeFallSince.at >= FREE_FALL_MS) {
        if (state.y >= player.freeFallSince.y) note('flight');
        // Окно сдвигается, иначе один затяжной полёт дал бы признак на каждом пакете подряд.
        player.freeFallSince = { at: now, y: state.y };
      }
    } else player.freeFallSince = null;
  }

  return findings;
}

// Сколько секунд по правилам занимает участок, оканчивающийся чекпоинтом с номером checkpoint.
// Первый участок длиннее прочих: от старта до первой арки 25 единиц вместо 18.
function minSegmentSeconds(spec, checkpoint) {
  const index = checkpoint - 1;
  if (index < 0 || !spec?.segments?.length) return DEFAULT_MIN_SEGMENT_SECONDS;
  const type = spec.segments[index]?.type;
  const base = Object.hasOwn(MIN_SEGMENT_SECONDS, type)
    ? MIN_SEGMENT_SECONDS[type]
    : DEFAULT_MIN_SEGMENT_SECONDS;
  if (index > 0) return base;
  const distance = START.z - spec.checkpoints[0];
  return (base * distance) / SEGMENT_LENGTH;
}

module.exports = {
  auditMovement,
  resetHistory,
  minSegmentSeconds,
  budgetFor,
  outOfReach,
  zonesFor,
  STATE_LIMITS,
  MAX_SUSTAINED_SPEED,
  MIN_SEGMENT_SECONDS,
  FINISH_TAIL_SECONDS,
  FREE_FALL_MS,
  DEFAULT_ANOMALY_BUDGET
};
